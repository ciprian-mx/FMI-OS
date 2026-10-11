/**
 * `materialIndexTrigger` core (Task 4.6, Requirement 7.6).
 *
 * Invoked for every S3 `ObjectCreated:*` event on the Materials bucket. For a
 * Materials document it:
 *
 *   1. reads the object metadata to learn which student it claims to belong to
 *      (`studentid`, written by the upload helper; the `private/` key holds the
 *      Cognito *identity* id, which is not the user-pool `sub`);
 *   2. verifies that claim against the `MaterialFile` record(s) that student
 *      created for this exact key, waiting briefly because the upload helper
 *      creates the record right *after* the object lands;
 *   3. tags the document for the Knowledge Base by writing the
 *      `<key>.metadata.json` sidecar with `{studentId, folderPath, fileName}`;
 *   4. starts a sync of the Bedrock Knowledge Base data source (or joins a
 *      running one that will include the document);
 *   5. sets `indexingStatus = INDEXING` once that sync is running;
 *   6. waits for the sync and sets `INDEXED` or `FAILED` for this document.
 *
 * Records are processed independently and the handler never throws for a bad
 * record, so one failure cannot make Lambda retry (and re-index) a whole batch.
 * Every failure after step 2 is reported on the verified records as `FAILED`.
 *
 * `ObjectRemoved:*` events for a Materials document (a delete, or the old key
 * of a move / rename) go to `removeMaterial.ts` (Task 4.1, Requirement 7.8),
 * which takes the document out of the Knowledge Base and deletes its sidecar.
 */
import {
  acquireIngestionJob,
  resolveIngestionOutcome,
  waitForIngestionJob,
  type IngestionDeps,
  type IngestionOutcome,
  type IngestionTimings,
} from './ingestion';
import { removeMaterialObject, type RemovalOutcome, type RemovalTimings } from './removeMaterial';
import { describeError } from './logging';
import type {
  Clock,
  IndexingStatus,
  KnowledgeBasePort,
  LogFields,
  Logger,
  MaterialFileRecord,
  MaterialFileRepository,
  ObjectStorePort,
} from './ports';
import { parseS3EventKey, type KeyIgnoreReason, type MaterialObjectKey } from './s3Key';
import { SIDECAR_CONTENT_TYPE, serializeSidecar, sidecarKeyFor } from './sidecar';

/** Object-metadata key (as S3 returns it, lower-cased) carrying the student id. */
export const STUDENT_ID_METADATA_KEY = 'studentid';

/** The parts of an S3 event-notification record the trigger reads. */
export interface S3EventRecordLike {
  eventName?: string;
  /** ISO-8601 time of the S3 operation (used to log deletion latency). */
  eventTime?: string;
  s3?: {
    bucket?: { name?: string };
    object?: { key?: string };
  };
}

export interface S3EventLike {
  Records?: S3EventRecordLike[];
}

/** The part of the Lambda context the trigger uses. */
export interface InvocationContextLike {
  getRemainingTimeInMillis?: () => number;
}

export interface IndexerConfig extends IngestionTimings, RemovalTimings {
  /** Waits between `MaterialFile` lookups while the upload's record is created. */
  recordLookupDelaysMs: readonly number[];
  /** Processing budget when no Lambda context is available. */
  defaultBudgetMs: number;
  /** Kept free at the end of the invocation for the final status writes. */
  deadlineSafetyMarginMs: number;
}

export const DEFAULT_INDEXER_CONFIG: IndexerConfig = {
  pollIntervalMs: 10_000,
  startRetryInitialDelayMs: 5_000,
  startRetryMaxDelayMs: 30_000,
  adoptionClockSkewMs: 2_000,
  maxConsecutivePollErrors: 3,
  // ~15 s in total: the record normally appears within a second of the upload,
  // and the sync still starts well inside Requirement 7.6's 60 s.
  recordLookupDelaysMs: [1_000, 2_000, 4_000, 8_000],
  defaultBudgetMs: 13 * 60_000,
  deadlineSafetyMarginMs: 30_000,
  // Removals (Requirement 7.8: within 10 s). ~7.5 s of retries while Bedrock
  // throttles direct deletions, then up to 10 s of confirmation polling.
  deleteRetryDelaysMs: [500, 1_000, 2_000, 4_000],
  deleteConfirmPollMs: 1_000,
  deleteConfirmTimeoutMs: 10_000,
};

export interface IndexerDeps {
  objects: ObjectStorePort;
  materialFiles: MaterialFileRepository;
  knowledgeBase: KnowledgeBasePort;
  clock: Clock;
  logger: Logger;
  config: IndexerConfig;
}

/** Why an event record is not a Materials document upload or removal. */
export type IgnoreReason = KeyIgnoreReason | 'unsupported-event' | 'malformed-record';

/** Why a Materials document was not indexed. */
export type SkipReason =
  | 'object-missing'
  | 'missing-student-id'
  | 'student-id-mismatch'
  | 'no-verified-record';

export type RecordOutcome =
  | { kind: 'ignored'; key: string | null; reason: IgnoreReason }
  | { kind: 'skipped'; key: string; reason: SkipReason }
  | {
      kind: 'completed';
      key: string;
      studentId: string;
      status: 'INDEXED' | 'FAILED';
      reason: string;
      ingestionJobId: string | null;
      /** Records whose terminal status was written. */
      recordIds: string[];
    }
  /** Failed before the owning records were verified (or, for a removal, before the object was checked). */
  | { kind: 'error'; key: string; message: string }
  /** An `ObjectRemoved` event for a Materials document (see `removeMaterial.ts`). */
  | RemovalOutcome;

export interface HandleS3EventResult {
  outcomes: RecordOutcome[];
}

/** Processes every record of an S3 event notification. */
export async function handleS3Event(
  event: S3EventLike | null | undefined,
  deps: IndexerDeps,
  context?: InvocationContextLike
): Promise<HandleS3EventResult> {
  const records = event && Array.isArray(event.Records) ? event.Records : [];
  const deadlineMs = computeDeadline(deps, context);
  const outcomes = await Promise.all(
    records.map((record) => indexRecord(record, deps, deadlineMs))
  );
  return { outcomes };
}

/** Absolute deadline for this invocation's work (epoch milliseconds). */
export function computeDeadline(deps: IndexerDeps, context?: InvocationContextLike): number {
  const remainingMs = context?.getRemainingTimeInMillis?.();
  const budgetMs =
    typeof remainingMs === 'number' && Number.isFinite(remainingMs)
      ? remainingMs - deps.config.deadlineSafetyMarginMs
      : deps.config.defaultBudgetMs;
  return deps.clock.now() + Math.max(0, budgetMs);
}

export type StudentClaim =
  | { ok: true; studentId: string }
  | { ok: false; reason: 'missing-student-id' | 'student-id-mismatch' };

/**
 * Which student an object claims to belong to.
 *
 * `students/{userId}/...` keys carry the id in the key; metadata, when present,
 * must agree. `private/{identity-id}/...` keys carry the Cognito identity id,
 * which is not the user-pool `sub` the rest of the system uses, so the id comes
 * from the object metadata the upload helper writes.
 */
export function resolveStudentClaim(
  material: MaterialObjectKey,
  metadata: Readonly<Record<string, string>>
): StudentClaim {
  const fromMetadata = readMetadata(metadata, STUDENT_ID_METADATA_KEY);
  if (material.layout === 'students') {
    if (fromMetadata !== null && fromMetadata !== material.ownerSegment) {
      return { ok: false, reason: 'student-id-mismatch' };
    }
    return { ok: true, studentId: material.ownerSegment };
  }
  if (fromMetadata === null) {
    return { ok: false, reason: 'missing-student-id' };
  }
  return { ok: true, studentId: fromMetadata };
}

/**
 * Whether `record` vouches for the object at `key` belonging to `studentId`.
 *
 * Object metadata and `MaterialFile.studentId` are both client-supplied, so on
 * their own they would let a student tag their file with someone else's id and
 * push it into that student's retrievals. The AppSync `owner` field is stamped
 * from the caller's token, so its identity part (the text before `::`) must be
 * the claimed student as well.
 */
export function isRecordOwnedBy(
  record: MaterialFileRecord,
  studentId: string,
  key: string
): boolean {
  if (record.studentId !== studentId || record.s3Key !== key) {
    return false;
  }
  if (typeof record.owner !== 'string' || record.owner === '') {
    return false;
  }
  const [ownerIdentity] = record.owner.split('::');
  return ownerIdentity === studentId;
}

function isObjectCreatedEvent(eventName: string): boolean {
  return /^(s3:)?ObjectCreated:/.test(eventName);
}

/** `ObjectRemoved:Delete` (unversioned bucket) and `ObjectRemoved:DeleteMarkerCreated` (versioned). */
function isObjectRemovedEvent(eventName: string): boolean {
  return /^(s3:)?ObjectRemoved:/.test(eventName);
}

function parseEventTime(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function readMetadata(metadata: Readonly<Record<string, string>>, name: string): string | null {
  for (const [key, value] of Object.entries(metadata)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

async function indexRecord(
  record: S3EventRecordLike,
  deps: IndexerDeps,
  deadlineMs: number
): Promise<RecordOutcome> {
  const eventName = typeof record?.eventName === 'string' ? record.eventName : '';
  const bucket = record?.s3?.bucket?.name;
  const rawKey = record?.s3?.object?.key;

  const removed = isObjectRemovedEvent(eventName);
  if (!removed && !isObjectCreatedEvent(eventName)) {
    return ignore(typeof rawKey === 'string' ? rawKey : null, 'unsupported-event', deps, {
      eventName,
    });
  }
  if (typeof bucket !== 'string' || bucket === '' || typeof rawKey !== 'string' || rawKey === '') {
    return ignore(null, 'malformed-record', deps);
  }

  // The same filter for both event types: sidecar removals (our own cleanup,
  // or a sidecar deleted with its folder) and folder markers are ignored.
  const parsed = parseS3EventKey(rawKey);
  if (!parsed.ok) {
    return ignore(rawKey, parsed.reason, deps, removed ? { eventName } : {});
  }

  const material = parsed.value;
  if (removed) {
    try {
      return await removeMaterialObject(
        bucket,
        material,
        deps,
        deadlineMs,
        parseEventTime(record?.eventTime)
      );
    } catch (error) {
      deps.logger.error('Removing the material failed before the object was checked', {
        key: material.key,
        error: describeError(error),
      });
      return { kind: 'error', key: material.key, message: describeError(error) };
    }
  }
  try {
    return await indexMaterialObject(bucket, material, deps, deadlineMs);
  } catch (error) {
    deps.logger.error('Indexing failed before the owning records were verified', {
      key: material.key,
      error: describeError(error),
    });
    return { kind: 'error', key: material.key, message: describeError(error) };
  }
}

async function indexMaterialObject(
  bucket: string,
  material: MaterialObjectKey,
  deps: IndexerDeps,
  deadlineMs: number
): Promise<RecordOutcome> {
  const { key } = material;

  // 1. Which student does the object claim to belong to?
  const head = await deps.objects.headObject(bucket, key);
  if (head === null) {
    return skip(key, 'object-missing', deps);
  }
  const claim = resolveStudentClaim(material, head.metadata);
  if (!claim.ok) {
    return skip(key, claim.reason, deps);
  }
  const { studentId } = claim;

  // 2. Verify the claim against that student's own MaterialFile record(s).
  const records = await findVerifiedRecords(studentId, key, deps, true);
  if (records.length === 0) {
    return skip(key, 'no-verified-record', deps, { studentId });
  }

  return ingestVerifiedMaterial(bucket, material, studentId, records, deps, deadlineMs);
}

async function ingestVerifiedMaterial(
  bucket: string,
  material: MaterialObjectKey,
  studentId: string,
  records: MaterialFileRecord[],
  deps: IndexerDeps,
  deadlineMs: number
): Promise<RecordOutcome> {
  const { key } = material;
  const s3Uri = `s3://${bucket}/${key}`;
  const ingestion = ingestionDeps(deps);
  let ingestionJobId: string | null = null;
  let outcome: IngestionOutcome;

  try {
    // 3. Tag the document before any sync can scan it.
    await deps.objects.putObject(
      bucket,
      sidecarKeyFor(key),
      serializeSidecar({ studentId, folderPath: material.folderPath, fileName: material.fileName }),
      SIDECAR_CONTENT_TYPE
    );
    const readyAtMs = deps.clock.now();

    // 4. Start (or join) a sync that includes the document.
    const acquired = await acquireIngestionJob(readyAtMs, deadlineMs, ingestion);
    if (!acquired.ok) {
      outcome = { status: 'FAILED', reason: `ingestion-not-started:${acquired.reason}` };
    } else {
      ingestionJobId = acquired.job.ingestionJobId;
      deps.logger.info('Knowledge Base sync covering the material is running', {
        key,
        studentId,
        ingestionJobId,
        adopted: acquired.adopted,
      });

      // 5. INDEXING while the sync runs.
      await writeStatus(records, 'INDEXING', deps, key);

      // 6. Wait for the sync and decide for this document.
      const waited = await waitForIngestionJob(acquired.job, deadlineMs, ingestion);
      outcome = await resolveIngestionOutcome(waited, { key, s3Uri }, ingestion);
    }
  } catch (error) {
    deps.logger.error('Indexing the material failed', {
      key,
      studentId,
      ingestionJobId,
      error: describeError(error),
    });
    outcome = { status: 'FAILED', reason: `error:${describeError(error)}` };
  }

  const recordIds = await writeTerminalStatus(studentId, key, records, outcome.status, deps);
  deps.logger.info('Material indexing finished', {
    key,
    studentId,
    status: outcome.status,
    reason: outcome.reason,
    ingestionJobId,
    recordIds,
  });
  return {
    kind: 'completed',
    key,
    studentId,
    status: outcome.status,
    reason: outcome.reason,
    ingestionJobId,
    recordIds,
  };
}

/**
 * The claimed student's own records for `key`. With `waitForRecord`, retries
 * on the configured delays while none exists yet (the upload helper creates
 * the record after the object, and the `byStudent` index is eventually
 * consistent).
 */
async function findVerifiedRecords(
  studentId: string,
  key: string,
  deps: IndexerDeps,
  waitForRecord: boolean
): Promise<MaterialFileRecord[]> {
  const delays = waitForRecord ? deps.config.recordLookupDelaysMs : [];
  for (let attempt = 0; ; attempt += 1) {
    const found = await deps.materialFiles.findByS3Key(studentId, key);
    const verified = found.filter((record) => isRecordOwnedBy(record, studentId, key));
    if (verified.length < found.length) {
      deps.logger.warn('Ignoring MaterialFile records not owned by the claimed student', {
        key,
        studentId,
        recordIds: found.filter((record) => !verified.includes(record)).map((r) => r.id),
      });
    }
    if (verified.length > 0 || attempt >= delays.length) {
      return verified;
    }
    await deps.clock.sleep(delays[attempt]);
  }
}

/**
 * Writes the terminal status to the verified records, including any created
 * while the sync ran (e.g. the same file uploaded again).
 */
async function writeTerminalStatus(
  studentId: string,
  key: string,
  known: MaterialFileRecord[],
  status: IndexingStatus,
  deps: IndexerDeps
): Promise<string[]> {
  let targets = known;
  try {
    const latest = await findVerifiedRecords(studentId, key, deps, false);
    const knownIds = new Set(known.map((record) => record.id));
    targets = [...known, ...latest.filter((record) => !knownIds.has(record.id))];
  } catch (error) {
    deps.logger.warn('Could not re-read MaterialFile records; updating the known ones', {
      key,
      error: describeError(error),
    });
  }
  return writeStatus(targets, status, deps, key);
}

/** Best-effort status write; returns the ids that were updated. Never throws. */
async function writeStatus(
  records: MaterialFileRecord[],
  status: IndexingStatus,
  deps: IndexerDeps,
  key: string
): Promise<string[]> {
  const updatedAt = new Date(deps.clock.now()).toISOString();
  const updated: string[] = [];
  for (const record of records) {
    try {
      // Conditional on the record still pointing at `key`: a file moved or
      // renamed meanwhile gets its status from the run for its new key.
      if (await deps.materialFiles.updateIndexingStatus(record.id, status, updatedAt, key)) {
        updated.push(record.id);
      } else {
        deps.logger.warn('MaterialFile record is gone or now points at another key; status not written', {
          key,
          recordId: record.id,
          status,
        });
      }
    } catch (error) {
      deps.logger.error('Writing the indexing status failed', {
        key,
        recordId: record.id,
        status,
        error: describeError(error),
      });
    }
  }
  return updated;
}

function ingestionDeps(deps: IndexerDeps): IngestionDeps {
  return {
    knowledgeBase: deps.knowledgeBase,
    clock: deps.clock,
    logger: deps.logger,
    timings: deps.config,
  };
}

function ignore(
  key: string | null,
  reason: IgnoreReason,
  deps: IndexerDeps,
  fields: LogFields = {}
): RecordOutcome {
  deps.logger.info('Ignoring S3 event record', { key, reason, ...fields });
  return { kind: 'ignored', key, reason };
}

function skip(
  key: string,
  reason: SkipReason,
  deps: IndexerDeps,
  fields: LogFields = {}
): RecordOutcome {
  deps.logger.warn('Material not indexed', { key, reason, ...fields });
  return { kind: 'skipped', key, reason };
}
