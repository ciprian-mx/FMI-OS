import { FakeClock, RecordingLogger, s3Event } from './__tests__/fakes';
import type { CommandClass, SdkClientLike } from './awsAdapters';
import { ConfigError } from './config';
import { createLambdaHandler, type AwsSdkBag } from './lambda';

/**
 * Task 4.6 — the composed Lambda handler, end to end through the SDK-shaped
 * adapters with fake AWS clients: S3 event in, Knowledge Base sync and
 * MaterialFile status updates out.
 *
 * Validates: Requirements 7.6
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
function fakeAws() {
  const calls: string[] = [];
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
    HeadObjectCommand: () => ({ Metadata: { studentid: STUDENT, folderpath: 'Week 3' } }),
    PutObjectCommand: (input) => {
      sidecars[input.Key] = input.Body;
      return {};
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
    GetKnowledgeBaseDocumentsCommand: () => ({ documentDetails: [{ status: 'INDEXED' }] }),
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
    },
  };

  return { sdk, calls, statuses, sidecars };
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
});
