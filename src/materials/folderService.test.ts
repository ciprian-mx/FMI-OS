import {
  CONDITIONAL_CHECK_FAILED,
  CREATE_FOLDER_NODE_MUTATION,
  DELETE_FOLDER_NODE_MUTATION,
  FOLDER_NODES_BY_PARENT_QUERY,
  FOLDER_NODES_BY_STUDENT_QUERY,
  GraphqlOperationError,
  MATERIAL_FILES_BY_STUDENT_QUERY,
  UPDATE_FOLDER_NODE_MUTATION,
  UPDATE_MATERIAL_FILE_MUTATION,
  createAppSyncMaterialsDataStore,
  createFolderService,
  materializedPaths,
  splitMaterialsKey,
  type GraphqlRequest,
  type GraphqlResponse,
  type MaterialsOperationReport,
} from './folderService';
import { FakeMaterialsBackend } from './testing/fakeMaterialsBackend';
import {
  PREFIX_A,
  PREFIX_B,
  STUDENT_A,
  STUDENT_B,
  file,
  folder,
  keyA,
  seedFixture,
  studentBState,
} from './testing/materialsFixture';

/**
 * Task 4.1 — Materials folder / file data-access service with mocked seams
 * (`FakeMaterialsBackend` stands in for AppSync and S3; the AppSync data store
 * is tested against a fake GraphQL transport).
 *
 * Covers create / list / rename / move / delete for folders and files, the
 * recursive rewrite of FolderNode.path and MaterialFile.folderPath / s3Key, the
 * copy-then-delete order for S3 objects, deepest-first deletion, partial-failure
 * reporting with resume-by-rerun, and the per-student ownership checks.
 *
 * Validates: Requirements 7.1, 7.2, 7.8
 */

const NOW = new Date('2024-05-01T12:00:00.000Z');

function setup(options: { concurrency?: number } = {}) {
  const backend = seedFixture(new FakeMaterialsBackend());
  const service = createFolderService({
    data: backend,
    objects: backend,
    now: () => NOW,
    concurrency: options.concurrency ?? 1,
  });
  return { backend, service };
}

/** The operation is refused with `code` and nothing at all is written. */
async function expectRefused(
  backend: FakeMaterialsBackend,
  operation: () => Promise<unknown>,
  code: string,
  message?: RegExp
): Promise<void> {
  const before = backend.snapshot();
  const rejection = expect(operation()).rejects;
  await rejection.toMatchObject({ name: 'MaterialsOperationError', code });
  if (message) {
    await expect(operation()).rejects.toThrow(message);
  }
  expect(backend.trace).toEqual([]);
  expect(backend.snapshot()).toEqual(before);
}

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

describe('splitMaterialsKey / materializedPaths', () => {
  it('splits a Materials key into its owner prefix and relative key', () => {
    expect(splitMaterialsKey(`${PREFIX_A}materials/Data Structures/Week 3/Sorting.pdf`)).toEqual({
      layout: 'private',
      ownerSegment: 'eu-central-1:aaaa-1111',
      ownerPrefix: PREFIX_A,
      relativeKey: 'materials/Data Structures/Week 3/Sorting.pdf',
    });
    expect(splitMaterialsKey(`students/${STUDENT_A}/materials/a.pdf`)).toEqual(
      expect.objectContaining({ layout: 'students', ownerPrefix: `students/${STUDENT_A}/` })
    );
  });

  it.each([
    `${PREFIX_A}timetables/week.png`,
    `${PREFIX_A}materials/`,
    `${PREFIX_A}materials/Week 3/`,
    'public/materials/a.pdf',
    'private//materials/a.pdf',
  ])('rejects %s', (key) => {
    expect(splitMaterialsKey(key)).toBeNull();
  });

  it('derives paths from the adjacency list, with a pending change applied', () => {
    const folders = [
      folder('a', null, 'A', 'stale'),
      folder('b', 'a', 'B', 'stale'),
      folder('c', 'b', '  C  ', 'stale'),
    ];
    expect(materializedPaths(folders)).toEqual(
      new Map([
        ['a', 'A'],
        ['b', 'A/B'],
        ['c', 'A/B/C'],
      ])
    );
    expect(materializedPaths(folders, { id: 'b', name: 'Beta', parentId: null }).get('c')).toBe('Beta/C');
  });

  it('marks folders with a missing parent or a cycle as unresolvable', () => {
    const folders = [
      folder('orphan', 'gone', 'Orphan', 'Orphan'),
      folder('x', 'y', 'X', 'X'),
      folder('y', 'x', 'Y', 'Y'),
    ];
    expect([...materializedPaths(folders).values()]).toEqual([null, null, null]);
  });
});

describe('folderService — listing', () => {
  it('lists only the student’s folders and files, even if the store leaks other rows', async () => {
    const { backend, service } = setup();
    backend.leakForeignRows = true;

    expect(ids(await service.listFolders(STUDENT_A)).sort()).toEqual(['algo', 'ds', 'lab', 'w1', 'w3']);
    expect(ids(await service.listFiles(STUDENT_A)).sort()).toEqual([
      'f-graphs',
      'f-heap',
      'f-intro',
      'f-lab1',
      'f-sort',
      'f-syllabus',
    ]);
  });

  it('lists root folders and the children of a folder, sorted by name', async () => {
    const { backend, service } = setup();
    // Another student's row under student A's folder must not show up.
    backend.addFolder(folder('b-sneaky', 'ds', 'Aaa', 'Data Structures/Aaa', STUDENT_B));

    expect(ids(await service.listChildren(STUDENT_A, null))).toEqual(['algo', 'ds']);
    expect(ids(await service.listChildren(STUDENT_A, 'ds'))).toEqual(['w1', 'w3']);
    expect(await service.listChildren(STUDENT_A, 'b-root')).toEqual([]);
  });
});

describe('folderService — createFolder', () => {
  it('creates a root folder without a parentId and with its name as path', async () => {
    const { backend, service } = setup();

    const created = await service.createFolder(STUDENT_A, null, '  Operating   Systems ');

    expect(backend.folderCreates).toEqual([
      { studentId: STUDENT_A, name: 'Operating Systems', path: 'Operating Systems', createdDate: NOW.toISOString() },
    ]);
    expect(created).toEqual(expect.objectContaining({ name: 'Operating Systems', parentId: null }));
  });

  it('creates a nested folder with the parent’s path', async () => {
    const { backend, service } = setup();

    await service.createFolder(STUDENT_A, 'lab', 'Solutions');

    expect(backend.folderCreates[0]).toEqual(
      expect.objectContaining({ parentId: 'lab', name: 'Solutions', path: 'Data Structures/Week 3/Lab/Solutions' })
    );
  });

  it.each<[string, string | null, string, string]>([
    ['an empty name', 'ds', '   ', 'invalid'],
    ['a name with "/"', 'ds', 'a/b', 'invalid'],
    ['a duplicate sibling (case-insensitive)', 'ds', 'week 3', 'invalid'],
    ['an unknown parent', 'ghost', 'X', 'not-found'],
    ['another student’s parent', 'b-root', 'X', 'not-found'],
  ])('refuses %s', async (_label, parentId, name, code) => {
    const { backend, service } = setup();
    await expectRefused(backend, () => service.createFolder(STUDENT_A, parentId, name), code);
  });
});

describe('folderService — renameFolder', () => {
  it('rewrites path, folderPath and s3Key through the whole subtree and copies every object', async () => {
    const { backend, service } = setup();
    const contents = new Map([...backend.objects]);

    const report = await service.renameFolder(STUDENT_A, 'ds', 'DS');

    expect(report).toEqual(
      expect.objectContaining({ complete: true, failures: [], deferred: [], filesDeleted: [], foldersDeleted: [] })
    );
    const folders = backend.snapshot().folders;
    expect(folders.map(({ id, name, parentId, path }) => ({ id, name, parentId, path }))).toEqual([
      { id: 'algo', name: 'Algorithms', parentId: null, path: 'Algorithms' },
      { id: 'b-child', name: 'Plans', parentId: 'b-root', path: 'Secret/Plans' },
      { id: 'b-root', name: 'Secret', parentId: null, path: 'Secret' },
      { id: 'ds', name: 'DS', parentId: null, path: 'DS' },
      { id: 'lab', name: 'Lab', parentId: 'w3', path: 'DS/Week 3/Lab' },
      { id: 'w1', name: 'Week 1', parentId: 'ds', path: 'DS/Week 1' },
      { id: 'w3', name: 'Week 3', parentId: 'ds', path: 'DS/Week 3' },
    ]);

    const moved = {
      'f-intro': ['DS', 'Intro.pdf'],
      'f-sort': ['DS/Week 3', 'Sorting.pdf'],
      'f-heap': ['DS/Week 3', 'Heaps.md'],
      'f-lab1': ['DS/Week 3/Lab', 'lab1.txt'],
    } as const;
    for (const [id, [path, name]] of Object.entries(moved)) {
      const row = backend.files.get(id);
      expect(row).toEqual(
        expect.objectContaining({
          s3Key: keyA(path, name),
          folderPath: path.split('/').join(' > '),
          indexingStatus: 'PENDING',
        })
      );
      // Same bytes at the new key; nothing left at the old one.
      expect(backend.objects.get(keyA(path, name))).toBe(`content of ${id}`);
    }
    for (const key of [
      keyA('Data Structures', 'Intro.pdf'),
      keyA('Data Structures/Week 3', 'Sorting.pdf'),
      keyA('Data Structures/Week 3', 'Heaps.md'),
      keyA('Data Structures/Week 3/Lab', 'lab1.txt'),
    ]) {
      expect(backend.objects.has(key)).toBe(false);
    }
    // Files outside the subtree keep their rows and objects.
    expect(backend.files.get('f-graphs')).toEqual(file('f-graphs', 'algo', 'Graphs.pdf', 'Algorithms'));
    expect(backend.files.get('f-syllabus')).toEqual(file('f-syllabus', '', 'Syllabus.pdf', ''));
    expect(backend.objects.get(keyA('Algorithms', 'Graphs.pdf'))).toBe(contents.get(keyA('Algorithms', 'Graphs.pdf')));

    expect(ids(report.filesUpdated)).toEqual(['f-intro', 'f-sort', 'f-heap', 'f-lab1']);
    expect(ids(report.foldersUpdated)).toEqual(['w1', 'w3', 'lab', 'ds']);
    expect(report.objectsCopied).toHaveLength(4);
    expect(report.objectsRemoved).toHaveLength(4);
  });

  it('copies, re-points and only then deletes each object, and commits the folder last', async () => {
    const { backend, service } = setup();

    await service.renameFolder(STUDENT_A, 'w3', 'Week Three');

    const oldSort = keyA('Data Structures/Week 3', 'Sorting.pdf');
    const newSort = keyA('Data Structures/Week Three', 'Sorting.pdf');
    const oldHeap = keyA('Data Structures/Week 3', 'Heaps.md');
    const newHeap = keyA('Data Structures/Week Three', 'Heaps.md');
    const oldLab = keyA('Data Structures/Week 3/Lab', 'lab1.txt');
    const newLab = keyA('Data Structures/Week Three/Lab', 'lab1.txt');
    expect(backend.trace).toEqual([
      `copy ${oldSort} -> ${newSort}`,
      'updateFile f-sort',
      `remove ${oldSort}`,
      `copy ${oldHeap} -> ${newHeap}`,
      'updateFile f-heap',
      `remove ${oldHeap}`,
      `copy ${oldLab} -> ${newLab}`,
      'updateFile f-lab1',
      `remove ${oldLab}`,
      'updateFolder lab',
      'updateFolder w3',
    ]);
    expect(backend.folderUpdates).toEqual([
      { id: 'lab', path: 'Data Structures/Week Three/Lab' },
      { id: 'w3', name: 'Week Three', path: 'Data Structures/Week Three' },
    ]);
    expect(backend.fileUpdates[0]).toEqual({
      id: 'f-sort',
      s3Key: newSort,
      folderPath: 'Data Structures > Week Three',
      indexingStatus: 'PENDING',
    });
  });

  it('gives the same result when steps run concurrently', async () => {
    const sequential = setup({ concurrency: 1 });
    const concurrent = setup({ concurrency: 4 });

    await sequential.service.renameFolder(STUDENT_A, 'ds', 'DS');
    await concurrent.service.renameFolder(STUDENT_A, 'ds', 'DS');

    expect(concurrent.backend.snapshot()).toEqual(sequential.backend.snapshot());
  });

  it('moves a re-uploaded file’s rows together: one copy, one delete', async () => {
    const { backend, service } = setup();
    backend.addFile(file('f-sort-2', 'w3', 'Sorting.pdf', 'Data Structures/Week 3'), false);

    const report = await service.renameFolder(STUDENT_A, 'w3', 'W3');

    expect(report.objectsCopied.filter((copy) => copy.from.endsWith('Sorting.pdf'))).toHaveLength(1);
    expect(backend.files.get('f-sort')?.s3Key).toBe(keyA('Data Structures/W3', 'Sorting.pdf'));
    expect(backend.files.get('f-sort-2')?.s3Key).toBe(keyA('Data Structures/W3', 'Sorting.pdf'));
  });

  it('is a no-op when re-run after it completed', async () => {
    const { backend, service } = setup();
    await service.renameFolder(STUDENT_A, 'ds', 'DS');
    backend.trace.length = 0;

    const again = await service.renameFolder(STUDENT_A, 'ds', 'DS');

    expect(again).toEqual(expect.objectContaining({ complete: true, filesUpdated: [], foldersUpdated: [] }));
    expect(backend.trace).toEqual([]);
  });

  it.each<[string, string, string]>([
    ['a sibling’s name', 'Algorithms', 'invalid'],
    ['an empty name', ' ', 'invalid'],
  ])('refuses %s', async (_label, name, code) => {
    const { backend, service } = setup();
    await expectRefused(backend, () => service.renameFolder(STUDENT_A, 'ds', name), code);
  });
});

describe('folderService — moveFolder', () => {
  it('re-parents the folder and rewrites its subtree under the new parent', async () => {
    const { backend, service } = setup();

    const report = await service.moveFolder(STUDENT_A, 'w3', 'algo');

    expect(report.complete).toBe(true);
    expect(backend.folders.get('w3')).toEqual(
      expect.objectContaining({ parentId: 'algo', name: 'Week 3', path: 'Algorithms/Week 3' })
    );
    expect(backend.folders.get('lab')?.path).toBe('Algorithms/Week 3/Lab');
    expect(backend.files.get('f-sort')).toEqual(
      expect.objectContaining({
        folderId: 'w3',
        s3Key: keyA('Algorithms/Week 3', 'Sorting.pdf'),
        folderPath: 'Algorithms > Week 3',
      })
    );
    expect(backend.files.get('f-lab1')).toEqual(
      expect.objectContaining({
        s3Key: keyA('Algorithms/Week 3/Lab', 'lab1.txt'),
        folderPath: 'Algorithms > Week 3 > Lab',
      })
    );
    // The old parent and its other contents are untouched.
    expect(backend.folders.get('w1')?.path).toBe('Data Structures/Week 1');
    expect(backend.files.get('f-intro')?.s3Key).toBe(keyA('Data Structures', 'Intro.pdf'));
    expect(backend.folderUpdates[backend.folderUpdates.length - 1]).toEqual({
      id: 'w3',
      parentId: 'algo',
      path: 'Algorithms/Week 3',
    });
  });

  it('promotes a folder to the root with parentId null', async () => {
    const { backend, service } = setup();

    await service.moveFolder(STUDENT_A, 'lab', null);

    expect(backend.folderUpdates).toEqual([{ id: 'lab', parentId: null, path: 'Lab' }]);
    expect(backend.files.get('f-lab1')).toEqual(
      expect.objectContaining({ s3Key: keyA('Lab', 'lab1.txt'), folderPath: 'Lab' })
    );
  });

  it.each<[string, string, string | null, string]>([
    ['into itself', 'ds', 'ds', 'invalid'],
    ['into its own subfolder', 'ds', 'lab', 'invalid'],
    ['next to a folder with the same name', 'lab', null, 'none'],
    ['into another student’s folder', 'w3', 'b-root', 'not-found'],
    ['a folder of another student', 'b-child', null, 'not-found'],
  ])('refuses moving %s', async (_label, folderId, parentId, code) => {
    const { backend, service } = setup();
    if (code === 'none') {
      // A root folder already named "Lab".
      backend.addFolder(folder('lab-root', null, 'lab', 'lab'));
      code = 'invalid';
    }
    await expectRefused(backend, () => service.moveFolder(STUDENT_A, folderId, parentId), code);
  });

  it('refuses a move whose new keys belong to files outside it', async () => {
    const { backend, service } = setup();
    // A stale row whose key already sits where w3's Sorting.pdf would go.
    backend.addFile(
      file('f-stale', 'algo', 'Old.pdf', 'Algorithms', { s3Key: keyA('Algorithms/Week 3', 'Sorting.pdf') })
    );

    await expectRefused(backend, () => service.moveFolder(STUDENT_A, 'w3', 'algo'), 'conflict', /Old\.pdf/);
  });
});

describe('folderService — deleteFolder', () => {
  it('deletes each object, then its row, then the folders deepest first', async () => {
    const { backend, service } = setup();
    const before = studentBState(backend);

    const report = await service.deleteFolder(STUDENT_A, 'ds');

    expect(backend.trace).toEqual([
      `remove ${keyA('Data Structures', 'Intro.pdf')}`,
      'deleteFile f-intro',
      `remove ${keyA('Data Structures/Week 3', 'Sorting.pdf')}`,
      'deleteFile f-sort',
      `remove ${keyA('Data Structures/Week 3', 'Heaps.md')}`,
      'deleteFile f-heap',
      `remove ${keyA('Data Structures/Week 3/Lab', 'lab1.txt')}`,
      'deleteFile f-lab1',
      'deleteFolder lab',
      'deleteFolder w1',
      'deleteFolder w3',
      'deleteFolder ds',
    ]);
    expect(report).toEqual(
      expect.objectContaining({
        complete: true,
        filesDeleted: ['f-intro', 'f-sort', 'f-heap', 'f-lab1'],
        foldersDeleted: ['lab', 'w1', 'w3', 'ds'],
        failures: [],
      })
    );
    expect([...backend.folders.keys()].sort()).toEqual(['algo', 'b-child', 'b-root']);
    expect([...backend.files.keys()].sort()).toEqual(['b-file', 'f-graphs', 'f-syllabus']);
    expect([...backend.objects.keys()].sort()).toEqual(
      [keyA('', 'Syllabus.pdf'), keyA('Algorithms', 'Graphs.pdf'), `${PREFIX_B}materials/Secret/plan.pdf`].sort()
    );
    expect(studentBState(backend)).toEqual(before);
  });

  it('removes a re-uploaded object once, and keeps one still referenced outside the folder', async () => {
    const { backend, service } = setup();
    backend.addFile(file('f-sort-2', 'w3', 'Sorting.pdf', 'Data Structures/Week 3'), false);
    // A stale row elsewhere that still points at Heaps.md's object.
    backend.addFile(
      file('f-elsewhere', 'algo', 'Heaps.md', 'Algorithms', { s3Key: keyA('Data Structures/Week 3', 'Heaps.md') }),
      false
    );

    await service.deleteFolder(STUDENT_A, 'w3');

    expect(backend.trace.filter((entry) => entry.startsWith('remove '))).toEqual([
      `remove ${keyA('Data Structures/Week 3', 'Sorting.pdf')}`,
      `remove ${keyA('Data Structures/Week 3/Lab', 'lab1.txt')}`,
    ]);
    expect(backend.objects.has(keyA('Data Structures/Week 3', 'Heaps.md'))).toBe(true);
    expect(backend.files.has('f-sort-2')).toBe(false);
    expect(backend.files.has('f-heap')).toBe(false);
  });
});

describe('folderService — file operations', () => {
  it('renames a file: copy, point the row at the new key, delete the old object, then rename the row', async () => {
    const { backend, service } = setup();
    const oldKey = keyA('Data Structures/Week 3', 'Sorting.pdf');
    const newKey = keyA('Data Structures/Week 3', 'Sorting v2.pdf');

    const report = await service.renameFile(STUDENT_A, 'f-sort', '  Sorting v2.pdf ');

    expect(report.complete).toBe(true);
    expect(backend.trace).toEqual([
      `copy ${oldKey} -> ${newKey}`,
      'updateFile f-sort',
      `remove ${oldKey}`,
      'updateFile f-sort',
    ]);
    expect(backend.fileUpdates).toEqual([
      { id: 'f-sort', s3Key: newKey, folderPath: 'Data Structures > Week 3', indexingStatus: 'PENDING' },
      { id: 'f-sort', name: 'Sorting v2.pdf' },
    ]);
    expect(report.filesUpdated).toEqual([expect.objectContaining({ id: 'f-sort', name: 'Sorting v2.pdf', s3Key: newKey })]);
  });

  it('moves a file to another folder and to the Knowledge Base root', async () => {
    const { backend, service } = setup();

    await service.moveFile(STUDENT_A, 'f-graphs', 'w3');
    expect(backend.files.get('f-graphs')).toEqual(
      expect.objectContaining({
        folderId: 'w3',
        s3Key: keyA('Data Structures/Week 3', 'Graphs.pdf'),
        folderPath: 'Data Structures > Week 3',
        indexingStatus: 'PENDING',
      })
    );

    await service.moveFile(STUDENT_A, 'f-graphs', null);
    expect(backend.files.get('f-graphs')).toEqual(
      expect.objectContaining({ folderId: '', s3Key: keyA('', 'Graphs.pdf'), folderPath: '' })
    );
    expect([...backend.objects.keys()].filter((key) => key.endsWith('Graphs.pdf'))).toEqual([keyA('', 'Graphs.pdf')]);
  });

  it('deletes the object before the row, and keeps an object another row still uses', async () => {
    const { backend, service } = setup();
    const key = keyA('Data Structures/Week 3', 'Sorting.pdf');
    backend.addFile(file('f-sort-2', 'w3', 'Sorting.pdf', 'Data Structures/Week 3'), false);

    const first = await service.deleteFile(STUDENT_A, 'f-sort');
    expect(first).toEqual(expect.objectContaining({ complete: true, filesDeleted: ['f-sort'], objectsRemoved: [] }));
    expect(backend.objects.has(key)).toBe(true);

    const second = await service.deleteFile(STUDENT_A, 'f-sort-2');
    expect(second.objectsRemoved).toEqual([key]);
    expect(backend.trace).toEqual(['deleteFile f-sort', `remove ${key}`, 'deleteFile f-sort-2']);
  });

  it('moves only the chosen row of a re-uploaded file and keeps the shared object', async () => {
    const { backend, service } = setup();
    const key = keyA('Data Structures/Week 3', 'Sorting.pdf');
    backend.addFile(file('f-sort-2', 'w3', 'Sorting.pdf', 'Data Structures/Week 3'), false);

    await service.moveFile(STUDENT_A, 'f-sort', 'algo');

    expect(backend.objects.has(key)).toBe(true);
    expect(backend.files.get('f-sort-2')?.s3Key).toBe(key);
    expect(backend.files.get('f-sort')?.s3Key).toBe(keyA('Algorithms', 'Sorting.pdf'));
  });

  it.each<[string, string, string]>([
    ['an extension change', 'Sorting.txt', 'invalid'],
    ['an unsupported format', 'Sorting.exe', 'invalid'],
    ['an empty name', '  ', 'invalid'],
    ['a "/" in the name', 'a/b.pdf', 'invalid'],
  ])('refuses renaming to %s', async (_label, name, code) => {
    const { backend, service } = setup();
    await expectRefused(backend, () => service.renameFile(STUDENT_A, 'f-sort', name), code);
  });

  it('refuses a rename or move onto an existing file name', async () => {
    const { backend, service } = setup();
    backend.addFile(file('f-merge', 'w3', 'Merge.pdf', 'Data Structures/Week 3'));
    backend.addFile(file('f-syllabus-ds', 'ds', 'Syllabus.pdf', 'Data Structures'));

    await expectRefused(backend, () => service.renameFile(STUDENT_A, 'f-sort', 'Merge.pdf'), 'conflict');
    await expectRefused(backend, () => service.moveFile(STUDENT_A, 'f-syllabus', 'ds'), 'conflict');
  });
});

describe('folderService — ownership', () => {
  it.each<[string, (service: ReturnType<typeof setup>['service']) => Promise<unknown>]>([
    ['renaming their folder', (s) => s.renameFolder(STUDENT_A, 'b-root', 'Mine')],
    ['moving their folder', (s) => s.moveFolder(STUDENT_A, 'b-child', null)],
    ['deleting their folder', (s) => s.deleteFolder(STUDENT_A, 'b-root')],
    ['moving a folder into theirs', (s) => s.moveFolder(STUDENT_A, 'w1', 'b-root')],
    ['renaming their file', (s) => s.renameFile(STUDENT_A, 'b-file', 'mine.pdf')],
    ['moving their file', (s) => s.moveFile(STUDENT_A, 'b-file', 'ds')],
    ['moving a file into their folder', (s) => s.moveFile(STUDENT_A, 'f-sort', 'b-root')],
    ['deleting their file', (s) => s.deleteFile(STUDENT_A, 'b-file')],
  ])('refuses %s as not-found, writing nothing', async (_label, operation) => {
    const { backend, service } = setup();
    backend.leakForeignRows = true;
    await expectRefused(backend, () => operation(service), 'not-found');
  });

  it('never touches another student’s row that sits inside the folder being deleted', async () => {
    const { backend, service } = setup();
    backend.leakForeignRows = true;
    const intruder = file('b-intruder', 'w1', 'x.pdf', 'Secret', { studentId: STUDENT_B, prefix: PREFIX_B });
    backend.addFile(intruder);

    const report = await service.deleteFolder(STUDENT_A, 'w1');

    expect(report).toEqual(expect.objectContaining({ complete: true, foldersDeleted: ['w1'] }));
    expect(backend.files.get('b-intruder')).toEqual(intruder);
    expect(backend.objects.has(intruder.s3Key)).toBe(true);
  });

  it.each<[string, string]>([
    ['outside materials/', `${PREFIX_A}timetables/week.png`],
    ['in another student’s students/ area', `students/${STUDENT_B}/materials/x.pdf`],
  ])('refuses to touch a file stored %s', async (_label, s3Key) => {
    const { backend, service } = setup();
    backend.addFile(file('f-odd', 'w1', 'week.png', 'Data Structures/Week 1', { s3Key }));

    for (const operation of [
      () => service.renameFile(STUDENT_A, 'f-odd', 'week2.png'),
      () => service.moveFile(STUDENT_A, 'f-odd', 'algo'),
      () => service.deleteFile(STUDENT_A, 'f-odd'),
      () => service.deleteFolder(STUDENT_A, 'w1'),
      () => service.renameFolder(STUDENT_A, 'ds', 'DS'),
    ]) {
      await expectRefused(backend, operation, 'forbidden');
    }
  });

  it('accepts files in the student’s own students/ area', async () => {
    const { backend, service } = setup();
    backend.addFile(
      file('f-own', 'w1', 'own.pdf', 'Data Structures/Week 1', {
        s3Key: `students/${STUDENT_A}/materials/Data Structures/Week 1/own.pdf`,
      })
    );

    await service.renameFolder(STUDENT_A, 'w1', 'Week One');

    expect(backend.files.get('f-own')?.s3Key).toBe(`students/${STUDENT_A}/materials/Data Structures/Week One/own.pdf`);
  });
});

describe('folderService — partial failure and resume', () => {
  function rerunCompletes(report: MaterialsOperationReport): void {
    expect(report).toEqual(expect.objectContaining({ complete: true, failures: [] }));
  }

  it('reports a failed copy, leaves that file and the folder name alone, and finishes on a re-run', async () => {
    const { backend, service } = setup();
    const reference = setup();
    await reference.service.renameFolder(STUDENT_A, 'ds', 'DS');
    const oldSort = keyA('Data Structures/Week 3', 'Sorting.pdf');
    backend.failWhen = (entry) => entry.startsWith(`copy ${oldSort} `);

    const report = await service.renameFolder(STUDENT_A, 'ds', 'DS');

    expect(report.complete).toBe(false);
    expect(report.failures).toEqual([
      { step: 'copy-object', target: oldSort, message: expect.stringContaining('Injected failure') },
    ]);
    expect(report.deferred.sort()).toEqual(['ds', 'f-sort']);
    expect(backend.folders.get('ds')?.name).toBe('Data Structures');
    expect(backend.files.get('f-sort')?.s3Key).toBe(oldSort);
    expect(backend.files.get('f-heap')?.s3Key).toBe(keyA('DS/Week 3', 'Heaps.md'));

    backend.clearFaults();
    rerunCompletes(await service.renameFolder(STUDENT_A, 'ds', 'DS'));
    expect(backend.snapshot()).toEqual(reference.backend.snapshot());
  });

  it('finds an old object whose deletion failed again on the re-run', async () => {
    const { backend, service } = setup();
    const oldHeap = keyA('Data Structures/Week 3', 'Heaps.md');
    backend.failWhen = (entry) => entry === `remove ${oldHeap}`;

    const report = await service.renameFolder(STUDENT_A, 'w3', 'Week Three');

    expect(report.failures).toEqual([expect.objectContaining({ step: 'remove-object', target: oldHeap })]);
    expect(report.deferred).toEqual(['w3']);
    // The row already points at the new key; the old object is still there.
    expect(backend.files.get('f-heap')?.s3Key).toBe(keyA('Data Structures/Week Three', 'Heaps.md'));
    expect(backend.objects.has(oldHeap)).toBe(true);

    backend.clearFaults();
    backend.trace.length = 0;
    const resumed = await service.renameFolder(STUDENT_A, 'w3', 'Week Three');

    rerunCompletes(resumed);
    expect(resumed.objectsRemoved).toEqual([oldHeap]);
    expect(backend.objects.has(oldHeap)).toBe(false);
    expect(backend.folders.get('w3')?.name).toBe('Week Three');
    expect(backend.trace.filter((entry) => entry.startsWith('copy '))).toEqual([]);
  });

  it('repeats a copy whose row update failed', async () => {
    const { backend, service } = setup();
    backend.failWhen = (entry) => entry === 'updateFile f-lab1';

    const report = await service.moveFolder(STUDENT_A, 'lab', 'algo');

    expect(report.failures).toEqual([expect.objectContaining({ step: 'update-file', target: 'f-lab1' })]);
    // The copy exists, the old object is kept because the row still points at it.
    expect(backend.objects.has(keyA('Algorithms/Lab', 'lab1.txt'))).toBe(true);
    expect(backend.objects.has(keyA('Data Structures/Week 3/Lab', 'lab1.txt'))).toBe(true);
    expect(backend.folders.get('lab')?.parentId).toBe('w3');

    backend.clearFaults();
    backend.trace.length = 0;
    rerunCompletes(await service.moveFolder(STUDENT_A, 'lab', 'algo'));
    expect(backend.trace).toEqual([
      `copy ${keyA('Data Structures/Week 3/Lab', 'lab1.txt')} -> ${keyA('Algorithms/Lab', 'lab1.txt')}`,
      'updateFile f-lab1',
      `remove ${keyA('Data Structures/Week 3/Lab', 'lab1.txt')}`,
      'updateFolder lab',
    ]);
  });

  it('resumes after the final commit failed without copying anything again', async () => {
    const { backend, service } = setup();
    backend.failWhen = (entry) => entry === 'updateFolder ds';

    const report = await service.renameFolder(STUDENT_A, 'ds', 'DS');

    expect(report.failures).toEqual([expect.objectContaining({ step: 'update-folder', target: 'ds' })]);
    expect(report.objectsCopied).toHaveLength(4);

    backend.clearFaults();
    backend.trace.length = 0;
    rerunCompletes(await service.renameFolder(STUDENT_A, 'ds', 'DS'));
    expect(backend.trace.filter((entry) => !entry.startsWith('exists '))).toEqual(['updateFolder ds']);
  });

  it('keeps a file whose object could not be deleted, plus its folder and ancestors, until the re-run', async () => {
    const { backend, service } = setup();
    const lab1 = keyA('Data Structures/Week 3/Lab', 'lab1.txt');
    backend.failWhen = (entry) => entry === `remove ${lab1}`;

    const report = await service.deleteFolder(STUDENT_A, 'ds');

    expect(report.complete).toBe(false);
    expect(report.failures).toEqual([expect.objectContaining({ step: 'remove-object', target: lab1 })]);
    expect(report.deferred.sort()).toEqual(['ds', 'f-lab1', 'lab', 'w3']);
    expect(report.foldersDeleted).toEqual(['w1']);
    expect([...backend.folders.keys()].filter((id) => !id.startsWith('b-')).sort()).toEqual(['algo', 'ds', 'lab', 'w3']);
    expect(backend.files.has('f-lab1')).toBe(true);
    expect(backend.files.has('f-sort')).toBe(false);

    backend.clearFaults();
    rerunCompletes(await service.deleteFolder(STUDENT_A, 'ds'));
    expect([...backend.folders.keys()].sort()).toEqual(['algo', 'b-child', 'b-root']);
    expect(backend.objects.has(lab1)).toBe(false);
  });

  it('keeps the ancestors of a folder whose row could not be deleted', async () => {
    const { backend, service } = setup();
    backend.failWhen = (entry) => entry === 'deleteFolder lab';

    const report = await service.deleteFolder(STUDENT_A, 'ds');

    expect(report.failures).toEqual([expect.objectContaining({ step: 'delete-folder', target: 'lab' })]);
    expect(report.deferred.sort()).toEqual(['ds', 'w3']);
    expect(report.foldersDeleted).toEqual(['w1']);
    expect(report.filesDeleted).toHaveLength(4);

    backend.clearFaults();
    rerunCompletes(await service.deleteFolder(STUDENT_A, 'ds'));
    expect(backend.folders.has('ds')).toBe(false);
  });

  it('resumes a file rename whose old object survived', async () => {
    const { backend, service } = setup();
    const oldKey = keyA('Algorithms', 'Graphs.pdf');
    backend.failWhen = (entry) => entry === `remove ${oldKey}`;

    const report = await service.renameFile(STUDENT_A, 'f-graphs', 'Graph Theory.pdf');

    expect(report.complete).toBe(false);
    expect(report.deferred).toEqual(['f-graphs']);
    expect(backend.files.get('f-graphs')?.name).toBe('Graphs.pdf');

    backend.clearFaults();
    rerunCompletes(await service.renameFile(STUDENT_A, 'f-graphs', 'Graph Theory.pdf'));
    expect(backend.files.get('f-graphs')).toEqual(
      expect.objectContaining({ name: 'Graph Theory.pdf', s3Key: keyA('Algorithms', 'Graph Theory.pdf') })
    );
    expect(backend.objects.has(oldKey)).toBe(false);
  });

  it('keeps the row when deleting a single file’s object fails', async () => {
    const { backend, service } = setup();
    backend.failWhen = (entry) => entry.startsWith('remove ');

    const report = await service.deleteFile(STUDENT_A, 'f-graphs');

    expect(report).toEqual(
      expect.objectContaining({ complete: false, filesDeleted: [], deferred: ['f-graphs'] })
    );
    expect(backend.files.has('f-graphs')).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * AppSync data store, against a fake GraphQL transport.
 * ------------------------------------------------------------------------ */

function fakeGraphql(answer: (request: GraphqlRequest) => GraphqlResponse | Promise<GraphqlResponse>) {
  const requests: GraphqlRequest[] = [];
  const graphql = async (request: GraphqlRequest): Promise<GraphqlResponse> => {
    requests.push(request);
    return answer(request);
  };
  return { graphql, requests };
}

const RAW_DS = {
  id: 'ds',
  studentId: STUDENT_A,
  name: 'Data Structures',
  parentId: null,
  path: 'Data Structures',
  createdDate: '2024-01-01T00:00:00.000Z',
};

describe('createAppSyncMaterialsDataStore', () => {
  it('follows nextToken through every page of folderNodesByStudent', async () => {
    const pages: GraphqlResponse[] = [
      { data: { folderNodesByStudent: { items: [RAW_DS, null], nextToken: 'page-2' } } },
      { data: { folderNodesByStudent: { items: [{ ...RAW_DS, id: 'w3', parentId: 'ds' }], nextToken: null } } },
    ];
    const { graphql, requests } = fakeGraphql(() => pages.shift() as GraphqlResponse);

    const folders = await createAppSyncMaterialsDataStore({ graphql, pageSize: 50 }).listFoldersByStudent(STUDENT_A);

    expect(folders).toEqual([
      { ...RAW_DS, parentId: null },
      { ...RAW_DS, id: 'w3', parentId: 'ds' },
    ]);
    expect(requests).toEqual([
      { query: FOLDER_NODES_BY_STUDENT_QUERY, variables: { studentId: STUDENT_A, limit: 50, nextToken: null } },
      { query: FOLDER_NODES_BY_STUDENT_QUERY, variables: { studentId: STUDENT_A, limit: 50, nextToken: 'page-2' } },
    ]);
  });

  it('lists children with folderNodesByParent and files with materialFilesByStudent', async () => {
    const row = file('f-sort', 'w3', 'Sorting.pdf', 'Data Structures/Week 3');
    const { graphql, requests } = fakeGraphql((request) =>
      request.query === FOLDER_NODES_BY_PARENT_QUERY
        ? { data: { folderNodesByParent: { items: [{ ...RAW_DS, id: 'w3', parentId: 'ds' }] } } }
        : { data: { materialFilesByStudent: { items: [row], nextToken: null } } }
    );
    const store = createAppSyncMaterialsDataStore({ graphql });

    expect(ids(await store.listFoldersByParent('ds'))).toEqual(['w3']);
    expect(await store.listFilesByStudent(STUDENT_A)).toEqual([row]);
    expect(requests[0].variables).toEqual({ parentId: 'ds', limit: 100, nextToken: null });
    expect(requests[1].query).toBe(MATERIAL_FILES_BY_STUDENT_QUERY);
  });

  it('refuses a nextToken that repeats', async () => {
    const { graphql } = fakeGraphql(() => ({
      data: { folderNodesByStudent: { items: [], nextToken: 'same' } },
    }));
    await expect(createAppSyncMaterialsDataStore({ graphql }).listFoldersByStudent(STUDENT_A)).rejects.toThrow(
      /same nextToken/
    );
  });

  it('creates and updates rows with the given input and returns the stored row', async () => {
    const { graphql, requests } = fakeGraphql((request) =>
      request.query === CREATE_FOLDER_NODE_MUTATION
        ? { data: { createFolderNode: RAW_DS } }
        : request.query === UPDATE_FOLDER_NODE_MUTATION
          ? { data: { updateFolderNode: { ...RAW_DS, parentId: null, path: 'DS' } } }
          : { data: { updateMaterialFile: file('f-sort', 'w3', 'Sorting.pdf', 'DS/Week 3') } }
    );
    const store = createAppSyncMaterialsDataStore({ graphql });
    const createInput = { studentId: STUDENT_A, name: 'Data Structures', path: 'Data Structures', createdDate: 'now' };

    expect(await store.createFolder(createInput)).toEqual(RAW_DS);
    await store.updateFolder({ id: 'ds', parentId: null, path: 'DS' });
    expect(await store.updateFile({ id: 'f-sort', folderPath: 'DS > Week 3' })).toEqual(
      expect.objectContaining({ id: 'f-sort', folderPath: 'DS > Week 3' })
    );

    expect(requests.map((request) => request.variables)).toEqual([
      { input: createInput },
      { input: { id: 'ds', parentId: null, path: 'DS' } },
      { input: { id: 'f-sort', folderPath: 'DS > Week 3' } },
    ]);
    expect(requests[2].query).toBe(UPDATE_MATERIAL_FILE_MUTATION);
  });

  it('fails when a mutation returns no record', async () => {
    const { graphql } = fakeGraphql(() => ({ data: { createFolderNode: null } }));
    await expect(
      createAppSyncMaterialsDataStore({ graphql }).createFolder({
        studentId: STUDENT_A,
        name: 'X',
        path: 'X',
        createdDate: 'now',
      })
    ).rejects.toThrow('createFolderNode returned no record.');
  });

  it('treats deleting a row that is already gone as success, in both error shapes', async () => {
    const conditional = { errors: [{ errorType: CONDITIONAL_CHECK_FAILED, message: 'The conditional request failed' }] };
    const rejecting = fakeGraphql(() => Promise.reject({ data: { deleteFolderNode: null }, ...conditional }));
    const resolving = fakeGraphql(() => ({ data: { deleteMaterialFile: null }, ...conditional }));

    await expect(createAppSyncMaterialsDataStore({ graphql: rejecting.graphql }).deleteFolder('ds')).resolves.toBeUndefined();
    await expect(createAppSyncMaterialsDataStore({ graphql: resolving.graphql }).deleteFile('f-1')).resolves.toBeUndefined();
    expect(rejecting.requests[0]).toEqual({ query: DELETE_FOLDER_NODE_MUTATION, variables: { input: { id: 'ds' } } });
  });

  it('surfaces other GraphQL errors with their type, and transport errors unchanged', async () => {
    const denied = fakeGraphql(() =>
      Promise.reject({ errors: [{ errorType: 'Unauthorized', message: 'Not Authorized to access deleteFolderNode' }] })
    );
    const error = await createAppSyncMaterialsDataStore({ graphql: denied.graphql })
      .deleteFolder('ds')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphqlOperationError);
    expect(error).toMatchObject({
      message: 'deleteFolderNode failed: Not Authorized to access deleteFolderNode',
      errorTypes: ['Unauthorized'],
    });

    const offline = fakeGraphql(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(createAppSyncMaterialsDataStore({ graphql: offline.graphql }).listFilesByStudent(STUDENT_A)).rejects.toThrow(
      'Failed to fetch'
    );
  });
});
