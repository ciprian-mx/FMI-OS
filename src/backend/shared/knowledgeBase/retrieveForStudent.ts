/**
 * Student-scoped Knowledge Base retrieval (Task 4.9, Requirements 1.5, 7.9, 14.4).
 *
 * The only sanctioned way for a Lambda to query the Materials Knowledge Base.
 * It
 *
 *   1. rejects a missing or blank `studentId` before anything is sent;
 *   2. always sends `{ equals: { key: "studentId", value: studentId } }`,
 *      combined with any caller filter as `{ andAll: [isolation, callerFilter] }`;
 *      there is no option to replace or drop the clause;
 *   3. drops every returned chunk whose `studentId` metadata is not exactly
 *      the caller's (defence in depth against a mis-configured vector store or
 *      data source). Untagged chunks are dropped too.
 *
 * `studentId` must be the verified identity of the caller (the Cognito `sub`
 * from the AppSync/Lambda identity), never an id taken from client input.
 */
import { RetrievalRequestError } from './errors';
import { MATERIAL_METADATA_KEYS } from './materialMetadata';
import type {
  KnowledgeBaseResult,
  KnowledgeBaseRetrievalPort,
  KnowledgeBaseRetrieveRequest,
  RetrievalLogger,
  SearchType,
} from './ports';
import {
  assertValidStudentId,
  isValidStudentId,
  withStudentIsolation,
  type RetrievalFilter,
} from './retrievalFilter';

/** Bedrock's limit for `numberOfResults`. */
export const MAX_NUMBER_OF_RESULTS = 100;

const SEARCH_TYPES: readonly string[] = ['HYBRID', 'SEMANTIC'];

export interface StudentRetrievalRequest {
  /** Verified owner of the Materials to search (Cognito `sub`). */
  studentId: string;
  /** Natural-language query text. */
  query: string;
  /** Extra filter, ANDed with the isolation clause. It can only narrow the results. */
  filter?: RetrievalFilter | null;
  /** 1 to {@link MAX_NUMBER_OF_RESULTS}; Bedrock returns 5 when omitted. */
  numberOfResults?: number;
  searchType?: SearchType;
  /** `nextToken` of a previous {@link StudentRetrieval}, to fetch the next page. */
  nextToken?: string | null;
}

export interface StudentRetrieval {
  studentId: string;
  /** The returned chunks that are tagged with `studentId`, in Bedrock's order. */
  results: KnowledgeBaseResult[];
  nextToken: string | null;
  /** Chunks the post-filter removed (not tagged with `studentId`). Normally 0. */
  droppedCount: number;
}

export interface RetrieveForStudentOptions {
  /** Receives a warning whenever the post-filter drops chunks. */
  logger?: RetrievalLogger;
}

/** Queries the Knowledge Base on behalf of one student. */
export async function retrieveForStudent(
  knowledgeBase: KnowledgeBaseRetrievalPort,
  request: StudentRetrievalRequest,
  options: RetrieveForStudentOptions = {}
): Promise<StudentRetrieval> {
  const scoped = buildStudentRetrieveRequest(request);
  const response = await knowledgeBase.retrieve(scoped);
  const returned = Array.isArray(response?.results) ? response.results : [];
  const results = returned.filter((result) => isResultOwnedBy(result, scoped.studentId));
  const droppedCount = returned.length - results.length;
  if (droppedCount > 0) {
    // Counts only: never log another student's id, path or content.
    options.logger?.warn('Dropped Knowledge Base results outside the student scope', {
      studentId: scoped.studentId,
      droppedCount,
      returnedCount: returned.length,
    });
  }
  const nextToken = typeof response?.nextToken === 'string' ? response.nextToken : null;
  return { studentId: scoped.studentId, results, nextToken, droppedCount };
}

/**
 * Validates a {@link StudentRetrievalRequest} and turns it into the port
 * request: only the known fields are copied and the filter is always
 * `withStudentIsolation(studentId, request.filter)`.
 */
export function buildStudentRetrieveRequest(
  request: StudentRetrievalRequest
): KnowledgeBaseRetrieveRequest {
  if (typeof request !== 'object' || request === null) {
    throw invalidRequest('the request must be an object');
  }
  const { studentId, query, filter, numberOfResults, searchType, nextToken } = request;
  assertValidStudentId(studentId);
  if (typeof query !== 'string') {
    throw invalidRequest('query must be a string');
  }
  if (
    numberOfResults !== undefined &&
    !(
      Number.isInteger(numberOfResults) &&
      numberOfResults >= 1 &&
      numberOfResults <= MAX_NUMBER_OF_RESULTS
    )
  ) {
    throw invalidRequest(`numberOfResults must be an integer from 1 to ${MAX_NUMBER_OF_RESULTS}`);
  }
  if (searchType !== undefined && !SEARCH_TYPES.includes(searchType)) {
    throw invalidRequest('searchType must be HYBRID or SEMANTIC');
  }
  if (
    nextToken !== undefined &&
    nextToken !== null &&
    (typeof nextToken !== 'string' || nextToken === '')
  ) {
    throw invalidRequest('nextToken must be a non-empty string');
  }

  const scoped: KnowledgeBaseRetrieveRequest = {
    studentId,
    queryText: query,
    filter: withStudentIsolation(studentId, filter),
  };
  if (numberOfResults !== undefined) {
    scoped.numberOfResults = numberOfResults;
  }
  if (searchType !== undefined) {
    scoped.searchType = searchType;
  }
  if (typeof nextToken === 'string') {
    scoped.nextToken = nextToken;
  }
  return scoped;
}

/** Whether a chunk's `studentId` metadata is exactly `studentId` (never for a blank id). */
export function isResultOwnedBy(result: KnowledgeBaseResult, studentId: string): boolean {
  if (!isValidStudentId(studentId)) {
    return false;
  }
  const metadata = result?.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return false;
  }
  const owner = metadata[MATERIAL_METADATA_KEYS.studentId];
  return typeof owner === 'string' && owner === studentId;
}

function invalidRequest(problem: string): RetrievalRequestError {
  return new RetrievalRequestError('invalid-request', `Invalid Knowledge Base request: ${problem}`);
}
