import { createHarness, s3Event, T0 } from './__tests__/fakes';
import { handleS3Event, type S3EventLike, type SkipReason } from './indexMaterial';
import type { MaterialFileRecord } from './ports';

/**
 * Task 4.6 — materialIndexTrigger orchestration with mocked ports: metadata
 * tagging, the PENDING → INDEXING → INDEXED / FAILED transitions, and which
 * objects are (not) indexed.
 *
 * Validates: Requirements 7.6
 */

type Harness = ReturnType<typeof createHarness>;

const BUCKET = 'fmios-materials-storage-dev';
const IDENTITY = 'eu-central-1:7d3c1f3e-1111-4222-8333-444455556666';
const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const KEY = `private/${IDENTITY}/materials/Data Structures/Week 3/Sorting.pdf`;
const SIDECAR = `${KEY}.metadata.json`;
const S3_URI = `s3://${BUCKET}/${KEY}`;

function record(overrides: Partial<MaterialFileRecord> = {}): MaterialFileRecord {
  return {
    id: 'file-1',
    studentId: STUDENT,
    s3Key: KEY,
    owner: `${STUDENT}::student@s.unibuc.ro`,
    indexingStatus: 'PENDING',
    ...overrides,
  };
}

/** The object as the upload helper (task 4.5) leaves it: S3 lower-cases metadata keys. */
function uploaded(harness: Harness, key = KEY, metadata?: Record<string, string>): void {
  harness.objects.addObject(
    BUCKET,
    key,
    metadata ?? { studentid: STUDENT, folderpath: 'Data Structures/Week 3' }
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe('materialIndexTrigger — indexing an uploaded material', () => {
  it('tags the document, syncs the Knowledge Base and moves PENDING → INDEXING → INDEXED', async () => {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record());

    // s3Event() URL-encodes the key the way S3 notifications do ("+", "%3A").
    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes).toEqual([
      {
        kind: 'completed',
        key: KEY,
        studentId: STUDENT,
        status: 'INDEXED',
        reason: 'document-indexed',
        ingestionJobId: 'job-1',
        recordIds: ['file-1'],
      },
    ]);
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING', 'INDEXED']);
    expect(h.materialFiles.records.get('file-1')?.indexingStatus).toBe('INDEXED');
    expect(h.materialFiles.statusWrites.map((write) => write.updatedAt)).toEqual([
      iso(T0),
      iso(T0 + 20_000),
    ]);

    // {studentId, folderPath} (+ fileName) metadata tags next to the document.
    expect(h.objects.puts).toEqual([
      { bucket: BUCKET, key: SIDECAR, body: expect.any(String), contentType: 'application/json' },
    ]);
    expect(JSON.parse(h.objects.puts[0].body)).toEqual({
      metadataAttributes: {
        studentId: STUDENT,
        folderPath: 'Data Structures/Week 3',
        fileName: 'Sorting.pdf',
      },
    });

    // Tag before syncing; INDEXING only once the sync runs; INDEXED after it.
    expect(h.trace).toEqual([
      `s3.head ${KEY}`,
      'db.find',
      `s3.put ${SIDECAR}`,
      'kb.start',
      'db.update file-1 INDEXING',
      'kb.get job-1',
      'kb.get job-1',
      `kb.doc ${S3_URI}`,
      'db.find',
      'db.update file-1 INDEXED',
    ]);
  });

  it('supports the students/{userId}/materials layout, taking studentId from the key', async () => {
    const h = createHarness();
    const key = `students/${STUDENT}/materials/Algebra/notes.md`;
    uploaded(h, key, {});
    h.materialFiles.add(record({ s3Key: key }));

    const result = await handleS3Event(s3Event(key), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ kind: 'completed', status: 'INDEXED', studentId: STUDENT })
    );
    expect(JSON.parse(h.objects.puts[0].body).metadataAttributes).toEqual({
      studentId: STUDENT,
      folderPath: 'Algebra',
      fileName: 'notes.md',
    });
  });

  it('waits for the MaterialFile record the upload creates right after the object', async () => {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record(), { visibleAfterLookups: 3 });

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({ status: 'INDEXED' }));
    expect(h.clock.sleeps.slice(0, 2)).toEqual([1_000, 2_000]);
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING', 'INDEXED']);
  });

  it('also updates records created for the same key while the sync was running', async () => {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record());
    h.materialFiles.add(record({ id: 'file-2' }), { visibleAfterLookups: 2 });

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({ recordIds: ['file-1', 'file-2'] }));
    expect(h.materialFiles.history('file-2')).toEqual(['INDEXED']);
  });

  it('processes every record of an event independently', async () => {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record());
    const event: S3EventLike = {
      Records: [...(s3Event(SIDECAR).Records ?? []), ...(s3Event(KEY).Records ?? [])],
    };

    const result = await handleS3Event(event, h.deps);

    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['ignored', 'completed']);
  });
});

describe('materialIndexTrigger — FAILED transitions', () => {
  function readyHarness(): Harness {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record());
    return h;
  }

  it('marks FAILED when the Knowledge Base sync fails', async () => {
    const h = readyHarness();
    h.knowledgeBase.pollStatuses = ['IN_PROGRESS', 'FAILED'];

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ status: 'FAILED', reason: 'ingestion-job-failed', ingestionJobId: 'job-1' })
    );
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING', 'FAILED']);
  });

  it('marks FAILED when the sync completes but this document was not indexed', async () => {
    const h = readyHarness();
    h.knowledgeBase.documentStatus = 'IGNORED';

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ status: 'FAILED', reason: 'document-ignored' })
    );
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING', 'FAILED']);
  });

  it('marks FAILED when an unexpected error interrupts indexing', async () => {
    const h = readyHarness();
    h.knowledgeBase.startScript = [new Error('AccessDeniedException: not authorized')];

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ status: 'FAILED', reason: expect.stringMatching(/^error:/), ingestionJobId: null })
    );
    expect(h.materialFiles.history('file-1')).toEqual(['FAILED']);
    expect(h.logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('marks FAILED when no sync can be started within the time budget', async () => {
    const h = readyHarness();
    h.knowledgeBase.fallbackStart = 'busy';

    const result = await handleS3Event(s3Event(KEY), h.deps, {
      getRemainingTimeInMillis: () => 90_000,
    });

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ status: 'FAILED', reason: 'ingestion-not-started:ConflictException' })
    );
    expect(h.materialFiles.history('file-1')).toEqual(['FAILED']);
    expect(h.clock.now()).toBeLessThanOrEqual(T0 + 90_000);
  });

  it('marks FAILED when the sync does not finish within the time budget', async () => {
    const h = readyHarness();
    h.knowledgeBase.pollStatuses = ['IN_PROGRESS'];

    const result = await handleS3Event(s3Event(KEY), h.deps, {
      getRemainingTimeInMillis: () => 120_000,
    });

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ status: 'FAILED', reason: 'ingestion-timeout' })
    );
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING', 'FAILED']);
  });

  it('reports an error and writes no status when the object metadata cannot be read', async () => {
    const h = readyHarness();
    h.objects.headError = new Error('AccessDenied');

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes).toEqual([{ kind: 'error', key: KEY, message: 'AccessDenied' }]);
    expect(h.materialFiles.statusWrites).toEqual([]);
  });
});

describe('materialIndexTrigger — concurrent uploads', () => {
  it('joins a sync that started after the document was ready instead of queueing another', async () => {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record());
    h.knowledgeBase.startScript = ['busy'];
    h.knowledgeBase.activeJobs = [
      { ingestionJobId: 'job-running', status: 'IN_PROGRESS', startedAtMs: T0 + 5_000, failureReasons: [] },
    ];

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ status: 'INDEXED', ingestionJobId: 'job-running' })
    );
    expect(h.trace.filter((entry) => entry === 'kb.start')).toHaveLength(1);
    expect(h.trace).toContain('kb.get job-running');
  });

  it('does not join an older sync and retries the start with backoff while busy', async () => {
    const h = createHarness();
    uploaded(h);
    h.materialFiles.add(record());
    h.knowledgeBase.startScript = ['busy', 'busy', 'start'];
    h.knowledgeBase.activeJobs = [
      { ingestionJobId: 'job-old', status: 'IN_PROGRESS', startedAtMs: T0 - 60_000, failureReasons: [] },
    ];

    const result = await handleS3Event(s3Event(KEY), h.deps);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({ status: 'INDEXED', ingestionJobId: 'job-1' }));
    expect(h.clock.sleeps.slice(0, 2)).toEqual([5_000, 10_000]);
    expect(h.trace).not.toContain('kb.get job-old');
    expect(h.materialFiles.history('file-1')).toEqual(['INDEXING', 'INDEXED']);
  });
});

describe('materialIndexTrigger — objects that are not indexed', () => {
  it.each<[string, S3EventLike, string]>([
    ['its own metadata sidecar', s3Event(SIDECAR), 'metadata-sidecar'],
    ['a folder marker', s3Event(`private/${IDENTITY}/materials/Week 3/`), 'folder-marker'],
    ['an upload outside materials/', s3Event(`private/${IDENTITY}/timetables/week.png`), 'outside-materials'],
    ['a deletion event', s3Event(KEY, { eventName: 'ObjectRemoved:Delete' }), 'unsupported-event'],
    [
      'a record without a key',
      { Records: [{ eventName: 'ObjectCreated:Put', s3: { bucket: { name: BUCKET } } }] },
      'malformed-record',
    ],
  ])('ignores %s without touching S3, DynamoDB or Bedrock', async (_label, event, reason) => {
    const h = createHarness();

    const result = await handleS3Event(event, h.deps);

    expect(result.outcomes).toEqual([expect.objectContaining({ kind: 'ignored', reason })]);
    expect(h.trace).toEqual([]);
  });

  const VICTIM = '99999999-aaaa-4bbb-8ccc-ddddeeeeffff';

  it.each<[string, string, (h: Harness, key: string) => void, SkipReason]>([
    ['the object is gone', KEY, () => undefined, 'object-missing'],
    [
      'a private/ object has no studentId metadata',
      KEY,
      (h, key) => {
        uploaded(h, key, { folderpath: 'Data Structures/Week 3' });
        h.materialFiles.add(record());
      },
      'missing-student-id',
    ],
    [
      'a students/ object’s metadata names another student',
      `students/${STUDENT}/materials/a.pdf`,
      (h, key) => {
        uploaded(h, key, { studentid: VICTIM });
        h.materialFiles.add(record({ s3Key: key }));
      },
      'student-id-mismatch',
    ],
    [
      'a student claims another student’s id (record owned by the uploader)',
      KEY,
      (h, key) => {
        uploaded(h, key, { studentid: VICTIM });
        h.materialFiles.add(record({ studentId: VICTIM, owner: `${STUDENT}::mallory@s.unibuc.ro` }));
      },
      'no-verified-record',
    ],
    ['no MaterialFile record ever appears', KEY, (h, key) => uploaded(h, key), 'no-verified-record'],
  ])('does not index when %s', async (_label, key, setup, reason) => {
    const h = createHarness();
    setup(h, key);

    const result = await handleS3Event(s3Event(key), h.deps);

    expect(result.outcomes).toEqual([{ kind: 'skipped', key, reason }]);
    expect(h.objects.puts).toEqual([]);
    expect(h.trace).not.toContain('kb.start');
    expect(h.materialFiles.statusWrites).toEqual([]);
  });

  it('gives up waiting for a record after the configured delays', async () => {
    const h = createHarness();
    uploaded(h);

    await handleS3Event(s3Event(KEY), h.deps);

    expect(h.materialFiles.lookups).toBe(5);
    expect(h.clock.sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
  });
});
