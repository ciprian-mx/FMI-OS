import { FakeClock, RecordingLogger, s3Event } from './__tests__/fakes';
import type { CommandClass, SdkClientLike } from './awsAdapters';
import { ConfigError } from './config';
import { createLambdaHandler, type AwsSdkBag } from './lambda';

/**
 * Task 4.6 — the composed Lambda handler, end to end through the SDK-shaped
 * adapters with fake AWS clients: S3 event in, Knowledge Base sync and
 * MaterialFile status updates out; and (task 4.1) S3 removal in, Knowledge Base
 * deletion and sidecar cleanup out.
 *
 * Validates: Requirements 7.6, 7.8
 */

const BUCKET = 'fmios-materials-storage-dev';
const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const KEY = 'private/eu-central-1:7d3c1f3e-1111-4222-8333-444455556666/materials/Week 3/Sorting.pdf';

const ENV = {
  KNOWLEDGE_BASE_ID: 'KB12345678',
  DATA_SOURCE_ID: 'DS12345678',
  API_FMIOS_MATERIALFILETABLE_NAME: 'MaterialFile-abc123-dev',
};

function commandClass<TInput>(name: string): CommandClass<TInput> {
  return class {
    readonly commandName = name;

    constructor(readonly input: TInput) {}
  };
}

/** One fake "AWS" behind all three clients, answering by command name. */
function fakeAws(options: { objectExists?: boolean } = {}) {
  const calls: string[] = [];
  const deletedObjects: string[] = [];
  let deletedFromKnowledgeBase = false;
  const item: Record<string, { S?: string }> = {
    id: { S: 'file-1' },
    studentId: { S: STUDENT },
    s3Key: { S: KEY },
    owner: { S: `${STUDENT}::student@s.unibuc.ro` },
    indexingStatus: { S: 'PENDING' },
  };
  const statuses: string[] = [];
  const sidecars: Record<string, string> = {};
  let polls = 0;

  const handlers: Record<string, (input: Record<string, any>) => unknown> = {
    HeadObjectCommand: () => {
      if (options.objectExists === false) {
        throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      }
      return { Metadata: { studentid: STUDENT, folderpath: 'Week 3' } };
    },
    PutObjectCommand: (input) => {
      sidecars[input.Key] = input.Body;
      return {};
    },
    DeleteObjectCommand: (input) => {
      deletedObjects.push(input.Key);
      return {};
    },
    DeleteKnowledgeBaseDocumentsCommand: () => {
      deletedFromKnowledgeBase = true;
      return { documentDetails: [{ status: 'DELETING' }] };
    },
    QueryCommand: () => ({ Items: [item] }),
    UpdateItemCommand: (input) => {
      const status = input.ExpressionAttributeValues[':status'].S;
      item.indexingStatus = { S: status };
      statuses.push(status);
      return {};
    },
    StartIngestionJobCommand: () => ({ ingestionJob: { ingestionJobId: 'JOB1', status: 'STARTING' } }),
    GetIngestionJobCommand: () => {
      polls += 1;
      return { ingestionJob: { ingestionJobId: 'JOB1', status: polls < 2 ? 'IN_PROGRESS' : 'COMPLETE' } };
    },
    ListIngestionJobsCommand: () => ({ ingestionJobSummaries: [] }),
    GetKnowledgeBaseDocumentsCommand: () => ({
      documentDetails: [{ status: deletedFromKnowledgeBase ? 'NOT_FOUND' : 'INDEXED' }],
    }),
  };

  const client: SdkClientLike = {
    async send(command: unknown) {
      const { commandName, input } = command as { commandName: string; input: Record<string, any> };
      calls.push(commandName);
      return handlers[commandName](input);
    },
  };

  const sdk: AwsSdkBag = {
    s3: {
      client,
      HeadObjectCommand: commandClass('HeadObjectCommand'),
      PutObjectCommand: commandClass('PutObjectCommand'),
      DeleteObjectCommand: commandClass('DeleteObjectCommand'),
    },
    dynamodb: {
      client,
      QueryCommand: commandClass('QueryCommand'),
      UpdateItemCommand: commandClass('UpdateItemCommand'),
    },
    bedrockAgent: {
      client,
      StartIngestionJobCommand: commandClass('StartIngestionJobCommand'),
      GetIngestionJobCommand: commandClass('GetIngestionJobCommand'),
      ListIngestionJobsCommand: commandClass('ListIngestionJobsCommand'),
      GetKnowledgeBaseDocumentsCommand: commandClass('GetKnowledgeBaseDocumentsCommand'),
      DeleteKnowledgeBaseDocumentsCommand: commandClass('DeleteKnowledgeBaseDocumentsCommand'),
    },
  };

  return { sdk, calls, statuses, sidecars, deletedObjects };
}

describe('createLambdaHandler', () => {
  it('indexes an uploaded material end to end through the AWS adapters', async () => {
    const aws = fakeAws();
    const handler = createLambdaHandler({
      env: ENV,
      sdk: aws.sdk,
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    });

    const result = await handler(s3Event(KEY, { bucket: BUCKET }), {
      getRemainingTimeInMillis: () => 900_000,
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: 'completed', status: 'INDEXED', ingestionJobId: 'JOB1' }),
    ]);
    expect(aws.statuses).toEqual(['INDEXING', 'INDEXED']);
    expect(JSON.parse(aws.sidecars[`${KEY}.metadata.json`])).toEqual({
      metadataAttributes: { studentId: STUDENT, folderPath: 'Week 3', fileName: 'Sorting.pdf' },
    });
    expect(aws.calls).toEqual([
      'HeadObjectCommand',
      'QueryCommand',
      'PutObjectCommand',
      'StartIngestionJobCommand',
      'UpdateItemCommand',
      'GetIngestionJobCommand',
      'GetIngestionJobCommand',
      'GetKnowledgeBaseDocumentsCommand',
      'QueryCommand',
      'UpdateItemCommand',
    ]);
  });

  it('refuses to start without its configuration', () => {
    expect(() => createLambdaHandler({ env: {}, sdk: fakeAws().sdk })).toThrow(ConfigError);
  });

  // Task 4.1 — Requirement 7.8: a deleted (or moved-away) material leaves the Knowledge Base.
  it('removes a deleted material from the Knowledge Base end to end through the AWS adapters', async () => {
    const aws = fakeAws({ objectExists: false });
    const handler = createLambdaHandler({
      env: ENV,
      sdk: aws.sdk,
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    });

    const result = await handler(s3Event(KEY, { bucket: BUCKET, eventName: 'ObjectRemoved:Delete' }), {
      getRemainingTimeInMillis: () => 900_000,
    });

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
    expect(aws.deletedObjects).toEqual([`${KEY}.metadata.json`]);
    expect(aws.calls).toEqual([
      'HeadObjectCommand',
      'DeleteKnowledgeBaseDocumentsCommand',
      'DeleteObjectCommand',
      'GetKnowledgeBaseDocumentsCommand',
      'ListIngestionJobsCommand',
    ]);
    // No MaterialFile writes: the Materials app deletes or re-points the rows itself.
    expect(aws.statuses).toEqual([]);
  });
});
