/**
 * Production adapter for the Knowledge Base retrieval port (Task 4.9): the
 * Bedrock Agent Runtime `Retrieve` operation.
 *
 * Written against the shape of the AWS SDK v3 (see `../awsSdk.ts`). A Lambda's
 * `src/index.js` injects the real client and command class:
 *
 *   const { BedrockAgentRuntimeClient, RetrieveCommand } =
 *     require('@aws-sdk/client-bedrock-agent-runtime');
 *   const knowledgeBase = createBedrockKnowledgeBaseRetriever(
 *     { client: new BedrockAgentRuntimeClient({}), RetrieveCommand },
 *     { knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID }
 *   );
 *
 * and the core queries it with `retrieveForStudent(knowledgeBase, ...)`. The
 * adapter refuses any request whose filter does not restrict the results to
 * the request's student, so even a direct call cannot skip the isolation
 * clause. The function's role needs `bedrock:Retrieve` on the knowledge base.
 */
import type { CommandClass, SdkClientLike } from '../awsSdk';
import { RetrievalRequestError } from './errors';
import type {
  KnowledgeBaseResult,
  KnowledgeBaseRetrievalPort,
  KnowledgeBaseRetrieveResponse,
  SearchType,
} from './ports';
import { isStudentScopedFilter, type RetrievalFilter } from './retrievalFilter';

/** A Knowledge Base id as the Bedrock console shows it (10 alphanumerics). */
export const KNOWLEDGE_BASE_ID_PATTERN = /^[0-9a-zA-Z]{10}$/;

/** The `RetrieveCommand` input fields this adapter sends. */
export interface RetrieveCommandInput {
  knowledgeBaseId: string;
  retrievalQuery: { text: string };
  retrievalConfiguration: {
    vectorSearchConfiguration: {
      filter: RetrievalFilter;
      numberOfResults?: number;
      overrideSearchType?: SearchType;
    };
  };
  nextToken?: string;
}

export interface BedrockAgentRuntimeSdk {
  client: SdkClientLike;
  RetrieveCommand: CommandClass<RetrieveCommandInput>;
}

export interface BedrockKnowledgeBaseRetrieverOptions {
  knowledgeBaseId: string;
}

interface RawRetrievalResult {
  content?: { text?: unknown };
  location?: { s3Location?: { uri?: unknown } };
  metadata?: unknown;
  score?: unknown;
}

interface RawRetrieveOutput {
  retrievalResults?: unknown;
  nextToken?: unknown;
}

export function createBedrockKnowledgeBaseRetriever(
  sdk: BedrockAgentRuntimeSdk,
  options: BedrockKnowledgeBaseRetrieverOptions
): KnowledgeBaseRetrievalPort {
  const knowledgeBaseId = typeof options?.knowledgeBaseId === 'string' ? options.knowledgeBaseId : '';
  if (!KNOWLEDGE_BASE_ID_PATTERN.test(knowledgeBaseId)) {
    throw new Error('knowledgeBaseId must be a 10-character alphanumeric Bedrock id');
  }

  return {
    async retrieve(request) {
      if (!isStudentScopedFilter(request?.filter, request?.studentId)) {
        throw new RetrievalRequestError(
          'unscoped-filter',
          'Refusing to query the Knowledge Base without the studentId isolation filter'
        );
      }
      const vectorSearchConfiguration: RetrieveCommandInput['retrievalConfiguration']['vectorSearchConfiguration'] =
        { filter: request.filter };
      if (request.numberOfResults !== undefined) {
        vectorSearchConfiguration.numberOfResults = request.numberOfResults;
      }
      if (request.searchType !== undefined) {
        vectorSearchConfiguration.overrideSearchType = request.searchType;
      }
      const input: RetrieveCommandInput = {
        knowledgeBaseId,
        retrievalQuery: { text: request.queryText },
        retrievalConfiguration: { vectorSearchConfiguration },
      };
      if (request.nextToken !== undefined) {
        input.nextToken = request.nextToken;
      }

      const output = (await sdk.client.send(new sdk.RetrieveCommand(input))) as
        | RawRetrieveOutput
        | undefined;
      return toResponse(output);
    },
  };
}

function toResponse(output: RawRetrieveOutput | undefined): KnowledgeBaseRetrieveResponse {
  const retrievalResults = output?.retrievalResults;
  const raw: unknown[] = Array.isArray(retrievalResults) ? retrievalResults : [];
  const nextToken = output?.nextToken;
  return {
    results: raw.map((item) => toResult(item as RawRetrievalResult | null)),
    nextToken: typeof nextToken === 'string' && nextToken !== '' ? nextToken : null,
  };
}

function toResult(raw: RawRetrievalResult | null | undefined): KnowledgeBaseResult {
  const text = raw?.content?.text;
  const uri = raw?.location?.s3Location?.uri;
  const score = raw?.score;
  const metadata = raw?.metadata;
  return {
    text: typeof text === 'string' ? text : '',
    s3Uri: typeof uri === 'string' && uri !== '' ? uri : null,
    score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    metadata:
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
        ? { ...(metadata as Record<string, unknown>) }
        : {},
  };
}
