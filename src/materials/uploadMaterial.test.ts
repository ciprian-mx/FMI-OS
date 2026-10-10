import fc from 'fast-check';
import { FolderNode } from './folderHierarchy';
import type { MaterialFile } from './MaterialsApp';
import {
  CreateMaterialFileInput,
  MaterialFileCreator,
  StorageUploadRequest,
  StorageUploadResult,
  StorageUploader,
  UploadFile,
  UploadMaterialDeps,
  buildMaterialsKey,
  resolveFolderPath,
  toDisplayPath,
  uploadMaterial,
} from './uploadMaterial';

/**
 * Task 4.5 — Materials file-upload orchestration (Requirements 7.3 / 7.4 / 7.5 / 7.7).
 *
 * These tests inject mock storage + mutation seams, so no live AWS backend is
 * touched. They assert the happy path computes the correct relative S3 key and
 * display folder path, creates a PENDING-indexing record, and calls upload
 * BEFORE create; that an invalid file is rejected before any side effect; and
 * that nested folder paths resolve correctly.
 *
 * Validates: Requirements 7.3, 7.4, 7.5, 7.7
 */

const STUDENT = 'student-1';

function folder(
  id: string,
  parentId: string | null,
  name: string,
  path: string,
  studentId: string = STUDENT
): FolderNode {
  return { id, studentId, name, parentId, path, createdDate: '2024-01-01T00:00:00.000Z' };
}

/** A simple nested hierarchy: Data Structures / Week 3. */
const FOLDERS: FolderNode[] = [
  folder('ds', null, 'Data Structures', 'Data Structures'),
  folder('wk3', 'ds', 'Week 3', 'Data Structures/Week 3'),
];

function pdf(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    name: 'Sorting.pdf',
    size: 1024,
    type: 'application/pdf',
    ...overrides,
  };
}

interface MockDeps extends UploadMaterialDeps {
  uploadCalls: StorageUploadRequest[];
  createCalls: CreateMaterialFileInput[];
  callOrder: string[];
}

function makeDeps(opts: {
  upload?: (req: StorageUploadRequest) => Promise<StorageUploadResult>;
  create?: (input: CreateMaterialFileInput) => Promise<MaterialFile>;
  now?: () => Date;
} = {}): MockDeps {
  const uploadCalls: StorageUploadRequest[] = [];
  const createCalls: CreateMaterialFileInput[] = [];
  const callOrder: string[] = [];

  const storage: StorageUploader = {
    async upload(req) {
      uploadCalls.push(req);
      callOrder.push('upload');
      if (opts.upload) {
        return opts.upload(req);
      }
      return { fullKey: `private/identity-abc/${req.key}` };
    },
  };

  const materialFiles: MaterialFileCreator = {
    async create(input) {
      createCalls.push(input);
      callOrder.push('create');
      if (opts.create) {
        return opts.create(input);
      }
      return { id: 'file-1', ...input } as MaterialFile;
    },
  };

  return {
    storage,
    materialFiles,
    now: opts.now ?? (() => new Date('2024-05-01T12:00:00.000Z')),
    uploadCalls,
    createCalls,
    callOrder,
  };
}

describe('buildMaterialsKey', () => {
  it('nests the folder path under the materials prefix', () => {
    expect(buildMaterialsKey('Data Structures/Week 3', 'Sorting.pdf')).toBe(
      'materials/Data Structures/Week 3/Sorting.pdf'
    );
  });

  it('places root-level files directly under materials/', () => {
    expect(buildMaterialsKey('', 'notes.txt')).toBe('materials/notes.txt');
  });
});

describe('toDisplayPath', () => {
  it('converts a slash path to the " > " citation form', () => {
    expect(toDisplayPath('Data Structures/Week 3')).toBe('Data Structures > Week 3');
  });

  it('returns an empty string for the root', () => {
    expect(toDisplayPath('')).toBe('');
  });
});

describe('resolveFolderPath', () => {
  it('resolves a nested folder path', () => {
    expect(resolveFolderPath('wk3', STUDENT, FOLDERS)).toBe('Data Structures/Week 3');
  });

  it('returns an empty path for the Knowledge Base root (null folderId)', () => {
    expect(resolveFolderPath(null, STUDENT, FOLDERS)).toBe('');
  });

  it('throws for an unknown folder id', () => {
    expect(() => resolveFolderPath('nope', STUDENT, FOLDERS)).toThrow(
      /does not exist/
    );
  });

  it("throws when the folder belongs to another student", () => {
    const others = [folder('x', null, 'X', 'X', 'other-student')];
    expect(() => resolveFolderPath('x', STUDENT, others)).toThrow(
      /another student/
    );
  });
});

describe('uploadMaterial — happy path', () => {
  it('computes the correct s3Key/folderPath, sets PENDING, and uploads before creating', async () => {
    const deps = makeDeps();

    const result = await uploadMaterial(
      { file: pdf(), folderId: 'wk3', studentId: STUDENT, folders: FOLDERS },
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Upload ran with the correct relative key and metadata.
    expect(deps.uploadCalls).toHaveLength(1);
    expect(deps.uploadCalls[0]).toEqual(
      expect.objectContaining({
        key: 'materials/Data Structures/Week 3/Sorting.pdf',
        contentType: 'application/pdf',
        metadata: { studentId: STUDENT, folderPath: 'Data Structures/Week 3' },
      })
    );

    // Record created with PENDING status, the absolute key, and display path.
    expect(deps.createCalls).toHaveLength(1);
    expect(deps.createCalls[0]).toEqual(
      expect.objectContaining({
        studentId: STUDENT,
        folderId: 'wk3',
        name: 'Sorting.pdf',
        size: 1024,
        format: 'application/pdf',
        indexingStatus: 'PENDING',
        s3Key: 'private/identity-abc/materials/Data Structures/Week 3/Sorting.pdf',
        folderPath: 'Data Structures > Week 3',
        uploadDate: '2024-05-01T12:00:00.000Z',
      })
    );

    // Upload must happen before the record is created.
    expect(deps.callOrder).toEqual(['upload', 'create']);

    // The returned record is what the mutation produced.
    expect(result.file.id).toBe('file-1');
    expect(result.file.indexingStatus).toBe('PENDING');
  });

  it('uploads a root-level file directly under materials/ with an empty folder path', async () => {
    const deps = makeDeps();

    const result = await uploadMaterial(
      { file: pdf({ name: 'syllabus.pdf' }), folderId: null, studentId: STUDENT, folders: FOLDERS },
      deps
    );

    expect(result.ok).toBe(true);
    expect(deps.uploadCalls[0].key).toBe('materials/syllabus.pdf');
    expect(deps.createCalls[0]).toEqual(
      expect.objectContaining({ folderId: '', folderPath: '', indexingStatus: 'PENDING' })
    );
  });
});

describe('uploadMaterial — rejection paths', () => {
  it('rejects an invalid file BEFORE any upload or record creation', async () => {
    const deps = makeDeps();

    const result = await uploadMaterial(
      { file: pdf({ name: 'virus.exe', type: 'application/octet-stream' }), folderId: 'wk3', studentId: STUDENT, folders: FOLDERS },
      deps
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unsupported file format/);

    // No side effects whatsoever.
    expect(deps.uploadCalls).toHaveLength(0);
    expect(deps.createCalls).toHaveLength(0);
  });

  it('rejects an oversize file before any side effect', async () => {
    const deps = makeDeps();

    const result = await uploadMaterial(
      { file: pdf({ size: 21 * 1024 * 1024 }), folderId: 'wk3', studentId: STUDENT, folders: FOLDERS },
      deps
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/size limit/);
    expect(deps.uploadCalls).toHaveLength(0);
    expect(deps.createCalls).toHaveLength(0);
  });

  it('rejects an unknown target folder before any upload', async () => {
    const deps = makeDeps();

    const result = await uploadMaterial(
      { file: pdf(), folderId: 'ghost', studentId: STUDENT, folders: FOLDERS },
      deps
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does not exist/);
    expect(deps.uploadCalls).toHaveLength(0);
    expect(deps.createCalls).toHaveLength(0);
  });
});

describe('uploadMaterial — nested folder path resolution (property)', () => {
  // A segment that is safe inside a materialized path: non-empty, no slash,
  // no leading/trailing whitespace collapse surprises.
  const segmentArb = fc
    .string({ minLength: 1, maxLength: 12 })
    .map((s) => s.replace(/[/\s]/g, 'x'))
    .filter((s) => s.length > 0);

  it('computes key + display path consistent with the resolved folder for arbitrary nestings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(segmentArb, { minLength: 1, maxLength: 6 }),
        async (segments) => {
          // Build a linear chain of folders from the segments.
          const chain: FolderNode[] = [];
          let parentId: string | null = null;
          let runningPath = '';
          segments.forEach((name, i) => {
            runningPath = runningPath ? `${runningPath}/${name}` : name;
            const id = `f${i}`;
            chain.push(folder(id, parentId, name, runningPath));
            parentId = id;
          });
          const targetId = `f${segments.length - 1}`;
          const expectedPath = runningPath;

          const deps = makeDeps();
          const result = await uploadMaterial(
            { file: pdf(), folderId: targetId, studentId: STUDENT, folders: chain },
            deps
          );

          if (!result.ok) {
            return false;
          }
          const keyOk =
            deps.uploadCalls[0].key === `materials/${expectedPath}/Sorting.pdf`;
          const metaOk =
            deps.uploadCalls[0].metadata.folderPath === expectedPath;
          const displayOk =
            deps.createCalls[0].folderPath === segments.join(' > ');
          const pendingOk = deps.createCalls[0].indexingStatus === 'PENDING';
          const orderOk =
            deps.callOrder[0] === 'upload' && deps.callOrder[1] === 'create';
          return keyOk && metaOk && displayOk && pendingOk && orderOk;
        }
      ),
      { numRuns: 100 }
    );
  });
});
