import { createHarness } from './__tests__/fakes';
import {
  classifyDocumentStatus,
  resolveIngestionOutcome,
  waitForIngestionJob,
  type IngestionDeps,
} from './ingestion';
import type { IngestionJob } from './ports';

/**
 * Task 4.6 — Knowledge Base sync outcome handling.
 *
 * Validates: Requirements 7.6
 */

const DOCUMENT = {
  key: 'private/id/materials/Week 3/Sorting.pdf',
  s3Uri: 's3://bucket/private/id/materials/Week 3/Sorting.pdf',
};

function job(status: string, failureReasons: string[] = []): IngestionJob {
  return { ingestionJobId: 'job-1', status, failureReasons };
}

function ingestionDeps(harness = createHarness()): IngestionDeps {
  return {
    knowledgeBase: harness.knowledgeBase,
    clock: harness.clock,
    logger: harness.logger,
    timings: harness.deps.config,
  };
}

describe('classifyDocumentStatus', () => {
  it.each([
    ['INDEXED', 'INDEXED'],
    ['PARTIALLY_INDEXED', 'INDEXED'],
    ['FAILED', 'FAILED'],
    ['IGNORED', 'FAILED'],
    ['METADATA_PARTIALLY_INDEXED', 'FAILED'],
    ['METADATA_UPDATE_FAILED', 'FAILED'],
    ['DELETE_IN_PROGRESS', 'FAILED'],
    ['NOT_FOUND', 'UNKNOWN'],
    ['IN_PROGRESS', 'UNKNOWN'],
    ['SOMETHING_NEW', 'UNKNOWN'],
  ])('maps %s to %s', (status, verdict) => {
    expect(classifyDocumentStatus(status)).toBe(verdict);
  });

  it('treats a missing status as unknown', () => {
    expect(classifyDocumentStatus(null)).toBe('UNKNOWN');
  });
});

describe('resolveIngestionOutcome', () => {
  it('fails a document whose sync timed out or did not complete', async () => {
    const deps = ingestionDeps();
    await expect(
      resolveIngestionOutcome({ job: job('IN_PROGRESS'), timedOut: true }, DOCUMENT, deps)
    ).resolves.toEqual({ status: 'FAILED', reason: 'ingestion-timeout' });
    await expect(
      resolveIngestionOutcome({ job: job('FAILED'), timedOut: false }, DOCUMENT, deps)
    ).resolves.toEqual({ status: 'FAILED', reason: 'ingestion-job-failed' });
    await expect(
      resolveIngestionOutcome({ job: job('STOPPED'), timedOut: false }, DOCUMENT, deps)
    ).resolves.toEqual({ status: 'FAILED', reason: 'ingestion-job-stopped' });
  });

  it('uses the per-document status of a completed sync', async () => {
    const harness = createHarness();
    harness.knowledgeBase.documentStatus = 'IGNORED';
    await expect(
      resolveIngestionOutcome({ job: job('COMPLETE'), timedOut: false }, DOCUMENT, ingestionDeps(harness))
    ).resolves.toEqual({ status: 'FAILED', reason: 'document-ignored' });
    expect(harness.trace).toEqual([`kb.doc ${DOCUMENT.s3Uri}`]);
  });

  it('falls back to the job result when the document status is unavailable', async () => {
    const harness = createHarness();
    harness.knowledgeBase.documentStatus = new Error('AccessDeniedException');
    const deps = ingestionDeps(harness);

    await expect(
      resolveIngestionOutcome({ job: job('COMPLETE', ['other.pdf: too large']), timedOut: false }, DOCUMENT, deps)
    ).resolves.toEqual({ status: 'INDEXED', reason: 'ingestion-job-complete' });

    await expect(
      resolveIngestionOutcome(
        { job: job('COMPLETE', [`Encountered error in ${DOCUMENT.s3Uri}`]), timedOut: false },
        DOCUMENT,
        deps
      )
    ).resolves.toEqual({ status: 'FAILED', reason: 'ingestion-job-reported-document-failure' });
  });
});

describe('waitForIngestionJob', () => {
  it('tolerates transient polling errors', async () => {
    const harness = createHarness();
    harness.knowledgeBase.pollErrors = [new Error('ThrottlingException'), new Error('ThrottlingException')];
    harness.knowledgeBase.pollStatuses = ['COMPLETE'];

    const result = await waitForIngestionJob(job('STARTING'), harness.clock.now() + 600_000, ingestionDeps(harness));

    expect(result).toEqual({ job: expect.objectContaining({ status: 'COMPLETE' }), timedOut: false });
  });

  it('gives up after too many consecutive polling errors', async () => {
    const harness = createHarness();
    harness.knowledgeBase.pollErrors = [new Error('a'), new Error('b'), new Error('c')];

    await expect(
      waitForIngestionJob(job('STARTING'), harness.clock.now() + 600_000, ingestionDeps(harness))
    ).rejects.toThrow('c');
  });
});
