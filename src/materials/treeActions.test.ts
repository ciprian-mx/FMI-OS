import { FolderNode, indexById, validateMove } from './folderHierarchy';
import type { MaterialFile } from './MaterialsApp';
import {
  KNOWLEDGE_BASE_LABEL,
  countFolderContents,
  describeFolderContents,
  describeLocation,
  foldersInTreeOrder,
  getFileMoveTargets,
  getFolderMoveTargets,
  resolveFileFolderId,
  splitFileName,
  validateFileMove,
  validateFileRename,
  validateFolderRename,
  validateNewFolder,
} from './treeActions';

/**
 * Task 4.2 — decision helpers behind the MaterialsApp context-menu actions:
 * move-target selection, the file-rename extension policy, name validation and
 * the recursive-delete counts.
 *
 * Validates: Requirements 7.2, 7.8
 */

const STUDENT = 'student-1';

function folder(id: string, parentId: string | null, name: string, path: string): FolderNode {
  return {
    id,
    studentId: STUDENT,
    name,
    parentId,
    path,
    createdDate: '2024-01-01T00:00:00.000Z',
  };
}

function file(id: string, folderId: string, name: string): MaterialFile {
  return {
    id,
    studentId: STUDENT,
    folderId,
    name,
    size: 1024,
    format: 'application/pdf',
    uploadDate: '2024-01-02T00:00:00.000Z',
    indexingStatus: 'INDEXED',
    s3Key: `students/${STUDENT}/materials/${name}`,
    folderPath: '',
  };
}

//   Knowledge Base
//     ├ Algorithms (alg)
//     │   └ Week 3 (alg-w3) ── sorting.pdf
//     └ Data Structures (ds) ── overview.pdf, summary.pdf
//         └ Week 3 (w3) ── sorting.pdf
//             └ Arrays (arr)
//   (+ an orphan whose parent does not exist, and syllabus.md at the root)
const FOLDERS: FolderNode[] = [
  folder('ds', null, 'Data Structures', 'Data Structures'),
  folder('w3', 'ds', 'Week 3', 'Data Structures/Week 3'),
  folder('arr', 'w3', 'Arrays', 'Data Structures/Week 3/Arrays'),
  folder('alg', null, 'Algorithms', 'Algorithms'),
  folder('alg-w3', 'alg', 'Week 3', 'Algorithms/Week 3'),
  folder('orphan', 'missing', 'Lost', 'Lost'),
];
const FILES: MaterialFile[] = [
  file('f-alg-sorting', 'alg-w3', 'sorting.pdf'),
  file('f-sorting', 'w3', 'sorting.pdf'),
  file('f-overview', 'ds', 'overview.pdf'),
  file('f-summary', 'ds', 'summary.pdf'),
  file('f-syllabus', '', 'syllabus.md'),
];
const BY_ID = indexById(FOLDERS);
const fileById = (id: string) => FILES.find((candidate) => candidate.id === id) as MaterialFile;

describe('foldersInTreeOrder / describeLocation', () => {
  it('lists reachable folders depth-first in name order, skipping orphans', () => {
    expect(foldersInTreeOrder(FOLDERS).map((node) => node.id)).toEqual([
      'alg',
      'alg-w3',
      'ds',
      'w3',
      'arr',
    ]);
  });

  it('describes a location from the Knowledge Base root', () => {
    expect(describeLocation(null, BY_ID)).toBe(KNOWLEDGE_BASE_LABEL);
    expect(describeLocation('arr', BY_ID)).toBe(
      'Knowledge Base > Data Structures > Week 3 > Arrays'
    );
  });
});

describe('getFolderMoveTargets', () => {
  it('excludes the folder, its descendants, its current parent and name clashes', () => {
    // w3: root is fine; Algorithms already has a "Week 3"; ds is the current
    // parent; w3 is itself; Arrays is inside it.
    expect(getFolderMoveTargets('w3', FOLDERS)).toEqual([
      { folderId: null, label: 'Knowledge Base' },
      { folderId: 'alg-w3', label: 'Knowledge Base > Algorithms > Week 3' },
    ]);
    expect(getFolderMoveTargets('ds', FOLDERS).map((target) => target.folderId)).toEqual([
      'alg',
      'alg-w3',
    ]);
  });

  it('only ever offers targets that validateMove accepts', () => {
    for (const node of foldersInTreeOrder(FOLDERS)) {
      for (const target of getFolderMoveTargets(node.id, FOLDERS)) {
        expect(validateMove(node.id, target.folderId, FOLDERS).valid).toBe(true);
      }
    }
  });

  it('returns nothing for an unknown folder', () => {
    expect(getFolderMoveTargets('nope', FOLDERS)).toEqual([]);
  });
});

describe('getFileMoveTargets / validateFileMove', () => {
  it('offers the root and every folder except the current one', () => {
    expect(getFileMoveTargets(fileById('f-sorting'), FOLDERS).map((t) => t.folderId)).toEqual([
      null,
      'alg',
      'alg-w3',
      'ds',
      'arr',
    ]);
    // A file stored with an unknown folder lives at the root, so the root is not offered.
    expect(resolveFileFolderId(fileById('f-syllabus'), BY_ID)).toBeNull();
    expect(
      getFileMoveTargets(fileById('f-syllabus'), FOLDERS).map((t) => t.folderId)
    ).toEqual(['alg', 'alg-w3', 'ds', 'w3', 'arr']);
  });

  it('accepts any other folder and rejects no-ops, unknown folders and name clashes', () => {
    const sorting = fileById('f-sorting');
    expect(validateFileMove(sorting, 'ds', FOLDERS, FILES)).toEqual({ valid: true });
    expect(validateFileMove(sorting, null, FOLDERS, FILES)).toEqual({ valid: true });
    expect(validateFileMove(sorting, 'w3', FOLDERS, FILES)).toEqual({
      valid: false,
      error: 'The file is already in this folder.',
    });
    expect(validateFileMove(sorting, 'missing', FOLDERS, FILES).valid).toBe(false);
    expect(validateFileMove(sorting, 'alg-w3', FOLDERS, FILES)).toEqual({
      valid: false,
      error:
        'A file named "sorting.pdf" already exists in Knowledge Base > Algorithms > Week 3.',
    });
  });
});

describe('splitFileName', () => {
  it.each([
    ['Sorting.pdf', 'Sorting', 'pdf'],
    ['archive.tar.gz', 'archive.tar', 'gz'],
    ['README', 'README', ''],
    ['.env', '.env', ''],
    ['draft.', 'draft.', ''],
  ])('splits %s', (name, base, extension) => {
    expect(splitFileName(name)).toEqual({ base, extension });
  });
});

describe('validateFileRename', () => {
  const overview = fileById('f-overview');

  it('re-appends the original extension to the typed base name', () => {
    expect(validateFileRename(overview, 'Intro', FOLDERS, FILES)).toEqual({
      valid: true,
      name: 'Intro.pdf',
    });
    expect(validateFileRename(overview, '  My   notes ', FOLDERS, FILES)).toEqual({
      valid: true,
      name: 'My notes.pdf',
    });
  });

  it('does not double an extension the student typed anyway', () => {
    expect(validateFileRename(overview, 'Intro.PDF', FOLDERS, FILES)).toEqual({
      valid: true,
      name: 'Intro.pdf',
    });
  });

  it('rejects empty names, the path separator and sibling clashes', () => {
    expect(validateFileRename(overview, '   ', FOLDERS, FILES)).toEqual({
      valid: false,
      error: 'File name cannot be empty.',
    });
    expect(validateFileRename(overview, '.pdf', FOLDERS, FILES).valid).toBe(false);
    expect(validateFileRename(overview, 'a/b', FOLDERS, FILES)).toEqual({
      valid: false,
      error: 'File name cannot contain the "/" character.',
    });
    expect(validateFileRename(overview, 'SUMMARY', FOLDERS, FILES)).toEqual({
      valid: false,
      error: 'A file named "SUMMARY.pdf" already exists here.',
    });
  });

  it('allows a case-only change and renames extensionless files as typed', () => {
    expect(validateFileRename(overview, 'OVERVIEW', FOLDERS, FILES)).toEqual({
      valid: true,
      name: 'OVERVIEW.pdf',
    });
    const readme = file('f-readme', 'ds', 'README');
    expect(validateFileRename(readme, 'NOTES', FOLDERS, [...FILES, readme])).toEqual({
      valid: true,
      name: 'NOTES',
    });
  });
});

describe('validateFolderRename / validateNewFolder', () => {
  it('validates renames against siblings other than the folder itself', () => {
    expect(validateFolderRename('w3', 'week 3', FOLDERS)).toEqual({
      valid: true,
      name: 'week 3',
    });
    expect(validateFolderRename('ds', 'algorithms', FOLDERS)).toEqual({
      valid: false,
      error: 'A folder named "algorithms" already exists here.',
    });
    expect(validateFolderRename('ds', '  ', FOLDERS).valid).toBe(false);
    expect(validateFolderRename('nope', 'X', FOLDERS).valid).toBe(false);
  });

  it('validates new folders with validateCreate and normalizes the name', () => {
    expect(validateNewFolder('ds', '  New   topic ', STUDENT, FOLDERS)).toEqual({
      valid: true,
      name: 'New topic',
    });
    expect(validateNewFolder('ds', 'WEEK 3', STUDENT, FOLDERS)).toEqual({
      valid: false,
      error: 'A folder named "WEEK 3" already exists here.',
    });
    expect(validateNewFolder('missing', 'X', STUDENT, FOLDERS)).toEqual({
      valid: false,
      error: 'Parent folder does not exist.',
    });
    expect(validateNewFolder('ds', 'X', 'someone-else', FOLDERS).valid).toBe(false);
  });
});

describe('countFolderContents / describeFolderContents', () => {
  it('counts every descendant folder and every file beneath the folder', () => {
    expect(countFolderContents('ds', FOLDERS, FILES)).toEqual({ folders: 2, files: 3 });
    expect(countFolderContents('arr', FOLDERS, FILES)).toEqual({ folders: 0, files: 0 });
  });

  it('describes the counts with correct pluralization', () => {
    expect(describeFolderContents({ folders: 2, files: 3 })).toBe('2 subfolders and 3 files');
    expect(describeFolderContents({ folders: 1, files: 1 })).toBe('1 subfolder and 1 file');
    expect(describeFolderContents({ folders: 0, files: 2 })).toBe('2 files');
    expect(describeFolderContents({ folders: 0, files: 0 })).toBe('');
  });
});
