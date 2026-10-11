import {
  BUSY_ERROR_NAMES,
  INGESTION_JOB_DESCRIPTION,
  createBedrockKnowledgeBase,
  createDynamoMaterialFileRepository,
  createS3ObjectStore,
  type CommandClass,
  type SdkClientLike,
} from './awsAdapters';

/**
 * Task 4.6 — AWS SDK v3-shaped adapters, exercised with fake clients and
 * command classes: request shapes, pagination, and error mapping.
 *
 * Validates: Requirements 7.6
 */

interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

/** A command class that remembers its name and input, like the SDK's. */
function commandClass<TInput>(name: string): CommandClass<TInput> {
  return class {
    readonly commandName = name;

    constructor(readonly input: TInput) {}
  };
}

type Responder = (command: SentCommand) => unknown;

/** A client whose `send` records the command and answers via `respond`. */
function fakeClient(respond: Responder): SdkClientLike & { sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  return {
    sent,
    async send(command: unknown) {
      const { commandName, input } = command as { commandName: string; input: Record<string, unknown> };
      const entry = { name: commandName, input };
      sent.push(entry);
      const result = respond(entry);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function awsError(name: string, httpStatusCode?: number): Error {
  const error = new Error(`${name} raised`);
  error.name = name;
  if (httpStatusCode !== undefined) {
    Object.assign(error, { $metadata: { httpStatusCode } });
  }
  return error;
}

function s3Sdk(respond: Responder) {
  const client = fakeClient(respond);
  return {
    client,
    sdk: {
      client,
      HeadObjectCommand: commandClass('HeadObjectCommand'),
      PutObjectCommand: commandClass('PutObjectCommand'),
      DeleteObjectCommand: commandClass('DeleteObjectCommand'),
    },
  };
}

function dynamoSdk(respond: Responder) {
  const client = fakeClient(respond);
  return {
    client,
    sdk: {
      client,
      QueryCommand: commandClass('QueryCommand'),
      UpdateItemCommand: commandClass('UpdateItemCommand'),
    },
  };
}

function bedrockSdk(respond: Responder) {
  const client = fakeClient(respond);
  return {
    client,
    sdk: {
      client,
      StartIngestionJobCommand: commandClass('StartIngestionJobCommand'),
      GetIngestionJobCommand: commandClass('GetIngestionJobCommand'),
      ListIngestionJobsCommand: commandClass('ListIngestionJobsCommand'),
      GetKnowledgeBaseDocumentsCommand: commandClass('GetKnowledgeBaseDocumentsCommand'),
      DeleteKnowledgeBaseDocumentsCommand: commandClass('DeleteKnowledgeBaseDocumentsCommand'),
    },
  };
}

const TABLE = { tableName: 'MaterialFile-abc123-dev', studentIndexName: 'byStudent' };
const DATA_SOURCE = { knowledgeBaseId: 'KB12345678', dataSourceId: 'DS12345678' };

describe('S3 object store adapter', () => {
  it('returns the object metadata from HeadObject', async () => {
    const { client, sdk } = s3Sdk(() => ({ Metadata: { studentid: 'sub-1', folderpath: 'A/B' } }));

    const head = await createS3ObjectStore(sdk).headObject('bucket', 'private/id/materials/a.pdf');

    expect(head).toEqual({ metadata: { studentid: 'sub-1', folderpath: 'A/B' } });
    expect(client.sent).toEqual([
      { name: 'HeadObjectCommand', input: { Bucket: 'bucket', Key: 'private/id/materials/a.pdf' } },
    ]);
  });

  it('maps a missing object to null and rethrows other errors', async () => {
    await expect(createS3ObjectStore(s3Sdk(() => awsError('NotFound', 404)).sdk).headObject('b', 'k')).resolves.toBeNull();
    await expect(createS3ObjectStore(s3Sdk(() => awsError('Unknown', 404)).sdk).headObject('b', 'k')).resolves.toBeNull();
    await expect(
      createS3ObjectStore(s3Sdk(() => awsError('AccessDenied', 403)).sdk).headObject('b', 'k')
    ).rejects.toThrow('AccessDenied');
  });

  it('writes the sidecar with PutObject', async () => {
    const { client, sdk } = s3Sdk(() => ({}));

    await createS3ObjectStore(sdk).putObject('bucket', 'k.metadata.json', '{}', 'application/json');

    expect(client.sent).toEqual([
      {
        name: 'PutObjectCommand',
        input: { Bucket: 'bucket', Key: 'k.metadata.json', Body: '{}', ContentType: 'application/json' },
      },
    ]);
  });

  it('deletes the sidecar with DeleteObject and rethrows its errors (task 4.1)', async () => {
    const { client, sdk } = s3Sdk(() => ({}));

    await createS3ObjectStore(sdk).deleteObject('bucket', 'k.metadata.json');

    expect(client.sent).toEqual([
      { name: 'DeleteObjectCommand', input: { Bucket: 'bucket', Key: 'k.metadata.json' } },
    ]);
    await expect(
      createS3ObjectStore(s3Sdk(() => awsError('AccessDenied', 403)).sdk).deleteObject('b', 'k')
    ).rejects.toThrow('AccessDenied');
  });
});

describe('DynamoDB MaterialFile repository adapter', () => {
  it('queries the byStudent index for the exact key, following pagination', async () => {
    const pages = [
      {
        Items: [
          {
            id: { S: 'file-1' },
            studentId: { S: 'sub-1' },
            s3Key: { S: 'k' },
            owner: { S: 'sub-1::me' },
            indexingStatus: { S: 'PENDING' },
          },
          { studentId: { S: 'sub-1' }, s3Key: { S: 'k' } },
        ],
        LastEvaluatedKey: { id: { S: 'file-1' }, studentId: { S: 'sub-1' } },
      },
      {
        Items: [{ id: { S: 'file-2' }, studentId: { S: 'sub-1' }, s3Key: { S: 'k' }, owner: { NULL: true } }],
      },
    ];
    const { client, sdk } = dynamoSdk(() => pages.shift());

    const records = await createDynamoMaterialFileRepository(sdk, TABLE).findByS3Key('sub-1', 'k');

    expect(records).toEqual([
      { id: 'file-1', studentId: 'sub-1', s3Key: 'k', owner: 'sub-1::me', indexingStatus: 'PENDING' },
      { id: 'file-2', studentId: 'sub-1', s3Key: 'k', owner: null, indexingStatus: null },
    ]);
    expect(client.sent).toHaveLength(2);
    expect(client.sent[0]).toEqual({
      name: 'QueryCommand',
      input: {
        TableName: 'MaterialFile-abc123-dev',
        IndexName: 'byStudent',
        KeyConditionExpression: '#studentId = :studentId',
        FilterExpression: '#s3Key = :s3Key',
        ProjectionExpression: '#id, #studentId, #s3Key, #owner, #indexingStatus',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#studentId': 'studentId',
          '#s3Key': 's3Key',
          '#owner': 'owner',
          '#indexingStatus': 'indexingStatus',
        },
        ExpressionAttributeValues: { ':studentId': { S: 'sub-1' }, ':s3Key': { S: 'k' } },
      },
    });
    expect(client.sent[1].input.ExclusiveStartKey).toEqual({ id: { S: 'file-1' }, studentId: { S: 'sub-1' } });
  });

  it('updates the status of an existing record that still points at the key only', async () => {
    const { client, sdk } = dynamoSdk(() => ({}));

    const updated = await createDynamoMaterialFileRepository(sdk, TABLE).updateIndexingStatus(
      'file-1',
      'INDEXING',
      '2024-05-01T12:00:00.000Z',
      'private/id/materials/a.pdf'
    );

    expect(updated).toBe(true);
    expect(client.sent).toEqual([
      {
        name: 'UpdateItemCommand',
        input: {
          TableName: 'MaterialFile-abc123-dev',
          Key: { id: { S: 'file-1' } },
          UpdateExpression: 'SET #indexingStatus = :status, #updatedAt = :updatedAt',
          // Task 4.1: a record moved/renamed while indexing must not get this run's verdict.
          ConditionExpression: 'attribute_exists(#id) AND #s3Key = :s3Key',
          ExpressionAttributeNames: {
            '#id': 'id',
            '#s3Key': 's3Key',
            '#indexingStatus': 'indexingStatus',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':status': { S: 'INDEXING' },
            ':updatedAt': { S: '2024-05-01T12:00:00.000Z' },
            ':s3Key': { S: 'private/id/materials/a.pdf' },
          },
        },
      },
    ]);
  });

  it('reports a deleted (or re-pointed) record as not updated and rethrows other errors', async () => {
    const deleted = dynamoSdk(() => awsError('ConditionalCheckFailedException', 400));
    await expect(
      createDynamoMaterialFileRepository(deleted.sdk, TABLE).updateIndexingStatus('gone', 'INDEXED', 'now', 'k')
    ).resolves.toBe(false);

    const throttled = dynamoSdk(() => awsError('ProvisionedThroughputExceededException', 400));
    await expect(
      createDynamoMaterialFileRepository(throttled.sdk, TABLE).updateIndexingStatus('file-1', 'INDEXED', 'now', 'k')
    ).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});

describe('Bedrock Knowledge Base adapter', () => {
  it('starts a sync of the configured data source', async () => {
    const startedAt = new Date('2024-05-01T12:00:05.000Z');
    const { client, sdk } = bedrockSdk(() => ({
      ingestionJob: { ingestionJobId: 'JOB1', status: 'STARTING', startedAt },
    }));

    const result = await createBedrockKnowledgeBase(sdk, DATA_SOURCE).startIngestionJob();

    expect(result).toEqual({
      started: true,
      job: {
        ingestionJobId: 'JOB1',
        status: 'STARTING',
        startedAtMs: startedAt.getTime(),
        failureReasons: [],
        numberOfDocumentsFailed: undefined,
      },
    });
    expect(client.sent).toEqual([
      {
        name: 'StartIngestionJobCommand',
        input: { ...DATA_SOURCE, description: INGESTION_JOB_DESCRIPTION },
      },
    ]);
  });

  it.each(BUSY_ERROR_NAMES)('reports %s from StartIngestionJob as busy', async (name) => {
    const { sdk } = bedrockSdk(() => awsError(name));
    await expect(createBedrockKnowledgeBase(sdk, DATA_SOURCE).startIngestionJob()).resolves.toEqual({
      started: false,
      reason: name,
    });
  });

  it('rethrows non-retryable StartIngestionJob errors', async () => {
    const { sdk } = bedrockSdk(() => awsError('ResourceNotFoundException'));
    await expect(createBedrockKnowledgeBase(sdk, DATA_SOURCE).startIngestionJob()).rejects.toThrow(
      'ResourceNotFoundException'
    );
  });

  it('reads job status, failure reasons and statistics', async () => {
    const { client, sdk } = bedrockSdk(() => ({
      ingestionJob: {
        ingestionJobId: 'JOB1',
        status: 'COMPLETE',
        startedAt: '2024-05-01T12:00:05.000Z',
        failureReasons: ['s3://b/k: too large'],
        statistics: { numberOfDocumentsFailed: 1 },
      },
    }));

    const job = await createBedrockKnowledgeBase(sdk, DATA_SOURCE).getIngestionJob('JOB1');

    expect(job).toEqual({
      ingestionJobId: 'JOB1',
      status: 'COMPLETE',
      startedAtMs: Date.parse('2024-05-01T12:00:05.000Z'),
      failureReasons: ['s3://b/k: too large'],
      numberOfDocumentsFailed: 1,
    });
    expect(client.sent[0]).toEqual({
      name: 'GetIngestionJobCommand',
      input: { ...DATA_SOURCE, ingestionJobId: 'JOB1' },
    });
  });

  it('lists running syncs of the data source', async () => {
    const { client, sdk } = bedrockSdk(() => ({
      ingestionJobSummaries: [
        { ingestionJobId: 'JOB2', status: 'IN_PROGRESS', startedAt: new Date(5_000) },
        { status: 'IN_PROGRESS' },
      ],
    }));

    const jobs = await createBedrockKnowledgeBase(sdk, DATA_SOURCE).listActiveIngestionJobs();

    expect(jobs).toEqual([
      expect.objectContaining({ ingestionJobId: 'JOB2', status: 'IN_PROGRESS', startedAtMs: 5_000 }),
    ]);
    expect(client.sent[0]).toEqual({
      name: 'ListIngestionJobsCommand',
      input: {
        ...DATA_SOURCE,
        filters: [{ attribute: 'STATUS', operator: 'EQ', values: ['STARTING', 'IN_PROGRESS'] }],
        sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
        maxResults: 10,
      },
    });
  });

  it('reads the per-document status by S3 URI', async () => {
    const answers: unknown[] = [{ documentDetails: [{ status: 'INDEXED' }] }, { documentDetails: [] }];
    const { client, sdk } = bedrockSdk(() => answers.shift());
    const knowledgeBase = createBedrockKnowledgeBase(sdk, DATA_SOURCE);

    await expect(knowledgeBase.getDocumentStatus('s3://b/private/id/materials/a b.pdf')).resolves.toBe('INDEXED');
    await expect(knowledgeBase.getDocumentStatus('s3://b/missing.pdf')).resolves.toBeNull();
    expect(client.sent[0]).toEqual({
      name: 'GetKnowledgeBaseDocumentsCommand',
      input: {
        ...DATA_SOURCE,
        documentIdentifiers: [{ dataSourceType: 'S3', s3: { uri: 's3://b/private/id/materials/a b.pdf' } }],
      },
    });
  });
});

/**
 * Task 4.1 — direct Knowledge Base deletion for removed Materials documents.
 *
 * Validates: Requirements 7.8
 */
describe('Bedrock Knowledge Base adapter — direct document deletion', () => {
  const URI = 's3://b/private/id/materials/Week 3/a b.pdf';

  it('deletes one S3 document by URI and returns the status Bedrock reports', async () => {
    const { client, sdk } = bedrockSdk(() => ({ documentDetails: [{ status: 'DELETING' }] }));

    await expect(createBedrockKnowledgeBase(sdk, DATA_SOURCE).deleteDocument(URI)).resolves.toEqual({
      outcome: 'accepted',
      status: 'DELETING',
    });
    expect(client.sent).toEqual([
      {
        name: 'DeleteKnowledgeBaseDocumentsCommand',
        input: { ...DATA_SOURCE, documentIdentifiers: [{ dataSourceType: 'S3', s3: { uri: URI } }] },
      },
    ]);
  });

  it('reports an accepted deletion without document details as status null', async () => {
    const { sdk } = bedrockSdk(() => ({}));
    await expect(createBedrockKnowledgeBase(sdk, DATA_SOURCE).deleteDocument(URI)).resolves.toEqual({
      outcome: 'accepted',
      status: null,
    });
  });

  it.each(BUSY_ERROR_NAMES)('reports %s from DeleteKnowledgeBaseDocuments as busy', async (name) => {
    const { sdk } = bedrockSdk(() => awsError(name));
    await expect(createBedrockKnowledgeBase(sdk, DATA_SOURCE).deleteDocument(URI)).resolves.toEqual({
      outcome: 'busy',
      reason: name,
    });
  });

  it('maps ResourceNotFoundException to not-found and ValidationException to rejected', async () => {
    await expect(
      createBedrockKnowledgeBase(bedrockSdk(() => awsError('ResourceNotFoundException')).sdk, DATA_SOURCE).deleteDocument(URI)
    ).resolves.toEqual({ outcome: 'not-found', reason: 'ResourceNotFoundException' });
    await expect(
      createBedrockKnowledgeBase(bedrockSdk(() => awsError('ValidationException')).sdk, DATA_SOURCE).deleteDocument(URI)
    ).resolves.toEqual({ outcome: 'rejected', reason: 'ValidationException: ValidationException raised' });
  });

  it('rethrows other errors, such as a missing IAM permission', async () => {
    const { sdk } = bedrockSdk(() => awsError('AccessDeniedException'));
    await expect(createBedrockKnowledgeBase(sdk, DATA_SOURCE).deleteDocument(URI)).rejects.toThrow(
      'AccessDeniedException'
    );
  });
});
