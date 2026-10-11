/**
 * Knowledge Base metadata filters and the student-isolation rule (Task 4.9,
 * Requirements 1.5, 7.9, 14.4).
 *
 * Every retrieval is scoped with
 *
 *   { equals: { key: "studentId", value: <studentId> } }
 *
 * A caller's own filter is never sent on its own: it becomes the second member
 * of a top-level `andAll` whose first member is the isolation clause, so it can
 * narrow a student's results but never widen or replace the scope.
 */
import { RetrievalRequestError } from './errors';
import { MATERIAL_METADATA_KEYS } from './materialMetadata';

/** Metadata key the isolation clause matches on. */
export const STUDENT_ID_FILTER_KEY = MATERIAL_METADATA_KEYS.studentId;

/** A filter operand (a JSON value Bedrock accepts). */
export type FilterValue = string | number | boolean | readonly (string | number)[];

export interface FilterAttribute {
  key: string;
  value: FilterValue;
}

/**
 * Structural copy of the Bedrock Agent Runtime `RetrievalFilter` union: an
 * object with exactly one operator. `andAll` / `orAll` need at least two members.
 */
export type RetrievalFilter =
  | { equals: FilterAttribute }
  | { notEquals: FilterAttribute }
  | { greaterThan: FilterAttribute }
  | { greaterThanOrEquals: FilterAttribute }
  | { lessThan: FilterAttribute }
  | { lessThanOrEquals: FilterAttribute }
  | { in: FilterAttribute }
  | { notIn: FilterAttribute }
  | { startsWith: FilterAttribute }
  | { listContains: FilterAttribute }
  | { stringContains: FilterAttribute }
  | { andAll: readonly RetrievalFilter[] }
  | { orAll: readonly RetrievalFilter[] };

/** The isolation clause for one student. */
export interface StudentIsolationFilter {
  equals: { key: typeof STUDENT_ID_FILTER_KEY; value: string };
}

const ATTRIBUTE_OPERATORS: readonly string[] = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEquals',
  'lessThan',
  'lessThanOrEquals',
  'in',
  'notIn',
  'startsWith',
  'listContains',
  'stringContains',
];

const GROUP_OPERATORS: readonly string[] = ['andAll', 'orAll'];

/** True for a string with at least one non-whitespace character. */
export function isValidStudentId(studentId: unknown): studentId is string {
  return typeof studentId === 'string' && studentId.trim() !== '';
}

/** Throws `RetrievalRequestError('invalid-student-id')` unless the id is a non-blank string. */
export function assertValidStudentId(studentId: unknown): asserts studentId is string {
  if (!isValidStudentId(studentId)) {
    throw new RetrievalRequestError(
      'invalid-student-id',
      'Knowledge Base retrieval needs a non-blank studentId'
    );
  }
}

/** `{ equals: { key: "studentId", value: studentId } }`. Rejects blank ids. */
export function studentIsolationFilter(studentId: string): StudentIsolationFilter {
  assertValidStudentId(studentId);
  return { equals: { key: STUDENT_ID_FILTER_KEY, value: studentId } };
}

/**
 * The filter to send for `studentId`: the isolation clause alone, or
 * `{ andAll: [isolationClause, callerFilter] }`. The caller filter is validated
 * and copied, so later changes to the caller's object do not reach the request.
 */
export function withStudentIsolation(
  studentId: string,
  callerFilter?: RetrievalFilter | null
): RetrievalFilter {
  const isolation = studentIsolationFilter(studentId);
  if (callerFilter === undefined || callerFilter === null) {
    return isolation;
  }
  return { andAll: [isolation, normalizeRetrievalFilter(callerFilter)] };
}

/**
 * Whether `filter` restricts results to `studentId`: it is the isolation
 * clause itself or a top-level `andAll` with the clause as a member. A clause
 * nested under `orAll` (or deeper) does not count.
 */
export function isStudentScopedFilter(filter: unknown, studentId: unknown): boolean {
  if (!isValidStudentId(studentId) || !isPlainObject(filter)) {
    return false;
  }
  if (isIsolationClause(filter, studentId)) {
    return true;
  }
  const operators = Object.keys(filter);
  if (operators.length !== 1 || operators[0] !== 'andAll') {
    return false;
  }
  const members = filter.andAll;
  return Array.isArray(members) && members.some((member) => isIsolationClause(member, studentId));
}

/**
 * Validates a caller-supplied filter and returns a deep copy holding only the
 * fields Bedrock reads. Throws `RetrievalRequestError('invalid-filter')`.
 */
export function normalizeRetrievalFilter(filter: unknown, path = 'filter'): RetrievalFilter {
  if (!isPlainObject(filter)) {
    throw invalidFilter(path, 'must be an object with exactly one operator');
  }
  const operators = Object.keys(filter);
  if (operators.length !== 1) {
    throw invalidFilter(path, `must have exactly one operator (found ${operators.length})`);
  }
  const [operator] = operators;
  const operand = filter[operator];
  if (GROUP_OPERATORS.includes(operator)) {
    if (!Array.isArray(operand) || operand.length < 2) {
      throw invalidFilter(`${path}.${operator}`, 'must be a list of at least 2 filters');
    }
    const members = operand.map((member, index) =>
      normalizeRetrievalFilter(member, `${path}.${operator}[${index}]`)
    );
    return operator === 'andAll' ? { andAll: members } : { orAll: members };
  }
  if (ATTRIBUTE_OPERATORS.includes(operator)) {
    return { [operator]: normalizeAttribute(operand, `${path}.${operator}`) } as RetrievalFilter;
  }
  throw invalidFilter(path, `uses an unknown operator "${operator}"`);
}

function isIsolationClause(filter: unknown, studentId: string): boolean {
  if (!isPlainObject(filter)) {
    return false;
  }
  const operators = Object.keys(filter);
  if (operators.length !== 1 || operators[0] !== 'equals') {
    return false;
  }
  const attribute = filter.equals;
  return (
    isPlainObject(attribute) &&
    attribute.key === STUDENT_ID_FILTER_KEY &&
    attribute.value === studentId
  );
}

function normalizeAttribute(operand: unknown, path: string): FilterAttribute {
  if (!isPlainObject(operand)) {
    throw invalidFilter(path, 'must be an object with "key" and "value"');
  }
  const { key, value } = operand;
  if (typeof key !== 'string' || key === '') {
    throw invalidFilter(`${path}.key`, 'must be a non-empty string');
  }
  return { key, value: normalizeValue(value, `${path}.value`) };
}

function normalizeValue(value: unknown, path: string): FilterValue {
  if (typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value)) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' || isFiniteNumber(item))
  ) {
    return [...value] as (string | number)[];
  }
  throw invalidFilter(path, 'must be a string, a finite number, a boolean or a list of those');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidFilter(path: string, problem: string): RetrievalRequestError {
  return new RetrievalRequestError('invalid-filter', `Invalid Knowledge Base filter: ${path} ${problem}`);
}
