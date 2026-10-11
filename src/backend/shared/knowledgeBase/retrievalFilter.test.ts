import { RetrievalRequestError } from './errors';
import {
  isStudentScopedFilter,
  normalizeRetrievalFilter,
  studentIsolationFilter,
  withStudentIsolation,
  type RetrievalFilter,
} from './retrievalFilter';

/**
 * Task 4.9 — the student-isolation filter every Knowledge Base query carries.
 *
 * Validates: Requirements 1.5, 7.9, 14.4
 */

const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const OTHER = '9e8d7c6b-1111-4222-8333-444455556666';
const ISOLATION = { equals: { key: 'studentId', value: STUDENT } };

function reasonOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof RetrievalRequestError ? error.reason : `not a RetrievalRequestError: ${String(error)}`;
  }
  return undefined;
}

describe('studentIsolationFilter', () => {
  it('is an equals filter on the studentId attribute', () => {
    expect(studentIsolationFilter(STUDENT)).toEqual(ISOLATION);
  });

  it.each([[''], ['   '], ['\n\t'], [undefined], [null], [42]])(
    'rejects the blank or missing student id %p',
    (studentId) => {
      expect(reasonOf(() => studentIsolationFilter(studentId as string))).toBe('invalid-student-id');
    }
  );
});

describe('withStudentIsolation', () => {
  it('sends the isolation clause alone when the caller has no filter', () => {
    expect(withStudentIsolation(STUDENT)).toEqual(ISOLATION);
    expect(withStudentIsolation(STUDENT, null)).toEqual(ISOLATION);
  });

  it('ANDs a caller filter after the isolation clause', () => {
    const caller: RetrievalFilter = { startsWith: { key: 'folderPath', value: 'Data Structures/' } };
    expect(withStudentIsolation(STUDENT, caller)).toEqual({ andAll: [ISOLATION, caller] });
  });

  it('cannot be widened or replaced by a caller filter that names another student', () => {
    const caller: RetrievalFilter = {
      orAll: [
        { equals: { key: 'studentId', value: OTHER } },
        { notEquals: { key: 'studentId', value: STUDENT } },
      ],
    };
    const combined = withStudentIsolation(STUDENT, caller);
    expect(combined).toEqual({ andAll: [ISOLATION, caller] });
    expect(isStudentScopedFilter(combined, STUDENT)).toBe(true);
    expect(isStudentScopedFilter(combined, OTHER)).toBe(false);
  });

  it('copies the caller filter, so later changes to it do not reach the request', () => {
    const caller = { in: { key: 'fileName', value: ['a.pdf', 'b.pdf'] } };
    const combined = withStudentIsolation(STUDENT, caller) as { andAll: RetrievalFilter[] };
    caller.in.value.push('c.pdf');
    caller.in.key = 'studentId';
    expect(combined.andAll[1]).toEqual({ in: { key: 'fileName', value: ['a.pdf', 'b.pdf'] } });
  });

  it('drops fields Bedrock does not read', () => {
    const caller = { equals: { key: 'fileName', value: 'a.pdf', note: 'x' } } as unknown as RetrievalFilter;
    expect(withStudentIsolation(STUDENT, caller)).toEqual({
      andAll: [ISOLATION, { equals: { key: 'fileName', value: 'a.pdf' } }],
    });
  });

  it.each([
    ['an array', []],
    ['an empty object', {}],
    ['two operators in one object', { equals: { key: 'a', value: 1 }, notEquals: { key: 'b', value: 2 } }],
    ['an unknown operator', { matches: { key: 'a', value: 'b' } }],
    ['an andAll with one member', { andAll: [{ equals: { key: 'a', value: 1 } }] }],
    ['an orAll that is not a list', { orAll: { equals: { key: 'a', value: 1 } } }],
    ['an attribute without a key', { equals: { value: 'a' } }],
    ['an empty attribute key', { equals: { key: '', value: 'a' } }],
    ['a missing value', { equals: { key: 'a' } }],
    ['an object value', { equals: { key: 'a', value: { nested: true } } }],
    ['a non-finite number', { greaterThan: { key: 'a', value: Number.NaN } }],
    ['a malformed nested member', { andAll: [{ equals: { key: 'a', value: 1 } }, { bogus: 1 }] }],
  ])('rejects %s', (_label, caller) => {
    expect(reasonOf(() => withStudentIsolation(STUDENT, caller as unknown as RetrievalFilter))).toBe(
      'invalid-filter'
    );
  });

  it('rejects a blank student id even with a caller filter', () => {
    expect(
      reasonOf(() => withStudentIsolation(' ', { equals: { key: 'fileName', value: 'a.pdf' } }))
    ).toBe('invalid-student-id');
  });

  it('reports where a nested filter is malformed without echoing values', () => {
    expect(() =>
      normalizeRetrievalFilter({ andAll: [{ equals: { key: 'a', value: 'secret' } }, { equals: { key: '' } }] })
    ).toThrow('Invalid Knowledge Base filter: filter.andAll[1].equals.key must be a non-empty string');
  });
});

describe('isStudentScopedFilter', () => {
  it('accepts the clause alone or as a member of a top-level andAll', () => {
    expect(isStudentScopedFilter(ISOLATION, STUDENT)).toBe(true);
    expect(
      isStudentScopedFilter({ andAll: [{ equals: { key: 'fileName', value: 'a' } }, ISOLATION] }, STUDENT)
    ).toBe(true);
  });

  it.each([
    ['another student', { equals: { key: 'studentId', value: OTHER } }],
    ['a different key', { equals: { key: 'owner', value: STUDENT } }],
    ['notEquals', { notEquals: { key: 'studentId', value: STUDENT } }],
    ['the clause under orAll', { orAll: [ISOLATION, { equals: { key: 'fileName', value: 'a' } }] }],
    [
      'the clause nested below the top level',
      { andAll: [{ orAll: [ISOLATION, ISOLATION] }, { equals: { key: 'fileName', value: 'a' } }] },
    ],
    ['an ambiguous object', { equals: ISOLATION.equals, orAll: [] }],
    ['no filter', undefined],
  ])('rejects %s', (_label, filter) => {
    expect(isStudentScopedFilter(filter, STUDENT)).toBe(false);
  });

  it('never accepts a blank student id', () => {
    expect(isStudentScopedFilter({ equals: { key: 'studentId', value: '' } }, '')).toBe(false);
  });
});
