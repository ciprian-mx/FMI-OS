/**
 * Shared Materials Knowledge Base retrieval (Task 4.9, Requirements 1.5, 7.9,
 * 14.4). Every Lambda that reads the Knowledge Base (ragOrchestrator,
 * fileSearchHandler, sessionGenerator, roadmapGenerator, ...) goes through
 * this module:
 *
 *   // composition root (lambda.ts), SDK injected by src/index.js
 *   const knowledgeBase = createBedrockKnowledgeBaseRetriever(sdk.bedrockAgentRuntime, {
 *     knowledgeBaseId: config.knowledgeBaseId,
 *   });
 *
 *   // core; studentId is the verified Cognito sub, never client input
 *   const { results } = await retrieveForStudent(
 *     knowledgeBase,
 *     { studentId, query: message, numberOfResults: 20 },
 *     { logger }
 *   );
 *   const citations = toCitations(results); // "Data Structures > Week 3 > Sorting.pdf"
 */
export { RetrievalRequestError } from './errors';
export type { RetrievalRequestErrorReason } from './errors';

export {
  BEDROCK_PAGE_NUMBER_KEY,
  BEDROCK_SOURCE_URI_KEY,
  DISPLAY_PATH_SEPARATOR,
  FOLDER_PATH_SEPARATOR,
  MATERIAL_METADATA_KEYS,
  ROOT_FOLDER_PATH,
  folderSegmentsOf,
  formatCitationPath,
  formatFolderDisplayPath,
  parseMaterialsObjectKey,
  parseMaterialsS3Uri,
  parseS3Uri,
  toMetadataFolderPath,
} from './materialMetadata';
export type { MaterialMetadataAttributes, MaterialsDocumentPath } from './materialMetadata';

export {
  STUDENT_ID_FILTER_KEY,
  assertValidStudentId,
  isStudentScopedFilter,
  isValidStudentId,
  normalizeRetrievalFilter,
  studentIsolationFilter,
  withStudentIsolation,
} from './retrievalFilter';
export type {
  FilterAttribute,
  FilterValue,
  RetrievalFilter,
  StudentIsolationFilter,
} from './retrievalFilter';

export type {
  KnowledgeBaseResult,
  KnowledgeBaseRetrievalPort,
  KnowledgeBaseRetrieveRequest,
  KnowledgeBaseRetrieveResponse,
  RetrievalLogger,
  SearchType,
} from './ports';

export {
  MAX_NUMBER_OF_RESULTS,
  buildStudentRetrieveRequest,
  isResultOwnedBy,
  retrieveForStudent,
} from './retrieveForStudent';
export type {
  RetrieveForStudentOptions,
  StudentRetrieval,
  StudentRetrievalRequest,
} from './retrieveForStudent';

export {
  DEFAULT_EXCERPT_MAX_LENGTH,
  resolveDocumentPath,
  toCitation,
  toCitations,
} from './citations';
export type {
  CitationOptions,
  DocumentPathSource,
  MaterialCitation,
  ResolvedDocumentPath,
} from './citations';

export { KNOWLEDGE_BASE_ID_PATTERN, createBedrockKnowledgeBaseRetriever } from './bedrockRetriever';
export type {
  BedrockAgentRuntimeSdk,
  BedrockKnowledgeBaseRetrieverOptions,
  RetrieveCommandInput,
} from './bedrockRetriever';
