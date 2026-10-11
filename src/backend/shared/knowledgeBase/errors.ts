/**
 * Errors of the shared Knowledge Base retrieval module (Task 4.9).
 */

export type RetrievalRequestErrorReason =
  /** The student id is missing, not a string, or blank. */
  | 'invalid-student-id'
  /** A caller-supplied metadata filter is malformed. */
  | 'invalid-filter'
  /** A request reached the Knowledge Base adapter without the isolation filter. */
  | 'unscoped-filter'
  /** Another request field (query, result count, search type, page token) is invalid. */
  | 'invalid-request';

/**
 * A retrieval request was refused before anything was sent to Bedrock. The
 * message never contains filter values or query text.
 */
export class RetrievalRequestError extends Error {
  readonly reason: RetrievalRequestErrorReason;

  constructor(reason: RetrievalRequestErrorReason, message: string) {
    super(message);
    this.name = 'RetrievalRequestError';
    this.reason = reason;
  }
}
