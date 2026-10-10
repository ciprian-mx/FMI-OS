/**
 * Composition root of the `materialIndexTrigger` Lambda (Task 4.6).
 *
 * `amplify/backend/function/materialIndexTrigger/src/index.js` builds the AWS
 * SDK v3 clients and calls {@link createLambdaHandler} from the compiled copy of
 * this module (`src/core/materialIndexTrigger/lambda.js`).
 */
import {
  createBedrockKnowledgeBase,
  createDynamoMaterialFileRepository,
  createS3ObjectStore,
  type BedrockAgentSdk,
  type DynamoDbSdk,
  type S3Sdk,
} from './awsAdapters';
import { loadConfig } from './config';
import {
  handleS3Event,
  type HandleS3EventResult,
  type IndexerDeps,
  type InvocationContextLike,
  type S3EventLike,
} from './indexMaterial';
import { createConsoleLogger } from './logging';
import type { Clock, Logger } from './ports';

/** The AWS SDK v3 clients and command classes the adapters use. */
export interface AwsSdkBag {
  s3: S3Sdk;
  dynamodb: DynamoDbSdk;
  bedrockAgent: BedrockAgentSdk;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface CreateLambdaHandlerOptions {
  env: Readonly<Record<string, string | undefined>>;
  sdk: AwsSdkBag;
  logger?: Logger;
  clock?: Clock;
}

export type MaterialIndexTriggerHandler = (
  event: S3EventLike,
  context?: InvocationContextLike
) => Promise<HandleS3EventResult>;

/** Validates the environment (throws `ConfigError`) and wires the ports. */
export function createLambdaHandler(options: CreateLambdaHandlerOptions): MaterialIndexTriggerHandler {
  const config = loadConfig(options.env);
  const deps: IndexerDeps = {
    objects: createS3ObjectStore(options.sdk.s3),
    materialFiles: createDynamoMaterialFileRepository(options.sdk.dynamodb, {
      tableName: config.materialFileTableName,
      studentIndexName: config.materialFileStudentIndex,
    }),
    knowledgeBase: createBedrockKnowledgeBase(options.sdk.bedrockAgent, {
      knowledgeBaseId: config.knowledgeBaseId,
      dataSourceId: config.dataSourceId,
    }),
    clock: options.clock ?? systemClock,
    logger: options.logger ?? createConsoleLogger(),
    config: config.indexer,
  };
  return (event, context) => handleS3Event(event, deps, context);
}
