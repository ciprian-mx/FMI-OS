'use strict';

/**
 * materialIndexTrigger: S3 ObjectCreated / ObjectRemoved trigger for FMI OS
 * Materials (Task 4.6, Requirement 7.6; deletion propagation: Task 4.1,
 * Requirement 7.8).
 *
 * Composition root only. It builds the AWS SDK v3 clients and hands them to the
 * tested TypeScript core in src/backend/materialIndexTrigger/, compiled to
 * ./core/ by `node amplify/scripts/build-functions.js` (run automatically by
 * amplify/hooks/pre-push.js). See amplify/README.md, "Backend function
 * convention".
 */
const {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const {
  BedrockAgentClient,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
  ListIngestionJobsCommand,
  GetKnowledgeBaseDocumentsCommand,
  DeleteKnowledgeBaseDocumentsCommand,
} = require('@aws-sdk/client-bedrock-agent');

const { createLambdaHandler } = loadCore();

/** Created on the first invocation and reused while the container is warm. */
let handleS3Event;

exports.handler = async (event, context) => {
  if (!handleS3Event) {
    handleS3Event = createLambdaHandler({
      env: process.env,
      sdk: {
        s3: { client: new S3Client({}), HeadObjectCommand, PutObjectCommand, DeleteObjectCommand },
        dynamodb: { client: new DynamoDBClient({}), QueryCommand, UpdateItemCommand },
        bedrockAgent: {
          client: new BedrockAgentClient({}),
          StartIngestionJobCommand,
          GetIngestionJobCommand,
          ListIngestionJobsCommand,
          GetKnowledgeBaseDocumentsCommand,
          DeleteKnowledgeBaseDocumentsCommand,
        },
      },
    });
  }
  return handleS3Event(event, context);
};

function loadCore() {
  try {
    return require('./core/materialIndexTrigger/lambda');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'materialIndexTrigger: the compiled core is missing from this package. Run ' +
          '`node amplify/scripts/build-functions.js materialIndexTrigger` before deploying ' +
          '(amplify/hooks/pre-push.js does this on `amplify push`). Cause: ' +
          error.message
      );
    }
    throw error;
  }
}
