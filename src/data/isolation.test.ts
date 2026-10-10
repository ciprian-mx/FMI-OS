import fc from 'fast-check';
import {
  CrossStudentAccessError,
  DATA_TYPES,
  DataType,
  StudentDataRepository,
  StudentRecord,
  accessStorageKey,
  buildStorageKey,
  canAccessStorageKey,
  studentStoragePrefix,
} from './isolation';

/**
 * Task 1.8 — student data isolation.
 *
 * Feature: fmi-os, Property 2: Student Data Isolation.
 *
 * Property 2 (design.md): *For any* two distinct student IDs A and B, no query,
 * mutation, or retrieval operation authenticated as student A SHALL return,
 * modify, or reference any data belonging to student B (Materials, Progress,
 * Examinations, Timetable, Stats, Roadmap, Sessions, Knowledge Base chunks).
 *
 * The isolation invariant is enforced at three layers — AppSync `@auth owner`,
 * the DynamoDB `studentId` partition key / `byStudent` index, and the S3
 * per-student prefix. Since no live AWS backend exists under test, the pure
 * data-access model in `./isolation` mirrors those semantics and these tests
 * exercise the invariant over arbitrary students and records.
 *
 * Both plain unit tests (concrete seeded examples and edge cases) and
 * property-based tests (≥ 100 iterations over arbitrary inputs) are provided.
 *
 * Validates: Requirements 1.5
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const dataTypeArb: fc.Arbitrary<DataType> = fc.constantFrom(...DATA_TYPES);

/**
 * Produces a universe of records spread across a pool of students. Each record
 * is a faithful FMI OS row: owner === studentId (both the Cognito `sub`), as
 * the real schema stamps them. We build records *from* a student id so the two
 * fields are always consistent, exactly as production data would be.
 */
function recordsForStudents(studentIds: string[]): fc.Arbitrary<StudentRecord[]> {
  if (studentIds.length === 0) {
    return fc.constant<StudentRecord[]>([]);
  }
  const ownerArb = fc.constantFrom(...studentIds);
  return fc.array(
    fc.record({
      id: fc.uuid(),
      owner: ownerArb,
      dataType: dataTypeArb,
      payload: fc.anything(),
    }),
    { minLength: 0, maxLength: 50 }
  ).map((rows) =>
    rows.map((r) => ({
      id: r.id,
      owner: r.owner,
      // studentId mirrors owner — the Cognito sub drives both isolation layers.
      studentId: r.owner,
      dataType: r.dataType,
      payload: r.payload,
    }))
  );
}

// ---------------------------------------------------------------------------
// Unit tests — concrete examples and edge cases
// ---------------------------------------------------------------------------

describe('StudentDataRepository (unit)', () => {
  const A = 'student-a';
  const B = 'student-b';

  const seed: StudentRecord[] = [
    { id: 'a1', owner: A, studentId: A, dataType: 'Materials' },
    { id: 'a2', owner: A, studentId: A, dataType: 'Stats' },
    { id: 'b1', owner: B, studentId: B, dataType: 'Materials' },
    { id: 'b2', owner: B, studentId: B, dataType: 'Roadmap' },
  ];

  it('returns only the caller’s records for a data type', () => {
    const repo = new StudentDataRepository(seed);
    const result = repo.queryStudentData(A, 'Materials');
    expect(result.map((r) => r.id)).toEqual(['a1']);
    expect(result.every((r) => r.studentId === A)).toBe(true);
  });

  it('returns an empty list when the caller has no records of that type', () => {
    const repo = new StudentDataRepository(seed);
    expect(repo.queryStudentData(A, 'Roadmap')).toEqual([]);
  });

  it('never surfaces another student’s rows in queryAllForStudent', () => {
    const repo = new StudentDataRepository(seed);
    const all = repo.queryAllForStudent(A);
    expect(all.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    expect(all.some((r) => r.studentId === B || r.owner === B)).toBe(false);
  });

  it('denies a direct fetch of another student’s record by id', () => {
    const repo = new StudentDataRepository(seed);
    // Student A knows B's exact record id but still cannot retrieve it.
    expect(repo.getRecordById(A, 'b1')).toBeNull();
    // ...while A can fetch their own.
    expect(repo.getRecordById(A, 'a1')?.id).toBe('a1');
  });

  it('returns null for an unknown record id', () => {
    const repo = new StudentDataRepository(seed);
    expect(repo.getRecordById(A, 'does-not-exist')).toBeNull();
  });

  it('cannot be mutated through a returned record (defensive copy)', () => {
    const repo = new StudentDataRepository(seed);
    const [row] = repo.queryStudentData(A, 'Materials');
    row.studentId = B;
    // A fresh query is unaffected by the external mutation.
    expect(repo.queryStudentData(A, 'Materials')[0].studentId).toBe(A);
  });
});

describe('S3 per-student prefix (unit)', () => {
  it('builds keys under the caller’s own prefix', () => {
    expect(buildStorageKey('student-a', 'materials/notes.pdf')).toBe(
      'private/student-a/materials/notes.pdf'
    );
  });

  it('allows access to the caller’s own prefix and denies others', () => {
    expect(canAccessStorageKey('student-a', 'private/student-a/x.pdf')).toBe(true);
    expect(canAccessStorageKey('student-a', 'private/student-b/x.pdf')).toBe(false);
  });

  it('throws CrossStudentAccessError for a foreign prefix', () => {
    expect(() => accessStorageKey('student-a', 'private/student-b/x.pdf')).toThrow(
      CrossStudentAccessError
    );
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — the Property 2 invariant over arbitrary inputs
// ---------------------------------------------------------------------------

describe('Property 2: student data isolation', () => {
  it('a query authenticated as A never returns data belonging to B', () => {
    // Build two distinct students plus any number of bystanders, then seed a
    // universe of records owned across that pool. Querying as A for any data
    // type must never surface a row referencing B.
    const scenarioArb = fc
      .record({
        studentA: fc.uuid(),
        studentB: fc.uuid(),
        others: fc.array(fc.uuid(), { maxLength: 4 }),
        dataType: dataTypeArb,
      })
      .filter((s) => s.studentA !== s.studentB)
      .chain((s) =>
        recordsForStudents([s.studentA, s.studentB, ...s.others]).map(
          (records) => ({ ...s, records })
        )
      );

    fc.assert(
      fc.property(scenarioArb, ({ studentA, studentB, dataType, records }) => {
        const repo = new StudentDataRepository(records);

        const dataForA = repo.queryStudentData(studentA, dataType);

        // Every returned row belongs to A — and in particular none to B.
        const referencesB = dataForA.some(
          (item) => item.studentId === studentB || item.owner === studentB
        );
        const allBelongToA = dataForA.every(
          (item) => item.studentId === studentA && item.owner === studentA
        );

        return !referencesB && allBelongToA;
      }),
      { numRuns: 100 }
    );
  });

  it('a query returns exactly the records seeded for the caller (no omissions, no extras)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 5 }).chain((students) =>
          recordsForStudents(students).map(
            (records) => [students, records] as [string[], StudentRecord[]]
          )
        ),
        ([students, records]) => {
          const repo = new StudentDataRepository(records);

          for (const student of students) {
            for (const dataType of DATA_TYPES) {
              const expected = records
                .filter(
                  (r) =>
                    r.owner === student &&
                    r.studentId === student &&
                    r.dataType === dataType
                )
                .map((r) => r.id)
                .sort();
              const actual = repo
                .queryStudentData(student, dataType)
                .map((r) => r.id)
                .sort();
              expect(actual).toEqual(expected);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('a direct fetch of another student’s record id is always denied', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 5 }).chain((students) =>
          recordsForStudents(students).map(
            (records) => [students, records] as [string[], StudentRecord[]]
          )
        ),
        ([students, records]) => {
          fc.pre(records.length > 0);
          const repo = new StudentDataRepository(records);

          // For each record, any student who is NOT its owner must be denied,
          // and the owner must be granted.
          return records.every((rec) =>
            students.every((caller) => {
              const fetched = repo.getRecordById(caller, rec.id);
              if (caller === rec.owner) {
                return fetched !== null && fetched.id === rec.id;
              }
              // A non-owner must never retrieve the record nor see its studentId.
              return fetched === null;
            })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('S3 keys are reachable only under the caller’s own prefix', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.string({ minLength: 1 }).filter((s) => !s.includes('\u0000')),
        (studentA, studentB, relPath) => {
          fc.pre(studentA !== studentB);

          const ownKey = buildStorageKey(studentA, relPath);
          const foreignKey = buildStorageKey(studentB, relPath);

          // A can reach their own key but never B's prefix.
          const ownOk =
            canAccessStorageKey(studentA, ownKey) &&
            accessStorageKey(studentA, ownKey) === ownKey;

          const foreignDenied = !canAccessStorageKey(studentA, foreignKey);

          let threw = false;
          try {
            accessStorageKey(studentA, foreignKey);
          } catch (e) {
            threw = e instanceof CrossStudentAccessError;
          }

          const prefixCorrect = ownKey.startsWith(studentStoragePrefix(studentA));

          return ownOk && foreignDenied && threw && prefixCorrect;
        }
      ),
      { numRuns: 100 }
    );
  });
});
