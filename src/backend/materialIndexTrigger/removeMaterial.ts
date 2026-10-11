/**
 * Knowledge Base deletion propagation for `materialIndexTrigger` (Task 4.1,
 * Requirement 7.8: deletions reach the Knowledge Base within 10 seconds).
 *
 * Runs for every `s3:ObjectRemoved:*` event on a Materials document. The
 * Materials app deletes documents, and moves or renames them by copy + delete
 * (`src/materials/folderService.ts`), so all three end here for the old key.
 * Bedrock's S3 connector only notices a vanished object during the next
 * data-source sync, which takes minutes, so the trigger removes the document
 * itself:
 *
 *   1. `HeadObject`: if the key holds an object again (a re-upload, or a
 *      removal event delivered after a newer creation), the event is stale and
 *      nothing is removed.
 *   2. `DeleteKnowledgeBaseDocuments` with the document's S3 URI. This
 *      direct-ingestion call supports S3 data sources and takes the document
 *      out of the vector store without a sync. It is retried briefly while
 *      Bedrock throttles (at most 10 concurrent direct ingest/delete requests
 *      per account).
 *   3. Deletes the `<key>.metadata.json` sidecar. Its own ObjectRemoved event
 *      is ignored by the key parser.
 *   4. Polls `GetKnowledgeBaseDocuments` until the document is gone, for up to
 *      `deleteConfirmTimeoutMs` (10 s), and logs the observed latency so the
 *      Requirement 7.8 window can be checked in CloudWatch.
 *   5. Starts (or joins) a data-source sync when the direct path cannot
 *      guarantee the removal: Bedrock refused or kept throttling the delete,
 *      the delete was not confirmed in time, or a sync that was already running
 *      when the object disappeared could still index it (upload, then delete
 *      while that upload's sync runs). A sync that starts after the removal
 *      drops the document because its object is gone. The function does not
 *      wait for that sync to finish.
 *
 * Every failure after step 1 is logged and reported in the outcome instead of
 * thrown, so one bad record cannot make Lambda replay the whole batch.
 */
import { acquireIngestionJob, type IngestionDeps, type IngestionTimings } from './ingestion';
import { describeError } from './logging';
import type {
  Clock,
  DeleteDocumentResult,
  IngestionJob,
  KnowledgeBasePort,
  Logger,
  ObjectStorePort,
} from './ports';
import type { MaterialObjectKey } from './s3Key';
import { sidecarKeyFor } from './sidecar';

/** Timing knobs for removals, in milliseconds. */
export interface RemovalTimings {
  /** Waits between `DeleteKnowledgeBaseDocuments` attempts while Bedrock is busy. */
  deleteRetryDelaysMs: readonly number[];
  /** Delay between `GetKnowledgeBaseDocuments` polls that confirm a deletion. */
  deleteConfirmPollMs: number;
  /** How long to wait for Bedrock to report the document gone. */
  deleteConfirmTimeoutMs: number;
}

/** The ports a removal uses (a subset of the indexer's dependencies). */
export interface RemovalDeps {
  objects: ObjectStorePort;
  knowledgeBase: KnowledgeBasePort;
  clock: Clock;
  logger: Logger;
  config: RemovalTimings & IngestionTimings;
}

/** What happened to the document in the Knowledge Base. */
export type KnowledgeBaseRemoval =
  /** Deleted directly; Bedrock reported it gone within the confirmation window. */
  | 'deleted'
  /** Bedrock accepted the deletion but still listed the document when the window closed. */
  | 'delete-pending'
  /** The Knowledge Base had no such document (for example, deleted before it was indexed). */
  | 'not-indexed'
  /** Bedrock refused or kept throttling the direct deletion, or it failed; the follow-up sync removes it. */
  | 'delete-rejected';

/** Why a data-source sync was started after the direct deletion. */
export type FollowUpReason =
  | 'direct-delete-not-applied'
  | 'deletion-unconfirmed'
  | 'sync-in-flight'
  | 'running-syncs-unknown';

export type FollowUpSync =
  | { status: 'not-needed' }
  | { status: 'started' | 'joined'; reason: FollowUpReason; ingestionJobId: string }
  | { status: 'not-started'; reason: FollowUpReason; detail: string };

export type RemovalOutcome =
  /** The key holds an object again, so the removal event is stale. */
  | { kind: 'removal-skipped'; key: string; reason: 'object-exists' }
  | {
      kind: 'removed';
      key: string;
      knowledgeBase: KnowledgeBaseRemoval;
      /** Bedrock's status or error behind `knowledgeBase` (e.g. `NOT_FOUND`, `ThrottlingException`). */
      detail: string | null;
      /** Milliseconds from noticing the removal to Bedrock reporting the document gone. */
      confirmedAfterMs: number | null;
      sidecarDeleted: boolean;
      sync: FollowUpSync;
    };

/** True when a document status means the Knowledge Base no longer has the document. */
export function isDocumentGone(status: string | null): boolean {
  return status === null || status === 'NOT_FOUND';
}

/**
 * Takes a removed Materials document out of the Knowledge Base and deletes its
 * sidecar. `eventTimeMs` is the S3 event time, used only to log the
 * end-to-end latency.
 */
export async function removeMaterialObject(
  bucket: string,
  material: MaterialObjectKey,
  deps: RemovalDeps,
  deadlineMs: number,
  eventTimeMs: number | null = null
): Promise<RemovalOutcome> {
  const { key } = material;

  // 1. A stale event must not remove a document that exists again.
  if ((await deps.objects.headObject(bucket, key)) !== null) {
    deps.logger.info('Removal event ignored: the key holds an object again', { key });
    return { kind: 'removal-skipped', key, reason: 'object-exists' };
  }
  const goneAtMs = deps.clock.now();
  const s3Uri = `s3://${bucket}/${key}`;

  // 2. Direct deletion (the fast path).
  const deletion = await requestDeletion(s3Uri, deps, deadlineMs);

  // 3. The sidecar is only useful next to its document.
  const sidecarDeleted = await deleteSidecar(bucket, key, deps);

  // 4. Wait (briefly) for Bedrock to confirm.
  const verdict = await settleDeletion(deletion, s3Uri, goneAtMs, deps, deadlineMs);

  // 5. Safety net: a sync that starts after the removal.
  const sync = await followUpSync(verdict.knowledgeBase, goneAtMs, deps, deadlineMs);

  const fields = {
    key,
    knowledgeBase: verdict.knowledgeBase,
    detail: verdict.detail,
    confirmedAfterMs: verdict.confirmedAfterMs,
    sinceRemovalMs:
      verdict.confirmedAfterMs !== null && eventTimeMs !== null
        ? goneAtMs + verdict.confirmedAfterMs - eventTimeMs
        : null,
    sidecarDeleted,
    sync,
  };
  if (verdict.knowledgeBase === 'delete-pending' || verdict.knowledgeBase === 'delete-rejected') {
    deps.logger.warn('Knowledge Base deletion not confirmed within the window', fields);
  }
  deps.logger.info('Material removal finished', fields);

  return {
    kind: 'removed',
    key,
    knowledgeBase: verdict.knowledgeBase,
    detail: verdict.detail,
    confirmedAfterMs: verdict.confirmedAfterMs,
    sidecarDeleted,
    sync,
  };
}

/** `DeleteKnowledgeBaseDocuments`, retried on the configured delays while busy. Never throws. */
async function requestDeletion(
  s3Uri: string,
  deps: RemovalDeps,
  deadlineMs: number
): Promise<DeleteDocumentResult> {
  const delays = deps.config.deleteRetryDelaysMs;
  for (let attempt = 0; ; attempt += 1) {
    let result: DeleteDocumentResult;
    try {
      result = await deps.knowledgeBase.deleteDocument(s3Uri);
    } catch (error) {
      deps.logger.error('Deleting the document from the Knowledge Base failed', {
        s3Uri,
        error: describeError(error),
      });
      return { outcome: 'rejected', reason: `error:${describeError(error)}` };
    }
    if (result.outcome !== 'busy') {
      return result;
    }
    const remainingMs = deadlineMs - deps.clock.now();
    if (attempt >= delays.length || remainingMs <= 0) {
      return result;
    }
    const waitMs = Math.min(delays[attempt], remainingMs);
    deps.logger.info('Knowledge Base is busy; retrying the document deletion', {
      s3Uri,
      reason: result.reason,
      retryInMs: waitMs,
    });
    await deps.clock.sleep(waitMs);
  }
}

async function deleteSidecar(bucket: string, key: string, deps: RemovalDeps): Promise<boolean> {
  try {
    await deps.objects.deleteObject(bucket, sidecarKeyFor(key));
    return true;
  } catch (error) {
    deps.logger.error('Deleting the metadata sidecar failed', { key, error: describeError(error) });
    return false;
  }
}

interface DeletionVerdict {
  knowledgeBase: KnowledgeBaseRemoval;
  detail: string | null;
  confirmedAfterMs: number | null;
}

async function settleDeletion(
  deletion: DeleteDocumentResult,
  s3Uri: string,
  goneAtMs: number,
  deps: RemovalDeps,
  deadlineMs: number
): Promise<DeletionVerdict> {
  if (deletion.outcome === 'not-found') {
    return { knowledgeBase: 'not-indexed', detail: deletion.reason, confirmedAfterMs: null };
  }
  if (deletion.outcome === 'busy' || deletion.outcome === 'rejected') {
    return { knowledgeBase: 'delete-rejected', detail: deletion.reason, confirmedAfterMs: null };
  }
  if (deletion.status === 'NOT_FOUND') {
    return { knowledgeBase: 'not-indexed', detail: deletion.status, confirmedAfterMs: null };
  }
  const confirmation = await confirmDeletion(s3Uri, deps, deadlineMs);
  if (confirmation.gone) {
    return {
      knowledgeBase: 'deleted',
      detail: null,
      confirmedAfterMs: confirmation.atMs - goneAtMs,
    };
  }
  return {
    knowledgeBase: 'delete-pending',
    detail: confirmation.lastStatus ?? deletion.status,
    confirmedAfterMs: null,
  };
}

type Confirmation = { gone: true; atMs: number } | { gone: false; lastStatus: string | null };

/** Polls the document status until it is gone or the confirmation window closes. */
async function confirmDeletion(
  s3Uri: string,
  deps: RemovalDeps,
  deadlineMs: number
): Promise<Confirmation> {
  const { clock, config } = deps;
  const untilMs = Math.min(clock.now() + config.deleteConfirmTimeoutMs, deadlineMs);
  let lastStatus: string | null = null;
  for (;;) {
    const remainingMs = untilMs - clock.now();
    if (remainingMs <= 0) {
      return { gone: false, lastStatus };
    }
    await clock.sleep(Math.min(config.deleteConfirmPollMs, remainingMs));
    let status: string | null;
    try {
      status = await deps.knowledgeBase.getDocumentStatus(s3Uri);
    } catch (error) {
      deps.logger.warn('Could not confirm the Knowledge Base deletion', {
        s3Uri,
        error: describeError(error),
      });
      return { gone: false, lastStatus };
    }
    if (isDocumentGone(status)) {
      return { gone: true, atMs: clock.now() };
    }
    lastStatus = status;
  }
}

/** Starts or joins a sync that began after the removal, when one is needed. Never throws. */
async function followUpSync(
  removal: KnowledgeBaseRemoval,
  goneAtMs: number,
  deps: RemovalDeps,
  deadlineMs: number
): Promise<FollowUpSync> {
  let reason: FollowUpReason | null;
  if (removal === 'delete-rejected') {
    reason = 'direct-delete-not-applied';
  } else if (removal === 'delete-pending') {
    reason = 'deletion-unconfirmed';
  } else {
    reason = await runningSyncReason(goneAtMs, deps);
  }
  if (reason === null) {
    return { status: 'not-needed' };
  }

  try {
    const acquired = await acquireIngestionJob(goneAtMs, deadlineMs, ingestionDeps(deps));
    if (!acquired.ok) {
      deps.logger.warn('No follow-up Knowledge Base sync could be started', {
        reason,
        detail: acquired.reason,
      });
      return { status: 'not-started', reason, detail: acquired.reason };
    }
    return {
      status: acquired.adopted ? 'joined' : 'started',
      reason,
      ingestionJobId: acquired.job.ingestionJobId,
    };
  } catch (error) {
    deps.logger.error('Starting the follow-up Knowledge Base sync failed', {
      reason,
      error: describeError(error),
    });
    return { status: 'not-started', reason, detail: `error:${describeError(error)}` };
  }
}

/**
 * `sync-in-flight` when a running sync may have listed the bucket before the
 * object disappeared (it could still index the document), `null` when none did.
 */
async function runningSyncReason(
  goneAtMs: number,
  deps: RemovalDeps
): Promise<FollowUpReason | null> {
  let active: IngestionJob[];
  try {
    active = await deps.knowledgeBase.listActiveIngestionJobs();
  } catch (error) {
    deps.logger.warn('Could not list running ingestion jobs', { error: describeError(error) });
    return 'running-syncs-unknown';
  }
  const safeStartMs = goneAtMs + deps.config.adoptionClockSkewMs;
  const predatesRemoval = active.some(
    (job) => job.startedAtMs === undefined || job.startedAtMs < safeStartMs
  );
  return predatesRemoval ? 'sync-in-flight' : null;
}

function ingestionDeps(deps: RemovalDeps): IngestionDeps {
  return {
    knowledgeBase: deps.knowledgeBase,
    clock: deps.clock,
    logger: deps.logger,
    timings: deps.config,
  };
}
