/**
 * Student data isolation — the data-access layer (Task 1.8, Requirement 1.5).
 *
 * The design doc enforces the `studentId` isolation invariant (Property 2) at
 * three layers:
 *
 *   1. AppSync `@auth(rules: [{ allow: owner }])` — the GraphQL transformer
 *      injects an owner filter on every query/mutation/subscription so a signed
 *      in student only ever sees rows whose `owner` is their Cognito `sub`.
 *      (`amplify/backend/api/fmios/schema.graphql`)
 *   2. DynamoDB `studentId` partition key + `byStudent` secondary index — the
 *      backend Lambdas list a single student's records by querying that index,
 *      so a query for student A physically cannot return student B's rows.
 *   3. Amplify Storage (S3) per-student prefix
 *      `private/${cognito-identity.amazonaws.com:sub}/*` — a student can only
 *      read/write/list objects under their own identity prefix.
 *      (`amplify/backend/storage/fmiosStorage/override.ts`)
 *
 * No live AWS backend exists in the test environment, so this module models the
 * isolation *logic* as a small, pure, in-memory repository that mirrors those
 * three semantics faithfully:
 *
 *   - Every record carries both an `owner` (Cognito `sub`) and a `studentId`.
 *     In production these are the same value; here we keep them distinct fields
 *     so the model mirrors the schema exactly and the owner filter is explicit.
 *   - Reads are always performed *as* an authenticated student. The repository
 *     applies the owner filter (layer 1) AND the `byStudent` key filter
 *     (layer 2) before returning anything — the intersection of what the API
 *     and the data store would each allow.
 *   - A direct fetch by record id is denied unless the record also belongs to
 *     the authenticated student, mirroring how `@auth owner` rejects a
 *     `getX(id)` for someone else's row (returns `null`, never another
 *     student's data).
 *   - S3 object keys are built under the per-student prefix (layer 3) and an
 *     access check rejects any key outside the caller's own prefix.
 *
 * This gives Property 2 a concrete, testable surface: for any set of students
 * and records, a query authenticated as student A returns only A's records and
 * never references another student's data.
 */

/** The data categories a student owns, mirroring the design's isolation list. */
export type DataType =
  | 'Materials'
  | 'Progress'
  | 'Examinations'
  | 'Timetable'
  | 'Stats'
  | 'Roadmap'
  | 'Sessions';

/** All known data categories (useful for generators and exhaustive checks). */
export const DATA_TYPES: readonly DataType[] = [
  'Materials',
  'Progress',
  'Examinations',
  'Timetable',
  'Stats',
  'Roadmap',
  'Sessions',
];

/**
 * A persisted record in the model store.
 *
 * `owner` is the Cognito `sub` the AppSync `@auth owner` rule filters on;
 * `studentId` is the DynamoDB partition key / `byStudent` index value. In FMI
 * OS both equal the signed-in student's `sub`; keeping them as separate fields
 * lets the model express each isolation layer independently.
 */
export interface StudentRecord {
  /** Globally unique record id (the DynamoDB sort key / GraphQL `id`). */
  id: string;
  /** AppSync `@auth owner` — the Cognito `sub` that owns the row. */
  owner: string;
  /** DynamoDB partition key / `byStudent` index value. */
  studentId: string;
  /** Which data category this record belongs to. */
  dataType: DataType;
  /** Opaque payload; irrelevant to isolation but present for realism. */
  payload?: unknown;
}

/** Thrown when a caller attempts to touch an S3 key outside their own prefix. */
export class CrossStudentAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossStudentAccessError';
  }
}

/**
 * In-memory data-access layer modelling the three isolation layers.
 *
 * Construct with the full universe of records (as if seeded across many
 * students), then perform every read *as* a specific authenticated student.
 */
export class StudentDataRepository {
  private readonly records: StudentRecord[];

  constructor(records: readonly StudentRecord[] = []) {
    // Defensive copy so external mutation cannot bypass the isolation checks.
    this.records = records.map((r) => ({ ...r }));
  }

  /**
   * The combined owner + `byStudent` predicate. A record is visible to the
   * authenticated student only when BOTH isolation layers agree it belongs to
   * them. This is the heart of the invariant: layer 1 (owner) and layer 2
   * (studentId key) must both match the caller.
   */
  private visibleTo(record: StudentRecord, authStudentId: string): boolean {
    return record.owner === authStudentId && record.studentId === authStudentId;
  }

  /**
   * List all records of `dataType` visible to the authenticated student.
   *
   * Mirrors a `byStudent`-indexed GraphQL list query under `@auth owner`: the
   * result can only ever contain the caller's own rows.
   */
  queryStudentData(authStudentId: string, dataType: DataType): StudentRecord[] {
    return this.records
      .filter((r) => r.dataType === dataType && this.visibleTo(r, authStudentId))
      .map((r) => ({ ...r }));
  }

  /**
   * List every record (across all data types) visible to the authenticated
   * student. Convenience for the "never references another student's data"
   * half of Property 2.
   */
  queryAllForStudent(authStudentId: string): StudentRecord[] {
    return this.records
      .filter((r) => this.visibleTo(r, authStudentId))
      .map((r) => ({ ...r }));
  }

  /**
   * Fetch a single record by id *as* the authenticated student.
   *
   * Returns the record only when it belongs to the caller; otherwise `null`.
   * This mirrors how `@auth owner` turns a `getX(id)` for someone else's row
   * into an empty result — a student can never pull another student's record
   * even when they know its exact id.
   */
  getRecordById(authStudentId: string, recordId: string): StudentRecord | null {
    const found = this.records.find((r) => r.id === recordId);
    if (!found || !this.visibleTo(found, authStudentId)) {
      return null;
    }
    return { ...found };
  }
}

/**
 * The S3 per-student prefix (layer 3). Matches the policy variable used by the
 * storage override: `private/{cognito-identity-sub}/...`.
 */
export function studentStoragePrefix(authStudentId: string): string {
  return `private/${authStudentId}/`;
}

/**
 * Builds the S3 object key for one of a student's materials, always rooted at
 * that student's own prefix. There is no parameter that would let a caller aim
 * the key at another student's prefix.
 */
export function buildStorageKey(authStudentId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '');
  return `${studentStoragePrefix(authStudentId)}${clean}`;
}

/**
 * Guards a storage access the way the IAM `private/${sub}/*` policy does:
 * returns true only when `objectKey` sits under the authenticated student's own
 * prefix. Keys targeting any other student's prefix are rejected.
 */
export function canAccessStorageKey(authStudentId: string, objectKey: string): boolean {
  return objectKey.startsWith(studentStoragePrefix(authStudentId));
}

/**
 * Reads a storage key as the authenticated student, enforcing the per-student
 * prefix. Throws {@link CrossStudentAccessError} for any key outside the
 * caller's prefix — the model equivalent of an S3 `AccessDenied`.
 */
export function accessStorageKey(authStudentId: string, objectKey: string): string {
  if (!canAccessStorageKey(authStudentId, objectKey)) {
    throw new CrossStudentAccessError(
      `Student ${authStudentId} may not access object outside their own prefix`
    );
  }
  return objectKey;
}
