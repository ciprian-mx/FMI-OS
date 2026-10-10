/**
 * Production adapters for the `materialIndexTrigger` ports (Task 4.6).
 *
 * They are written against the *shape* of the AWS SDK for JavaScript v3
 * (`client.send(new XCommand(input))`) instead of importing it: the Lambda entry
 * point (`amplify/backend/function/materialIndexTrigger/src/index.js`) injects
 * the real clients and command classes, and tests inject recording fakes. That
 * keeps the request shapes and the error mapping under the repo's typecheck and
 * Jest without adding the SDK to the web app's dependencies.
 */
import type {
  IndexingStatus,
  IngestionJob,
  KnowledgeBasePort,
  MaterialFileRecord,
  MaterialFileRepository,
  ObjectStorePort,
  StartIngestionResult,
} from './ports';

/** Any AWS SDK v3 client. */
export interface SdkClientLike {
  send(command: unknown): Promise<unknown>;
}

/** An AWS SDK v3 command class, e.g. `HeadObjectCommand`. */
export type CommandClass<TInput> = new (input: TInput) => unknown;

/** Name of an AWS SDK error (`ConflictException`, `NotFound`, ...), if any. */
export function errorName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const { name } = error as { name?: unknown };
    if (typeof name === 'string') {
      return name;
    }
  }
  return undefined;
}

function httpStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const meta = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    if (typeof meta?.httpStatusCode === 'number') {
      return meta.httpStatusCode;
    }
  }
  return undefined;
}

/* ---------------------------------- S3 ----------------------------------- */

export interface HeadObjectInput {
  Bucket: string;
  Key: string;
}

export interface PutObjectInput {
  Bucket: string;
  Key: string;
  Body: string;
  ContentType: string;
}

export interface S3Sdk {
  client: SdkClientLike;
  HeadObjectCommand: CommandClass<HeadObjectInput>;
  PutObjectCommand: CommandClass<PutObjectInput>;
}

export function createS3ObjectStore(sdk: S3Sdk): ObjectStorePort {
  return {
    async headObject(bucket, key) {
      try {
        const output = (await sdk.client.send(
          new sdk.HeadObjectCommand({ Bucket: bucket, Key: key })
        )) as { Metadata?: Record<string, string> } | undefined;
        return { metadata: { ...(output?.Metadata ?? {}) } };
      } catch (error) {
        // HeadObject has no body, so a missing key surfaces as a bare 404.
        const name = errorName(error);
        if (name === 'NotFound' || name === 'NoSuchKey' || httpStatusCode(error) === 404) {
          return null;
        }
        throw error;
      }
    },

    async putObject(bucket, key, body, contentType) {
      await sdk.client.send(
        new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
      );
    },
  };
}

/* -------------------------------- DynamoDB -------------------------------- */

/** A low-level DynamoDB attribute value (only the string form is used). */
export interface AttributeValue {
  S?: string;
  NULL?: boolean;
}

export type DynamoItem = Record<string, AttributeValue | undefined>;

export interface QueryInput {
  TableName: string;
  IndexName: string;
  KeyConditionExpression: string;
  FilterExpression: string;
  ProjectionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
  ExclusiveStartKey?: DynamoItem;
}

export interface UpdateItemInput {
  TableName: string;
  Key: Record<string, AttributeValue>;
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
}

export interface DynamoDbSdk {
  client: SdkClientLike;
  QueryCommand: CommandClass<QueryInput>;
  UpdateItemCommand: CommandClass<UpdateItemInput>;
}

export interface MaterialFileTable {
  tableName: string;
  /** The `byStudent` GSI (partition key `studentId`). */
  studentIndexName: string;
}

/**
 * `MaterialFile` access straight against the Amplify `@model` table. A direct
 * write does not fire AppSync subscriptions; the Materials app re-reads the
 * records to pick up the status.
 */
export function createDynamoMaterialFileRepository(
  sdk: DynamoDbSdk,
  table: MaterialFileTable
): MaterialFileRepository {
  return {
    async findByS3Key(studentId, s3Key) {
      const records: MaterialFileRecord[] = [];
      let exclusiveStartKey: DynamoItem | undefined;
      do {
        const input: QueryInput = {
          TableName: table.tableName,
          IndexName: table.studentIndexName,
          KeyConditionExpression: '#studentId = :studentId',
          FilterExpression: '#s3Key = :s3Key',
          ProjectionExpression: '#id, #studentId, #s3Key, #owner, #indexingStatus',
          // `owner` is a DynamoDB reserved word, so every name is aliased.
          ExpressionAttributeNames: {
            '#id': 'id',
            '#studentId': 'studentId',
            '#s3Key': 's3Key',
            '#owner': 'owner',
            '#indexingStatus': 'indexingStatus',
          },
          ExpressionAttributeValues: {
            ':studentId': { S: studentId },
            ':s3Key': { S: s3Key },
          },
        };
        if (exclusiveStartKey) {
          input.ExclusiveStartKey = exclusiveStartKey;
        }
        const output = (await sdk.client.send(new sdk.QueryCommand(input))) as
          | { Items?: DynamoItem[]; LastEvaluatedKey?: DynamoItem }
          | undefined;
        for (const item of output?.Items ?? []) {
          const record = toMaterialFileRecord(item);
          if (record) {
            records.push(record);
          }
        }
        const lastKey = output?.LastEvaluatedKey;
        exclusiveStartKey = lastKey && Object.keys(lastKey).length > 0 ? lastKey : undefined;
      } while (exclusiveStartKey);
      return records;
    },

    async updateIndexingStatus(id: string, status: IndexingStatus, updatedAt: string) {
      try {
        await sdk.client.send(
          new sdk.UpdateItemCommand({
            TableName: table.tableName,
            Key: { id: { S: id } },
            UpdateExpression: 'SET #indexingStatus = :status, #updatedAt = :updatedAt',
            // UpdateItem would otherwise upsert a stub row for a deleted record.
            ConditionExpression: 'attribute_exists(#id)',
            ExpressionAttributeNames: {
              '#id': 'id',
              '#indexingStatus': 'indexingStatus',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':status': { S: status },
              ':updatedAt': { S: updatedAt },
            },
          })
        );
        return true;
      } catch (error) {
        if (errorName(error) === 'ConditionalCheckFailedException') {
          return false;
        }
        throw error;
      }
    },
  };
}

function stringAttribute(item: DynamoItem, name: string): string | null {
  const value = item[name]?.S;
  return typeof value === 'string' ? value : null;
}

function toMaterialFileRecord(item: DynamoItem): MaterialFileRecord | null {
  const id = stringAttribute(item, 'id');
  const studentId = stringAttribute(item, 'studentId');
  const s3Key = stringAttribute(item, 's3Key');
  if (id === null || studentId === null || s3Key === null) {
    return null;
  }
  return {
    id,
    studentId,
    s3Key,
    owner: stringAttribute(item, 'owner'),
    indexingStatus: stringAttribute(item, 'indexingStatus'),
  };
}

/* ------------------------------ Bedrock Agent ----------------------------- */

interface DataSourceRef {
  knowledgeBaseId: string;
  dataSourceId: string;
}

export interface StartIngestionJobInput extends DataSourceRef {
  description: string;
}

export interface GetIngestionJobInput extends DataSourceRef {
  ingestionJobId: string;
}

export interface ListIngestionJobsInput extends DataSourceRef {
  filters: { attribute: 'STATUS'; operator: 'EQ'; values: string[] }[];
  sortBy: { attribute: 'STARTED_AT'; order: 'ASCENDING' | 'DESCENDING' };
  maxResults: number;
}

export interface GetKnowledgeBaseDocumentsInput extends DataSourceRef {
  documentIdentifiers: { dataSourceType: 'S3'; s3: { uri: string } }[];
}

export interface BedrockAgentSdk {
  client: SdkClientLike;
  StartIngestionJobCommand: CommandClass<StartIngestionJobInput>;
  GetIngestionJobCommand: CommandClass<GetIngestionJobInput>;
  ListIngestionJobsCommand: CommandClass<ListIngestionJobsInput>;
  GetKnowledgeBaseDocumentsCommand: CommandClass<GetKnowledgeBaseDocumentsInput>;
}

/**
 * `StartIngestionJob` errors that mean "try again later": a sync is already
 * running on the data source (one job per data source), or the request was
 * throttled / hit a concurrency quota / failed transiently.
 */
export const BUSY_ERROR_NAMES: readonly string[] = [
  'ConflictException',
  'ThrottlingException',
  'ServiceQuotaExceededException',
  'InternalServerException',
];

/** Description recorded on every sync this Lambda starts (no student data). */
export const INGESTION_JOB_DESCRIPTION = 'FMI OS materialIndexTrigger: sync after a Materials upload';

interface RawIngestionJob {
  ingestionJobId?: unknown;
  status?: unknown;
  startedAt?: unknown;
  failureReasons?: unknown;
  statistics?: { numberOfDocumentsFailed?: unknown };
}

function toEpochMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function toIngestionJob(raw: RawIngestionJob | undefined): IngestionJob | null {
  if (!raw || typeof raw.ingestionJobId !== 'string' || typeof raw.status !== 'string') {
    return null;
  }
  const failed = raw.statistics?.numberOfDocumentsFailed;
  return {
    ingestionJobId: raw.ingestionJobId,
    status: raw.status,
    startedAtMs: toEpochMs(raw.startedAt),
    failureReasons: Array.isArray(raw.failureReasons)
      ? raw.failureReasons.filter((reason): reason is string => typeof reason === 'string')
      : [],
    numberOfDocumentsFailed: typeof failed === 'number' ? failed : undefined,
  };
}

function requireJob(raw: RawIngestionJob | undefined, operation: string): IngestionJob {
  const job = toIngestionJob(raw);
  if (job === null) {
    throw new Error(`${operation} returned no ingestion job`);
  }
  return job;
}

export function createBedrockKnowledgeBase(
  sdk: BedrockAgentSdk,
  dataSource: DataSourceRef
): KnowledgeBasePort {
  const ref: DataSourceRef = {
    knowledgeBaseId: dataSource.knowledgeBaseId,
    dataSourceId: dataSource.dataSourceId,
  };

  return {
    async startIngestionJob(): Promise<StartIngestionResult> {
      try {
        const output = (await sdk.client.send(
          new sdk.StartIngestionJobCommand({ ...ref, description: INGESTION_JOB_DESCRIPTION })
        )) as { ingestionJob?: RawIngestionJob } | undefined;
        return { started: true, job: requireJob(output?.ingestionJob, 'StartIngestionJob') };
      } catch (error) {
        const name = errorName(error);
        if (name !== undefined && BUSY_ERROR_NAMES.includes(name)) {
          return { started: false, reason: name };
        }
        throw error;
      }
    },

    async getIngestionJob(ingestionJobId) {
      const output = (await sdk.client.send(
        new sdk.GetIngestionJobCommand({ ...ref, ingestionJobId })
      )) as { ingestionJob?: RawIngestionJob } | undefined;
      return requireJob(output?.ingestionJob, 'GetIngestionJob');
    },

    async listActiveIngestionJobs() {
      const output = (await sdk.client.send(
        new sdk.ListIngestionJobsCommand({
          ...ref,
          filters: [{ attribute: 'STATUS', operator: 'EQ', values: ['STARTING', 'IN_PROGRESS'] }],
          sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
          maxResults: 10,
        })
      )) as { ingestionJobSummaries?: RawIngestionJob[] } | undefined;
      const jobs: IngestionJob[] = [];
      for (const summary of output?.ingestionJobSummaries ?? []) {
        const job = toIngestionJob(summary);
        if (job) {
          jobs.push(job);
        }
      }
      return jobs;
    },

    async getDocumentStatus(s3Uri) {
      const output = (await sdk.client.send(
        new sdk.GetKnowledgeBaseDocumentsCommand({
          ...ref,
          documentIdentifiers: [{ dataSourceType: 'S3', s3: { uri: s3Uri } }],
        })
      )) as { documentDetails?: { status?: unknown }[] } | undefined;
      const status = output?.documentDetails?.[0]?.status;
      return typeof status === 'string' ? status : null;
    },
  };
}
