/**
 * In-memory fakes for the materialIndexTrigger ports. Every fake appends to a
 * shared `trace`, so tests can assert the order of side effects across S3,
 * DynamoDB and Bedrock.
 *
 * Lives under `__tests__/` so the function build does not deploy it.
 */
import {
  DEFAULT_INDEXER_CONFIG,
  type IndexerConfig,
  type IndexerDeps,
  type S3EventLike,
} from '../indexMaterial';
import type {
  Clock,
  IndexingStatus,
  IngestionJob,
  KnowledgeBasePort,
  LogFields,
  Logger,
  MaterialFileRecord,
  MaterialFileRepository,
  ObjectHead,
  ObjectStorePort,
  StartIngestionResult,
} from '../ports';

export const T0 = Date.parse('2024-05-01T12:00:00.000Z');

/** A clock whose `sleep` advances time instantly. */
export class FakeClock implements Clock {
  current = T0;

  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}

interface StoredObject {
  metadata: Record<string, string>;
  body?: string;
  contentType?: string;
}

export class FakeObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, StoredObject>();

  readonly puts: { bucket: string; key: string; body: string; contentType: string }[] = [];

  headError: Error | null = null;

  constructor(private readonly trace: string[]) {}

  addObject(bucket: string, key: string, metadata: Record<string, string> = {}): void {
    this.objects.set(`${bucket}/${key}`, { metadata });
  }

  async headObject(bucket: string, key: string): Promise<ObjectHead | null> {
    this.trace.push(`s3.head ${key}`);
    if (this.headError) {
      throw this.headError;
    }
    const stored = this.objects.get(`${bucket}/${key}`);
    return stored ? { metadata: { ...stored.metadata } } : null;
  }

  async putObject(bucket: string, key: string, body: string, contentType: string): Promise<void> {
    this.trace.push(`s3.put ${key}`);
    this.puts.push({ bucket, key, body, contentType });
    this.objects.set(`${bucket}/${key}`, { metadata: {}, body, contentType });
  }
}

export class FakeMaterialFileRepository implements MaterialFileRepository {
  readonly records = new Map<string, MaterialFileRecord>();

  readonly statusWrites: { id: string; status: IndexingStatus; updatedAt: string }[] = [];

  lookups = 0;

  private readonly pending: { record: MaterialFileRecord; visibleAfterLookups: number }[] = [];

  constructor(private readonly trace: string[]) {}

  /**
   * Adds a record. With `visibleAfterLookups`, it only shows up from that
   * lookup on (simulates the record being created after the upload).
   */
  add(record: MaterialFileRecord, options: { visibleAfterLookups?: number } = {}): void {
    if (options.visibleAfterLookups) {
      this.pending.push({ record: { ...record }, visibleAfterLookups: options.visibleAfterLookups });
    } else {
      this.records.set(record.id, { ...record });
    }
  }

  async findByS3Key(studentId: string, s3Key: string): Promise<MaterialFileRecord[]> {
    this.lookups += 1;
    this.trace.push('db.find');
    for (const entry of this.pending.filter((p) => p.visibleAfterLookups <= this.lookups)) {
      this.records.set(entry.record.id, entry.record);
      this.pending.splice(this.pending.indexOf(entry), 1);
    }
    return [...this.records.values()]
      .filter((record) => record.studentId === studentId && record.s3Key === s3Key)
      .map((record) => ({ ...record }));
  }

  async updateIndexingStatus(id: string, status: IndexingStatus, updatedAt: string): Promise<boolean> {
    this.trace.push(`db.update ${id} ${status}`);
    const record = this.records.get(id);
    if (!record) {
      return false;
    }
    record.indexingStatus = status;
    this.statusWrites.push({ id, status, updatedAt });
    return true;
  }

  /** Statuses written to one record, in order. */
  history(id: string): IndexingStatus[] {
    return this.statusWrites.filter((write) => write.id === id).map((write) => write.status);
  }
}

export type ScriptedStart = 'start' | 'busy' | Error;

export class FakeKnowledgeBase implements KnowledgeBasePort {
  /** Results of successive `startIngestionJob` calls; afterwards `fallbackStart`. */
  startScript: ScriptedStart[] = [];

  fallbackStart: ScriptedStart = 'start';

  /** Statuses returned by successive polls; the last one repeats. */
  pollStatuses: string[] = ['IN_PROGRESS', 'COMPLETE'];

  /** Errors thrown by the next polls before `pollStatuses` is consulted. */
  pollErrors: Error[] = [];

  failureReasons: string[] = [];

  activeJobs: IngestionJob[] = [];

  documentStatus: string | null | Error = 'INDEXED';

  /** Called on every poll (lets a test change the world mid-sync). */
  onPoll: (() => void) | null = null;

  readonly startedJobIds: string[] = [];

  constructor(private readonly trace: string[], private readonly clock: Clock) {}

  async startIngestionJob(): Promise<StartIngestionResult> {
    this.trace.push('kb.start');
    const next = this.startScript.length > 0 ? this.startScript.shift() : this.fallbackStart;
    if (next instanceof Error) {
      throw next;
    }
    if (next === 'busy') {
      return { started: false, reason: 'ConflictException' };
    }
    const ingestionJobId = `job-${this.startedJobIds.length + 1}`;
    this.startedJobIds.push(ingestionJobId);
    return {
      started: true,
      job: { ingestionJobId, status: 'STARTING', startedAtMs: this.clock.now(), failureReasons: [] },
    };
  }

  async getIngestionJob(ingestionJobId: string): Promise<IngestionJob> {
    this.trace.push(`kb.get ${ingestionJobId}`);
    this.onPoll?.();
    const error = this.pollErrors.shift();
    if (error) {
      throw error;
    }
    const status =
      this.pollStatuses.length > 1 ? (this.pollStatuses.shift() as string) : this.pollStatuses[0];
    return { ingestionJobId, status, failureReasons: [...this.failureReasons] };
  }

  async listActiveIngestionJobs(): Promise<IngestionJob[]> {
    this.trace.push('kb.list');
    return this.activeJobs.map((job) => ({ ...job }));
  }

  async getDocumentStatus(s3Uri: string): Promise<string | null> {
    this.trace.push(`kb.doc ${s3Uri}`);
    if (this.documentStatus instanceof Error) {
      throw this.documentStatus;
    }
    return this.documentStatus;
  }
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields?: LogFields;
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields });
  }

  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields });
  }

  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields });
  }
}

/** All fakes wired into a ready-to-use {@link IndexerDeps}. */
export function createHarness(config: Partial<IndexerConfig> = {}) {
  const trace: string[] = [];
  const clock = new FakeClock();
  const objects = new FakeObjectStore(trace);
  const materialFiles = new FakeMaterialFileRepository(trace);
  const knowledgeBase = new FakeKnowledgeBase(trace, clock);
  const logger = new RecordingLogger();
  const deps: IndexerDeps = {
    objects,
    materialFiles,
    knowledgeBase,
    clock,
    logger,
    config: { ...DEFAULT_INDEXER_CONFIG, ...config },
  };
  return { trace, clock, objects, materialFiles, knowledgeBase, logger, deps };
}

/**
 * Encodes a key the way S3 event notifications deliver it: every segment
 * form-URL-encoded (space as `+`), slashes kept.
 */
export function encodeS3EventKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%20/g, '+'))
    .join('/');
}

/** A one-record S3 event notification for `key` (encoded as S3 would). */
export function s3Event(
  key: string,
  options: { bucket?: string; eventName?: string; encoded?: boolean } = {}
): S3EventLike {
  return {
    Records: [
      {
        eventName: options.eventName ?? 'ObjectCreated:Put',
        s3: {
          bucket: { name: options.bucket ?? 'fmios-materials-storage-dev' },
          object: { key: options.encoded === false ? key : encodeS3EventKey(key) },
        },
      },
    ],
  };
}
