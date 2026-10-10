/**
 * Port interfaces for the `materialIndexTrigger` Lambda core (Task 4.6,
 * Requirement 7.6).
 *
 * The core never imports the AWS SDK. Everything it needs from the outside
 * world (S3, the `MaterialFile` table, the Bedrock Knowledge Base, time and
 * logging) arrives through these small, structurally-typed ports. The
 * production adapters live in `awsAdapters.ts` (they receive the SDK clients by
 * injection from the Lambda entry point), and tests use in-memory fakes.
 */

/** Indexing lifecycle of a `MaterialFile`. Mirrors the GraphQL `IndexingStatus` enum. */
export type IndexingStatus = 'PENDING' | 'INDEXING' | 'INDEXED' | 'FAILED';

/** The part of an S3 `HeadObject` result the trigger needs. */
export interface ObjectHead {
  /**
   * User-defined object metadata. S3 returns the keys lower-cased, so the
   * upload helper's `{ studentId, folderPath }` arrives as
   * `{ studentid, folderpath }`.
   */
  metadata: Readonly<Record<string, string>>;
}

/** S3 operations used by the trigger. */
export interface ObjectStorePort {
  /** The object's metadata, or `null` when the object no longer exists. */
  headObject(bucket: string, key: string): Promise<ObjectHead | null>;
  /** Writes a small object (the Knowledge Base metadata sidecar). */
  putObject(bucket: string, key: string, body: string, contentType: string): Promise<void>;
}

/** The fields of a `MaterialFile` row the trigger reads. */
export interface MaterialFileRecord {
  id: string;
  studentId: string;
  s3Key: string;
  /**
   * The AppSync `@auth(rules: [{ allow: owner }])` field. With
   * `usesubusernamefordefaultidentityclaim` it holds `"<sub>::<username>"` and
   * is stamped by AppSync from the caller's token, so, unlike `studentId`, a
   * client cannot pick an arbitrary value when creating the row.
   */
  owner: string | null;
  indexingStatus: string | null;
}

/** Access to the `MaterialFile` table. */
export interface MaterialFileRepository {
  /** Every record of `studentId` whose `s3Key` equals `s3Key` exactly. */
  findByS3Key(studentId: string, s3Key: string): Promise<MaterialFileRecord[]>;
  /**
   * Sets `indexingStatus` (and `updatedAt`) on an existing record. Resolves
   * `false` when the record no longer exists (e.g. deleted while indexing).
   * Must never create a record.
   */
  updateIndexingStatus(
    id: string,
    status: IndexingStatus,
    updatedAt: string
  ): Promise<boolean>;
}

/** Bedrock ingestion job statuses (kept open to tolerate new values). */
export type IngestionJobStatus =
  | 'STARTING'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'FAILED'
  | 'STOPPING'
  | 'STOPPED';

/** A Bedrock Knowledge Base ingestion (sync) job. */
export interface IngestionJob {
  ingestionJobId: string;
  status: IngestionJobStatus | string;
  /** Epoch milliseconds at which the job started (service clock), if reported. */
  startedAtMs?: number;
  failureReasons: string[];
  numberOfDocumentsFailed?: number;
}

export type StartIngestionResult =
  | { started: true; job: IngestionJob }
  /** The data source is busy (a sync is already running) or throttled: retry later. */
  | { started: false; reason: string };

/** The Bedrock Knowledge Base data source the trigger syncs. */
export interface KnowledgeBasePort {
  startIngestionJob(): Promise<StartIngestionResult>;
  getIngestionJob(ingestionJobId: string): Promise<IngestionJob>;
  /** Jobs currently `STARTING` or `IN_PROGRESS` on the data source. */
  listActiveIngestionJobs(): Promise<IngestionJob[]>;
  /**
   * Per-document ingestion status reported by the Knowledge Base
   * (`INDEXED`, `FAILED`, `IGNORED`, ...), or `null` when it has none.
   */
  getDocumentStatus(s3Uri: string): Promise<string | null>;
}

/** Time source. Injected so tests can run multi-minute flows instantly. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type LogFields = Record<string, unknown>;

/** Structured logger (one JSON line per entry in production). */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
