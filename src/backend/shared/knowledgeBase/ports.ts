/**
 * Port of the shared Knowledge Base retrieval module (Task 4.9).
 *
 * Lambdas never call this port directly: they go through
 * `retrieveForStudent`, which builds a request whose filter always carries the
 * student-isolation clause. The production adapter
 * (`createBedrockKnowledgeBaseRetriever`) re-checks that clause before it
 * sends anything; tests use in-memory fakes (`__tests__/fakes.ts`).
 */
import type { RetrievalFilter } from './retrievalFilter';

/** Bedrock's `overrideSearchType` values. */
export type SearchType = 'HYBRID' | 'SEMANTIC';

/** One Retrieve call, already scoped to a student. */
export interface KnowledgeBaseRetrieveRequest {
  /** The student the request is scoped to; `filter` must contain their isolation clause. */
  studentId: string;
  queryText: string;
  filter: RetrievalFilter;
  /** 1 to 100; Bedrock returns 5 when omitted. */
  numberOfResults?: number;
  searchType?: SearchType;
  /** Page token from a previous response. */
  nextToken?: string;
}

/** One retrieved chunk, as reported by the Knowledge Base. */
export interface KnowledgeBaseResult {
  /** Chunk text ("" for non-text content). */
  text: string;
  /** `s3://bucket/key` of the source document, or `null` for other locations. */
  s3Uri: string | null;
  /** Relevance score, when reported. */
  score: number | null;
  /**
   * Chunk metadata: the sidecar's custom attributes (`studentId`, `folderPath`,
   * `fileName`) plus Bedrock's own `x-amz-bedrock-kb-*` attributes.
   */
  metadata: Readonly<Record<string, unknown>>;
}

export interface KnowledgeBaseRetrieveResponse {
  results: KnowledgeBaseResult[];
  nextToken: string | null;
}

/** The Bedrock Knowledge Base `Retrieve` operation. */
export interface KnowledgeBaseRetrievalPort {
  retrieve(request: KnowledgeBaseRetrieveRequest): Promise<KnowledgeBaseRetrieveResponse>;
}

/** The logging the module needs (compatible with the Lambdas' structured loggers). */
export interface RetrievalLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}
