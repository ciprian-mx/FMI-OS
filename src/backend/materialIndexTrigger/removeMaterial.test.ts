import fc from 'fast-check';
import { createHarness, encodeS3EventKey, s3Event, T0 } from './__tests__/fakes';
import { handleS3Event, type S3EventLike } from './indexMaterial';
import type { MaterialFileRecord } from './ports';

/**
 * Task 4.1 — materialIndexTrigger deletion propagation (Requirement 7.8).
 *
 * An `s3:ObjectRemoved:*` event for a Materials document (a delete, or the old
 * key of a move / rename) removes the document from the Knowledge Base with
 * `DeleteKnowledgeBaseDocuments`, deletes its `<key>.metadata.json` sidecar,
 * waits up to 10 s for Bedrock to confirm, and falls back to a data-source
 * sync when the direct path cannot guarantee the removal. Removal events for
 * sidecars are ignored. All ports are in-memory fakes.
 *
 * Validates: Requirements 7.8
 */

type Harness = ReturnType<typeof createHarness>;

const BUCKET = 'fmios-materials-storage-dev';
const IDENTITY = 'eu-central-1:7d3c1f3e-1111-4222-8333-444455556666';
const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const KEY = `private/${IDENTITY}/materials/Data Structures/Week 3/Sorting.pdf`;
const SIDECAR = `${KEY}.metadata.json`;
const S3_URI = `s3://${BUCKET}/${KEY}`;

function removal(key = KEY, eventName = 'ObjectRemoved:Delete', eventTime?: string): S3EventLike {
  return s3Event(key, { bucket: BUCKET, eventName, eventTime });
}

/** A harness whose Knowledge Base deletes immediately and then reports the document gone. */
function deletingHarness(): Harness {
  const h = createHarness();
  h.objects.addObject(BUCKET, SIDECAR);
  h.knowledgeBase.documentStatus = 'NOT_FOUND';
  return h;
}

describe('materialIndexTrigger — removing a deleted material', () => {
  it('deletes the document directly, then its sidecar, and confirms within the window', async () => {
    const h = deletingHarness();

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes).toEqual([
      {
        kind: 'removed',
        key: KEY,
        knowledgeBase: 'deleted',
        detail: null,
        confirmedAfterMs: 1_000,
        sidecarDeleted: true,
        sync: { status: 'not-needed' },
      },
    ]);
    // Removal check, direct delete, sidecar, one confirmation poll, running-sync check.
    expect(h.trace).toEqual([
      `s3.head ${KEY}`,
      `kb.delete ${S3_URI}`,
      `s3.delete ${SIDECAR}`,
      `kb.doc ${S3_URI}`,
      'kb.list',
    ]);
    expect(h.objects.objects.has(`${BUCKET}/${SIDECAR}`)).toBe(false);
    // No sync is started and no MaterialFile row is touched.
    expect(h.knowledgeBase.startedJobIds).toEqual([]);
    expect(h.materialFiles.statusWrites).toEqual([]);
  });

  it('handles DeleteMarkerCreated (versioned bucket) like a delete', async () => {
    const h = deletingHarness();

    const result = await handleS3Event(removal(KEY, 'ObjectRemoved:DeleteMarkerCreated'), h.deps);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({ kind: 'removed', knowledgeBase: 'deleted' }));
  });

  it('keeps polling while Bedrock reports the deletion in progress', async () => {
    const h = deletingHarness();
    h.knowledgeBase.documentStatusScript = ['DELETING', 'DELETE_IN_PROGRESS'];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ knowledgeBase: 'deleted', confirmedAfterMs: 3_000 })
    );
    expect(h.trace.filter((entry) => entry === `kb.doc ${S3_URI}`)).toHaveLength(3);
  });

  it('logs the latency since the S3 event for the 10 s target', async () => {
    const h = deletingHarness();

    await handleS3Event(removal(KEY, 'ObjectRemoved:Delete', new Date(T0 - 500).toISOString()), h.deps);

    const finished = h.logger.entries.find((entry) => entry.message === 'Material removal finished');
    expect(finished?.fields).toEqual(
      expect.objectContaining({ key: KEY, confirmedAfterMs: 1_000, sinceRemovalMs: 1_500 })
    );
  });

  it('retries a throttled deletion with backoff', async () => {
    const h = deletingHarness();
    h.knowledgeBase.deleteScript = [
      { outcome: 'busy', reason: 'ThrottlingException' },
      { outcome: 'busy', reason: 'ServiceQuotaExceededException' },
    ];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({ knowledgeBase: 'deleted' }));
    expect(h.trace.filter((entry) => entry === `kb.delete ${S3_URI}`)).toHaveLength(3);
    expect(h.clock.sleeps).toEqual([500, 1_000, 1_000]);
  });

  it('reports a document the Knowledge Base never had as not-indexed, without polling', async () => {
    const h = deletingHarness();
    h.knowledgeBase.deleteScript = [{ outcome: 'not-found', reason: 'ResourceNotFoundException' }];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'not-indexed',
        detail: 'ResourceNotFoundException',
        sidecarDeleted: true,
        sync: { status: 'not-needed' },
      })
    );
    expect(h.trace).not.toContain(`kb.doc ${S3_URI}`);
  });

  it('treats an accepted deletion that reports NOT_FOUND as not-indexed', async () => {
    const h = deletingHarness();
    h.knowledgeBase.deleteScript = [{ outcome: 'accepted', status: 'NOT_FOUND' }];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ knowledgeBase: 'not-indexed', detail: 'NOT_FOUND' })
    );
  });

  it('still removes the document when the sidecar cannot be deleted', async () => {
    const h = deletingHarness();
    h.objects.deleteError = new Error('AccessDenied');

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ knowledgeBase: 'deleted', sidecarDeleted: false })
    );
    expect(h.logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('materialIndexTrigger — removal falls back to a data-source sync', () => {
  it('starts a sync when Bedrock rejects the direct deletion', async () => {
    const h = deletingHarness();
    h.knowledgeBase.deleteScript = [{ outcome: 'rejected', reason: 'ValidationException: not supported' }];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'delete-rejected',
        detail: 'ValidationException: not supported',
        sidecarDeleted: true,
        sync: { status: 'started', reason: 'direct-delete-not-applied', ingestionJobId: 'job-1' },
      })
    );
    // The sync starts only after the sidecar is gone; nobody waits for it.
    expect(h.trace.indexOf('kb.start')).toBeGreaterThan(h.trace.indexOf(`s3.delete ${SIDECAR}`));
    expect(h.trace).not.toContain('kb.get job-1');
  });

  it('starts a sync when the deletion stays throttled through every retry', async () => {
    const h = deletingHarness();
    h.knowledgeBase.fallbackDelete = { outcome: 'busy', reason: 'ThrottlingException' };

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'delete-rejected',
        detail: 'ThrottlingException',
        sync: expect.objectContaining({ status: 'started', reason: 'direct-delete-not-applied' }),
      })
    );
    expect(h.trace.filter((entry) => entry === `kb.delete ${S3_URI}`)).toHaveLength(5);
    expect(h.clock.sleeps).toEqual([500, 1_000, 2_000, 4_000]);
  });

  it('starts a sync when the deletion call fails unexpectedly', async () => {
    const h = deletingHarness();
    h.knowledgeBase.deleteScript = [new Error('AccessDeniedException: not authorized')];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'delete-rejected',
        detail: 'error:AccessDeniedException: not authorized',
        sync: expect.objectContaining({ status: 'started' }),
      })
    );
  });

  it('starts a sync when Bedrock does not confirm the deletion within 10 s', async () => {
    const h = deletingHarness();
    h.knowledgeBase.documentStatus = 'DELETE_IN_PROGRESS';

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'delete-pending',
        detail: 'DELETE_IN_PROGRESS',
        confirmedAfterMs: null,
        sync: { status: 'started', reason: 'deletion-unconfirmed', ingestionJobId: 'job-1' },
      })
    );
    expect(h.trace.filter((entry) => entry === `kb.doc ${S3_URI}`)).toHaveLength(10);
    expect(h.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('treats a failing confirmation poll as unconfirmed', async () => {
    const h = deletingHarness();
    h.knowledgeBase.documentStatus = new Error('ThrottlingException');

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'delete-pending',
        detail: 'DELETING',
        sync: expect.objectContaining({ status: 'started', reason: 'deletion-unconfirmed' }),
      })
    );
  });

  it('waits for a sync that predates the removal and starts a fresh one after it', async () => {
    const h = deletingHarness();
    // e.g. the sync of this very upload, still running when the student deleted it.
    h.knowledgeBase.activeJobs = [
      { ingestionJobId: 'job-upload', status: 'IN_PROGRESS', startedAtMs: T0 - 30_000, failureReasons: [] },
    ];
    h.knowledgeBase.startScript = ['busy', 'start'];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'deleted',
        sync: { status: 'started', reason: 'sync-in-flight', ingestionJobId: 'job-1' },
      })
    );
    expect(h.clock.sleeps).toEqual([1_000, 5_000]);
  });

  it('joins a sync that started after the removal instead of starting another', async () => {
    const h = deletingHarness();
    h.knowledgeBase.activeJobs = [
      { ingestionJobId: 'job-upload', status: 'IN_PROGRESS', startedAtMs: T0 - 30_000, failureReasons: [] },
      { ingestionJobId: 'job-later', status: 'STARTING', startedAtMs: T0 + 5_000, failureReasons: [] },
    ];
    h.knowledgeBase.startScript = ['busy'];

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        sync: { status: 'joined', reason: 'sync-in-flight', ingestionJobId: 'job-later' },
      })
    );
    expect(h.knowledgeBase.startedJobIds).toEqual([]);
  });

  it('starts a sync when the running syncs cannot be listed', async () => {
    const h = deletingHarness();
    h.knowledgeBase.listError = new Error('ThrottlingException');

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'deleted',
        sync: { status: 'started', reason: 'running-syncs-unknown', ingestionJobId: 'job-1' },
      })
    );
  });

  it('reports a follow-up sync that could not start within the time budget', async () => {
    const h = deletingHarness();
    h.knowledgeBase.deleteScript = [{ outcome: 'rejected', reason: 'ValidationException' }];
    h.knowledgeBase.fallbackStart = 'busy';

    const result = await handleS3Event(removal(), h.deps, { getRemainingTimeInMillis: () => 90_000 });

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        knowledgeBase: 'delete-rejected',
        sync: { status: 'not-started', reason: 'direct-delete-not-applied', detail: 'ConflictException' },
      })
    );
    expect(h.clock.now()).toBeLessThanOrEqual(T0 + 90_000);
  });
});

describe('materialIndexTrigger — removal events that remove nothing', () => {
  it('skips a stale event when the key holds an object again', async () => {
    const h = deletingHarness();
    h.objects.addObject(BUCKET, KEY, { studentid: STUDENT });

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes).toEqual([{ kind: 'removal-skipped', key: KEY, reason: 'object-exists' }]);
    expect(h.trace).toEqual([`s3.head ${KEY}`]);
    expect(h.objects.objects.has(`${BUCKET}/${SIDECAR}`)).toBe(true);
  });

  it.each<[string, string, string]>([
    ['a metadata sidecar (our own cleanup)', SIDECAR, 'metadata-sidecar'],
    ['a folder marker', `private/${IDENTITY}/materials/Week 3/`, 'folder-marker'],
    ['an object outside materials/', `private/${IDENTITY}/timetables/week.png`, 'outside-materials'],
  ])('ignores the removal of %s without touching S3 or Bedrock', async (_label, key, reason) => {
    const h = deletingHarness();

    const result = await handleS3Event(removal(key), h.deps);

    expect(result.outcomes).toEqual([expect.objectContaining({ kind: 'ignored', reason })]);
    expect(h.trace).toEqual([]);
  });

  it('reports an error and removes nothing when the object cannot be checked', async () => {
    const h = deletingHarness();
    h.objects.headError = new Error('AccessDenied');

    const result = await handleS3Event(removal(), h.deps);

    expect(result.outcomes).toEqual([{ kind: 'error', key: KEY, message: 'AccessDenied' }]);
    expect(h.trace).toEqual([`s3.head ${KEY}`]);
  });

  it('processes a removal and an upload in the same event independently', async () => {
    const h = deletingHarness();
    const uploadedKey = `private/${IDENTITY}/materials/Algorithms/Graphs.pdf`;
    h.objects.addObject(BUCKET, uploadedKey, { studentid: STUDENT });
    h.knowledgeBase.documentStatus = 'NOT_FOUND';
    const record: MaterialFileRecord = {
      id: 'file-2',
      studentId: STUDENT,
      s3Key: uploadedKey,
      owner: `${STUDENT}::student@s.unibuc.ro`,
      indexingStatus: 'PENDING',
    };
    h.materialFiles.add(record);
    const event: S3EventLike = {
      Records: [
        ...(s3Event(uploadedKey, { bucket: BUCKET }).Records ?? []),
        ...(removal().Records ?? []),
      ],
    };

    const result = await handleS3Event(event, h.deps);

    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['completed', 'removed']);
  });
});

describe('materialIndexTrigger — a moved file stops getting the old run’s status', () => {
  it('does not write the old key’s verdict onto a record that now points at a new key', async () => {
    const h = createHarness();
    const oldKey = KEY;
    const newKey = `private/${IDENTITY}/materials/Algorithms/Sorting.pdf`;
    h.objects.addObject(BUCKET, oldKey, { studentid: STUDENT });
    h.materialFiles.add({
      id: 'file-1',
      studentId: STUDENT,
      s3Key: oldKey,
      owner: `${STUDENT}::student@s.unibuc.ro`,
      indexingStatus: 'PENDING',
    });
    // The Materials app moves the file while the old key's sync is running.
    h.knowledgeBase.onPoll = () => {
      const moved = h.materialFiles.records.get('file-1');
      if (moved) {
        moved.s3Key = newKey;
      }
    };

    const result = await handleS3Event(s3Event(oldKey, { bucket: BUCKET }), h.deps);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({ kind: 'completed', recordIds: [] }));
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING']);
  });
});

/* ------------------------------------------------------------------ *
 * Property: removals target exactly the removed document.            *
 * ------------------------------------------------------------------ */

const NAME_CHARS = 'abcXYZ019 +%:&=?#()[]!~_-.'.split('').concat(['ă', 'ș', 'ț', 'é', '中']);
const nameArb = fc.stringOf(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 12 });
const fileNameArb = fc
  .tuple(nameArb, fc.constantFrom('pdf', 'pptx', 'txt', 'md', 'docx', 'xlsx', 'png', 'jpg'))
  .map(([base, extension]) => `${base}.${extension}`);
const ownerArb = fc.oneof(
  fc.uuid().map((id) => `private/eu-central-1:${id}`),
  fc.uuid().map((id) => `students/${id}`)
);
const materialKeyArb = fc
  .tuple(ownerArb, fc.array(nameArb, { maxLength: 5 }), fileNameArb)
  .map(([owner, folders, fileName]) => [owner, 'materials', ...folders, fileName].join('/'));

describe('materialIndexTrigger — removal targets (property)', () => {
  it('deletes exactly the removed document and its sidecar, for any Materials key', async () => {
    await fc.assert(
      fc.asyncProperty(
        materialKeyArb,
        fc.constantFrom('ObjectRemoved:Delete', 'ObjectRemoved:DeleteMarkerCreated'),
        async (key, eventName) => {
          const h = createHarness();
          h.knowledgeBase.documentStatus = 'NOT_FOUND';

          const result = await handleS3Event(
            { Records: [{ eventName, s3: { bucket: { name: BUCKET }, object: { key: encodeS3EventKey(key) } } }] },
            h.deps
          );

          expect(result.outcomes).toEqual([expect.objectContaining({ kind: 'removed', key })]);
          expect(h.objects.deletes).toEqual([{ bucket: BUCKET, key: `${key}.metadata.json` }]);
          expect(h.trace.filter((entry) => entry.startsWith('kb.delete '))).toEqual([
            `kb.delete s3://${BUCKET}/${key}`,
          ]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never touches S3 or Bedrock for the removal of a sidecar', async () => {
    await fc.assert(
      fc.asyncProperty(materialKeyArb, async (key) => {
        const h = createHarness();

        const result = await handleS3Event(removal(`${key}.metadata.json`), h.deps);

        expect(result.outcomes).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'metadata-sidecar' })]);
        expect(h.trace).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });
});
