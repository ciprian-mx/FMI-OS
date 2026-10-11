/**
 * A small Materials hierarchy for the `folderService` tests (Task 4.1).
 * Not imported by the app.
 *
 * Student A:
 *
 *   Data Structures            ds     Intro.pdf
 *   ├── Week 1                 w1
 *   └── Week 3                 w3     Sorting.pdf, Heaps.md
 *       └── Lab                lab    lab1.txt
 *   Algorithms                 algo   Graphs.pdf
 *   (Knowledge Base root)             Syllabus.pdf
 *
 * Student B owns "Secret" (b-root) with "Plans" (b-child) and plan.pdf.
 */
import type { FolderNode } from '../folderHierarchy';
import type { MaterialFile } from '../MaterialsApp';
import { buildMaterialsKey, toDisplayPath } from '../uploadMaterial';
import type { FakeMaterialsBackend } from './fakeMaterialsBackend';

export const STUDENT_A = 'student-a';
export const STUDENT_B = 'student-b';

/** The `private/{identityId}/` prefixes of the two students' objects. */
export const PREFIX_A = 'private/eu-central-1:aaaa-1111/';
export const PREFIX_B = 'private/eu-central-1:bbbb-2222/';

/** Absolute key of `fileName` in the folder at `folderPath` ("/"-separated, "" for the root). */
export function keyA(folderPath: string, fileName: string): string {
  return `${PREFIX_A}${buildMaterialsKey(folderPath, fileName)}`;
}

export function folder(
  id: string,
  parentId: string | null,
  name: string,
  path: string,
  studentId: string = STUDENT_A
): FolderNode {
  return { id, studentId, name, parentId, path, createdDate: '2024-01-01T00:00:00.000Z' };
}

const FORMATS: Record<string, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
};

/** A consistent MaterialFile row: key and display path derived from `folderPath`. */
export function file(
  id: string,
  folderId: string,
  name: string,
  folderPath: string,
  options: { studentId?: string; prefix?: string; s3Key?: string } = {}
): MaterialFile {
  const extension = name.split('.').pop() ?? '';
  return {
    id,
    studentId: options.studentId ?? STUDENT_A,
    folderId,
    name,
    size: 1024,
    format: FORMATS[extension] ?? 'application/octet-stream',
    uploadDate: '2024-04-01T10:00:00.000Z',
    indexingStatus: 'INDEXED',
    s3Key: options.s3Key ?? `${options.prefix ?? PREFIX_A}${buildMaterialsKey(folderPath, name)}`,
    folderPath: toDisplayPath(folderPath),
  };
}

/** Seeds the hierarchy described above (rows and objects) into `backend`. */
export function seedFixture(backend: FakeMaterialsBackend): FakeMaterialsBackend {
  return backend
    .addFolder(folder('ds', null, 'Data Structures', 'Data Structures'))
    .addFolder(folder('w1', 'ds', 'Week 1', 'Data Structures/Week 1'))
    .addFolder(folder('w3', 'ds', 'Week 3', 'Data Structures/Week 3'))
    .addFolder(folder('lab', 'w3', 'Lab', 'Data Structures/Week 3/Lab'))
    .addFolder(folder('algo', null, 'Algorithms', 'Algorithms'))
    .addFile(file('f-intro', 'ds', 'Intro.pdf', 'Data Structures'))
    .addFile(file('f-sort', 'w3', 'Sorting.pdf', 'Data Structures/Week 3'))
    .addFile(file('f-heap', 'w3', 'Heaps.md', 'Data Structures/Week 3'))
    .addFile(file('f-lab1', 'lab', 'lab1.txt', 'Data Structures/Week 3/Lab'))
    .addFile(file('f-graphs', 'algo', 'Graphs.pdf', 'Algorithms'))
    .addFile(file('f-syllabus', '', 'Syllabus.pdf', ''))
    .addFolder(folder('b-root', null, 'Secret', 'Secret', STUDENT_B))
    .addFolder(folder('b-child', 'b-root', 'Plans', 'Secret/Plans', STUDENT_B))
    .addFile(file('b-file', 'b-root', 'plan.pdf', 'Secret', { studentId: STUDENT_B, prefix: PREFIX_B }));
}

/** Student B's rows and objects, to check that nothing of theirs changed. */
export function studentBState(backend: FakeMaterialsBackend): unknown {
  const snapshot = backend.snapshot();
  return {
    folders: snapshot.folders.filter((row) => row.studentId === STUDENT_B),
    files: snapshot.files.filter((row) => row.studentId === STUDENT_B),
    objects: snapshot.objects.filter(([key]) => key.startsWith(PREFIX_B)),
  };
}
