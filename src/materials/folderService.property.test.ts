import fc from 'fast-check';
import { createFolderService, type FolderService, type MaterialsOperationReport } from './folderService';
import { FakeMaterialsBackend } from './testing/fakeMaterialsBackend';
import { STUDENT_A, seedFixture, studentBState } from './testing/materialsFixture';

/**
 * Task 4.1 — partial-failure behaviour of the folder service (property tests).
 *
 * Any write or object call of a cascading operation may fail. For every
 * operation on the fixture hierarchy and every set of failing calls:
 *
 *   - the report is complete exactly when no call failed;
 *   - an incomplete operation leaves its commit point untouched (the folder's
 *     or file's name / parent, or, for a delete, the topmost row);
 *   - an incomplete rename / move never leaves a row pointing at a missing
 *     object;
 *   - re-running the same operation once completes it, and the final state
 *     equals that of a run without failures;
 *   - re-running a completed rename / move writes nothing;
 *   - the other student's rows and objects never change.
 *
 * This checks resumability against a fault-free run, not the hierarchy
 * semantics themselves (Property 11, task 4.8).
 *
 * Validates: Requirements 7.2, 7.8
 */

type Operation = {
  label: string;
  kind: 'relocate' | 'delete';
  /** The row whose adjacency is the commit point (or that a delete removes last). */
  target: { table: 'folders' | 'files'; id: string };
  run: (service: FolderService) => Promise<MaterialsOperationReport>;
};

const OPERATIONS: Operation[] = [
  {
    label: 'rename a top folder',
    kind: 'relocate',
    target: { table: 'folders', id: 'ds' },
    run: (s) => s.renameFolder(STUDENT_A, 'ds', 'DS'),
  },
  {
    label: 'rename a nested folder',
    kind: 'relocate',
    target: { table: 'folders', id: 'w3' },
    run: (s) => s.renameFolder(STUDENT_A, 'w3', 'Week Three'),
  },
  {
    label: 'move a folder to another parent',
    kind: 'relocate',
    target: { table: 'folders', id: 'w3' },
    run: (s) => s.moveFolder(STUDENT_A, 'w3', 'algo'),
  },
  {
    label: 'move a top folder below another',
    kind: 'relocate',
    target: { table: 'folders', id: 'ds' },
    run: (s) => s.moveFolder(STUDENT_A, 'ds', 'algo'),
  },
  {
    label: 'promote a folder to the root',
    kind: 'relocate',
    target: { table: 'folders', id: 'lab' },
    run: (s) => s.moveFolder(STUDENT_A, 'lab', null),
  },
  {
    label: 'rename a file',
    kind: 'relocate',
    target: { table: 'files', id: 'f-sort' },
    run: (s) => s.renameFile(STUDENT_A, 'f-sort', 'Sorting v2.pdf'),
  },
  {
    label: 'move a file',
    kind: 'relocate',
    target: { table: 'files', id: 'f-heap' },
    run: (s) => s.moveFile(STUDENT_A, 'f-heap', 'algo'),
  },
  {
    label: 'move a file to the root',
    kind: 'relocate',
    target: { table: 'files', id: 'f-lab1' },
    run: (s) => s.moveFile(STUDENT_A, 'f-lab1', null),
  },
  {
    label: 'delete a nested folder',
    kind: 'delete',
    target: { table: 'folders', id: 'w3' },
    run: (s) => s.deleteFolder(STUDENT_A, 'w3'),
  },
  {
    label: 'delete a top folder',
    kind: 'delete',
    target: { table: 'folders', id: 'ds' },
    run: (s) => s.deleteFolder(STUDENT_A, 'ds'),
  },
  {
    label: 'delete a file',
    kind: 'delete',
    target: { table: 'files', id: 'f-graphs' },
    run: (s) => s.deleteFile(STUDENT_A, 'f-graphs'),
  },
];

function world(concurrency: number) {
  const backend = seedFixture(new FakeMaterialsBackend());
  const service = createFolderService({
    data: backend,
    objects: backend,
    now: () => new Date('2024-05-01T12:00:00.000Z'),
    concurrency,
  });
  return { backend, service };
}

/** The commit-point fields of the target row (undefined once it is gone). */
function commitPoint(backend: FakeMaterialsBackend, target: Operation['target']): unknown {
  if (target.table === 'folders') {
    const row = backend.folders.get(target.id);
    return row && { name: row.name, parentId: row.parentId };
  }
  const row = backend.files.get(target.id);
  return row && { name: row.name, folderId: row.folderId };
}

describe('folderService — failures are reported and a re-run resumes (property)', () => {
  it('completes on a re-run with the same result as a run without failures', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...OPERATIONS),
        // Ordinals of the calls that fail on the first attempt (writes and object calls).
        fc.uniqueArray(fc.nat({ max: 24 }), { maxLength: 3 }),
        fc.constantFrom(1, 4),
        async (operation, failing, concurrency) => {
          const reference = world(concurrency);
          const expected = await operation.run(reference.service);
          expect(expected.complete).toBe(true);

          const { backend, service } = world(concurrency);
          const studentB = studentBState(backend);
          const before = commitPoint(backend, operation.target);
          backend.failAt = new Set(failing);

          const first = await operation.run(service);

          expect(first.complete).toBe(backend.failedCalls.length === 0);
          expect(first.failures).toHaveLength(backend.failedCalls.length);
          if (!first.complete) {
            expect(commitPoint(backend, operation.target)).toEqual(before);
            if (operation.kind === 'relocate') {
              for (const row of backend.files.values()) {
                expect(backend.objects.has(row.s3Key)).toBe(true);
              }
            }
          }

          backend.clearFaults();
          if (!first.complete) {
            const resumed = await operation.run(service);
            expect(resumed).toEqual(expect.objectContaining({ complete: true, failures: [] }));
          }
          expect(backend.snapshot()).toEqual(reference.backend.snapshot());

          if (operation.kind === 'relocate') {
            const writes = backend.trace.length;
            const again = await operation.run(service);
            expect(again.complete).toBe(true);
            expect(backend.trace).toHaveLength(writes);
          }
          expect(studentBState(backend)).toEqual(studentB);
        }
      ),
      { numRuns: 150 }
    );
  });
});
