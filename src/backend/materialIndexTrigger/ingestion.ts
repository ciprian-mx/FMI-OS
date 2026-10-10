/**
 * Bedrock Knowledge Base sync handling for the `materialIndexTrigger`
 * (Task 4.6, Requirement 7.6): start (or join) a sync of the data source, wait
 * for it, and decide whether *this* document ended up indexed.
 */
import { describeError } from './logging';
import type { Clock, IngestionJob, KnowledgeBasePort, Logger } from './ports';

/** Timing knobs for syncing. All values are milliseconds except the counter. */
export interface IngestionTimings {
  /** Delay between `GetIngestionJob` polls. */
  pollIntervalMs: number;
  /** First retry delay while the data source is busy; doubles up to the max. */
  startRetryInitialDelayMs: number;
  startRetryMaxDelayMs: number;
  /** Margin for clock differences between this Lambda and Bedrock. */
  adoptionClockSkewMs: number;
  /** Consecutive `GetIngestionJob` errors tolerated before giving up. */
  maxConsecutivePollErrors: number;
}

export interface IngestionDeps {
  knowledgeBase: KnowledgeBasePort;
  clock: Clock;
  logger: Logger;
  timings: IngestionTimings;
}

const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set(['STARTING', 'IN_PROGRESS']);
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['COMPLETE', 'FAILED', 'STOPPED']);

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export type AcquireJobResult =
  | { ok: true; job: IngestionJob; adopted: boolean }
  | { ok: false; reason: string };

/**
 * Starts a sync of the data source, or joins one that is guaranteed to include
 * the document.
 *
 * Bedrock runs at most one ingestion job per data source, so when several
 * students upload at once `StartIngestionJob` reports a conflict. A running job
 * that started after `readyAtMs` (the moment the document and its sidecar were
 * both in S3) scans the bucket after they landed and will index the document,
 * so it is adopted instead of queueing yet another sync. Otherwise the start is
 * retried with exponential backoff until `deadlineMs`.
 */
export async function acquireIngestionJob(
  readyAtMs: number,
  deadlineMs: number,
  deps: IngestionDeps
): Promise<AcquireJobResult> {
  const { knowledgeBase, clock, logger, timings } = deps;
  let delayMs = timings.startRetryInitialDelayMs;

  for (;;) {
    const start = await knowledgeBase.startIngestionJob();
    if (start.started) {
      return { ok: true, job: start.job, adopted: false };
    }

    const adoptable = await findAdoptableJob(readyAtMs, deps);
    if (adoptable) {
      return { ok: true, job: adoptable, adopted: true };
    }

    const remainingMs = deadlineMs - clock.now();
    if (remainingMs <= 0) {
      return { ok: false, reason: start.reason };
    }
    const waitMs = Math.min(delayMs, remainingMs);
    logger.info('Knowledge Base data source is busy; retrying the sync', {
      reason: start.reason,
      retryInMs: waitMs,
    });
    await clock.sleep(waitMs);
    delayMs = Math.min(delayMs * 2, timings.startRetryMaxDelayMs);
  }
}

/** The earliest-started running job that began after the document was ready. */
async function findAdoptableJob(
  readyAtMs: number,
  deps: IngestionDeps
): Promise<IngestionJob | null> {
  let active: IngestionJob[];
  try {
    active = await deps.knowledgeBase.listActiveIngestionJobs();
  } catch (error) {
    // Adoption is an optimisation; without it we simply retry the start.
    deps.logger.warn('Could not list running ingestion jobs', {
      error: describeError(error),
    });
    return null;
  }

  const earliestAllowedStart = readyAtMs + deps.timings.adoptionClockSkewMs;
  let best: IngestionJob | null = null;
  for (const job of active) {
    if (
      !ACTIVE_JOB_STATUSES.has(job.status) ||
      job.startedAtMs === undefined ||
      job.startedAtMs < earliestAllowedStart
    ) {
      continue;
    }
    if (best === null || job.startedAtMs < (best.startedAtMs as number)) {
      best = job;
    }
  }
  return best;
}

export interface JobWaitResult {
  job: IngestionJob;
  /** True when `deadlineMs` passed before the job reached a terminal status. */
  timedOut: boolean;
}

/**
 * Polls the job until it is `COMPLETE`, `FAILED` or `STOPPED`, or until
 * `deadlineMs`. Transient polling errors are tolerated up to
 * `maxConsecutivePollErrors` in a row; after that the last error is thrown.
 */
export async function waitForIngestionJob(
  job: IngestionJob,
  deadlineMs: number,
  deps: IngestionDeps
): Promise<JobWaitResult> {
  const { knowledgeBase, clock, logger, timings } = deps;
  let current = job;
  let consecutiveErrors = 0;

  while (!isTerminalJobStatus(current.status)) {
    const remainingMs = deadlineMs - clock.now();
    if (remainingMs <= 0) {
      return { job: current, timedOut: true };
    }
    await clock.sleep(Math.min(timings.pollIntervalMs, remainingMs));
    try {
      current = await knowledgeBase.getIngestionJob(current.ingestionJobId);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      logger.warn('Polling the ingestion job failed', {
        ingestionJobId: current.ingestionJobId,
        attempt: consecutiveErrors,
        error: describeError(error),
      });
      if (consecutiveErrors >= timings.maxConsecutivePollErrors) {
        throw error;
      }
    }
  }
  return { job: current, timedOut: false };
}

/** The final indexing verdict for one document. */
export interface IngestionOutcome {
  status: 'INDEXED' | 'FAILED';
  /** Machine-readable explanation, e.g. `document-ignored`, `ingestion-timeout`. */
  reason: string;
}

const DOCUMENT_INDEXED: ReadonlySet<string> = new Set(['INDEXED', 'PARTIALLY_INDEXED']);
const DOCUMENT_FAILED: ReadonlySet<string> = new Set([
  'FAILED',
  'IGNORED',
  'METADATA_PARTIALLY_INDEXED',
  'METADATA_UPDATE_FAILED',
  'DELETING',
  'DELETE_IN_PROGRESS',
]);

/**
 * Maps a Knowledge Base document status to a verdict.
 *
 * - `PARTIALLY_INDEXED` counts as indexed: the indexed chunks carry the full
 *   metadata and are retrievable.
 * - Metadata failures count as failed: without `studentId` / `folderPath` the
 *   document is invisible to the isolation filter and cannot be cited.
 * - In-flight statuses and `NOT_FOUND` are `UNKNOWN`; the caller falls back to
 *   the job result (a mis-formatted URI must not turn every file red).
 */
export function classifyDocumentStatus(
  status: string | null
): 'INDEXED' | 'FAILED' | 'UNKNOWN' {
  if (status === null) {
    return 'UNKNOWN';
  }
  if (DOCUMENT_INDEXED.has(status)) {
    return 'INDEXED';
  }
  if (DOCUMENT_FAILED.has(status)) {
    return 'FAILED';
  }
  return 'UNKNOWN';
}

/**
 * Decides INDEXED vs FAILED for one document once its sync has finished.
 *
 * A `COMPLETE` job can still have failed individual documents (and a sync
 * covers every student's pending uploads), so the per-document status is
 * consulted first. If it is unavailable, the job result decides: the document
 * is FAILED only when one of the job's failure reasons names it.
 */
export async function resolveIngestionOutcome(
  wait: JobWaitResult,
  document: { key: string; s3Uri: string },
  deps: IngestionDeps
): Promise<IngestionOutcome> {
  if (wait.timedOut) {
    return { status: 'FAILED', reason: 'ingestion-timeout' };
  }
  const { job } = wait;
  if (job.status !== 'COMPLETE') {
    return { status: 'FAILED', reason: `ingestion-job-${job.status.toLowerCase()}` };
  }

  let documentStatus: string | null = null;
  try {
    documentStatus = await deps.knowledgeBase.getDocumentStatus(document.s3Uri);
  } catch (error) {
    deps.logger.warn('Could not read the document status; using the job result', {
      ingestionJobId: job.ingestionJobId,
      error: describeError(error),
    });
  }

  const verdict = classifyDocumentStatus(documentStatus);
  if (documentStatus !== null && verdict !== 'UNKNOWN') {
    return { status: verdict, reason: `document-${documentStatus.toLowerCase()}` };
  }

  const namesDocument = job.failureReasons.some(
    (reason) => reason.includes(document.key) || reason.includes(document.s3Uri)
  );
  return namesDocument
    ? { status: 'FAILED', reason: 'ingestion-job-reported-document-failure' }
    : { status: 'INDEXED', reason: 'ingestion-job-complete' };
}
