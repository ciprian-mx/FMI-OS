/**
 * Materials folder and file data-access service (Task 4.1, Requirements 7.1,
 * 7.2, 7.8).
 *
 * `folderHierarchy.ts` validates hierarchy changes as pure data; this module
 * carries them out against the real stores. Operations: list a student's
 * folders (paginated `folderNodesByStudent`), list a folder's children
 * (`folderNodesByParent`), list files, create / rename / move / delete a folder
 * (rename, move and delete cascade through the whole subtree), and rename /
 * move / delete a file.
 *
 * Seams
 * -----
 * {@link MaterialsDataStore} holds the `FolderNode` / `MaterialFile` rows
 * (default: AppSync, {@link createAppSyncMaterialsDataStore});
 * {@link MaterialsObjectStore} holds the Materials objects (default: Amplify
 * Storage, {@link createAmplifyMaterialsObjectStore}). Like `uploadMaterial.ts`
 * the defaults import `aws-amplify/*` lazily inside their methods, so importing
 * this module has no side effects; tests inject in-memory fakes.
 * {@link createDefaultFolderService} wires the defaults.
 *
 * Source of truth
 * ---------------
 * The adjacency fields, `FolderNode.parentId` / `name` and
 * `MaterialFile.folderId` / `name`, say where everything is. The rest is
 * derived from them and rewritten to match:
 *
 *   FolderNode.path          "Data Structures/Week 3"
 *   MaterialFile.folderPath  "Data Structures > Week 3"
 *   MaterialFile.s3Key       private/{identityId}/materials/Data Structures/Week 3/Sorting.pdf
 *
 * The owner prefix of a key (`private/{identityId}/`) never changes.
 *
 * Rename / move (folder or file)
 * ------------------------------
 *   1. Load the student's folders and files; validate. A refusal throws
 *      {@link MaterialsOperationError} before anything is written.
 *   2. Every object whose key changes (all files in a folder's subtree):
 *      copy old -> new key, point the MaterialFile row(s) at it (`s3Key`,
 *      `folderPath`, `indexingStatus = PENDING`), then delete the old object
 *      once no row references it. S3 has no rename. The copy keeps the
 *      object's `studentid` metadata; its ObjectCreated event re-indexes the
 *      new key and the old key's ObjectRemoved event takes the old document out
 *      of the Knowledge Base (`materialIndexTrigger`, Requirement 7.8).
 *   3. Remove objects an interrupted earlier run left at the old location
 *      (see "Partial failure").
 *   4. Rewrite `path` on every folder below the renamed / moved one.
 *   5. Commit, last and only if steps 2-4 fully succeeded: the folder's
 *      `name` / `parentId` / `path`, or the file's `name` / `folderId`.
 *
 * Delete (folder or file)
 * -----------------------
 *   1. Load and validate.
 *   2. Per object: delete it from S3 (unless a row outside the deletion still
 *      references it), then its MaterialFile row(s). The ObjectRemoved event
 *      makes `materialIndexTrigger` delete the Knowledge Base document and its
 *      metadata sidecar.
 *   3. Delete FolderNode rows deepest level first. A folder is deleted only
 *      once all of its files and subfolders are gone, so the remaining rows
 *      always form a valid tree.
 *
 * Partial failure
 * ---------------
 * Steps are independent: a failing step is recorded in the
 * {@link MaterialsOperationReport} (`failures`, plus `deferred` for the rows it
 * held back) and the others still run. Because the adjacency change (or the
 * topmost delete) happens last, a partially applied operation leaves it
 * untouched, and calling the same operation again with the same arguments
 * resumes it: steps already done are recognised from the stored state and
 * skipped, a copy whose row update was lost is repeated (which also re-triggers
 * indexing), and an old object whose deletion failed is found again at its
 * derived old key and removed. Re-running a completed rename or move is a
 * no-op; re-running a completed delete reports `not-found`.
 *
 * Ownership
 * ---------
 * Rows are loaded through the caller's `byStudent` indexes and filtered on
 * `studentId`, so another student's ids are unknown (`not-found`) and are
 * never written; `folderNodesByParent` results are filtered the same way.
 * Every object key the operation touches must be a Materials key
 * (`private/{id}/materials/...`, or `students/{callerId}/materials/...`),
 * otherwise the operation is refused (`forbidden`). AppSync's owner rule and
 * the S3 policy (`private/${cognito-identity.amazonaws.com:sub}/*`) enforce the
 * same boundary server-side.
 */
import {
  PATH_SEPARATOR,
  getChildren,
  indexById,
  normalizeFolderName,
  validateCreate,
  validateFolderName,
  validateMove,
  type FolderNode,
} from './folderHierarchy';
import { allowedFormatsMessage, extractExtension, isAllowedExtension } from './fileValidation';
import type { IndexingStatus, MaterialFile } from './MaterialsApp';
import { buildMaterialsKey, toDisplayPath } from './uploadMaterial';

/* ========================================================================== *
 * Seams
 * ========================================================================== */

/** Fields of a new `FolderNode` row. */
export interface CreateFolderNodeInput {
  studentId: string;
  name: string;
  /**
   * The parent folder; omitted for a root folder. `parentId` is the `byParent`
   * index key and DynamoDB rejects a NULL index key, so it is left out rather
   * than sent as null.
   */
  parentId?: string;
  path: string;
  createdDate: string;
}

/** A partial `FolderNode` update. */
export interface UpdateFolderNodeInput {
  id: string;
  name?: string;
  /** `null` turns the folder into a root folder (AppSync removes the attribute). */
  parentId?: string | null;
  path?: string;
}

/** A partial `MaterialFile` update. */
export interface UpdateMaterialFileInput {
  id: string;
  name?: string;
  /** {@link ROOT_FILE_FOLDER_ID} for the Knowledge Base root, as the upload flow writes it. */
  folderId?: string;
  folderPath?: string;
  s3Key?: string;
  indexingStatus?: IndexingStatus;
}

/** Row access for the Materials models. List methods return every page. */
export interface MaterialsDataStore {
  /** `folderNodesByStudent`: every folder of the student. */
  listFoldersByStudent(studentId: string): Promise<FolderNode[]>;
  /** `folderNodesByParent`: the direct children of a folder. */
  listFoldersByParent(parentId: string): Promise<FolderNode[]>;
  /** `materialFilesByStudent`: every file of the student. */
  listFilesByStudent(studentId: string): Promise<MaterialFile[]>;
  createFolder(input: CreateFolderNodeInput): Promise<FolderNode>;
  updateFolder(input: UpdateFolderNodeInput): Promise<FolderNode>;
  /** Succeeds when the row is already gone. */
  deleteFolder(id: string): Promise<void>;
  updateFile(input: UpdateMaterialFileInput): Promise<MaterialFile>;
  /** Succeeds when the row is already gone. */
  deleteFile(id: string): Promise<void>;
}

/** Access to Materials objects by absolute S3 key. */
export interface MaterialsObjectStore {
  /**
   * Server-side copy inside the bucket, overwriting `destinationKey`. The
   * object's user metadata (the `studentid` the index trigger reads) is kept.
   */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  /** Deletes the object; succeeds when it does not exist. */
  remove(key: string): Promise<void>;
  /** Whether an object exists at exactly `key`. */
  exists(key: string): Promise<boolean>;
}

/* ========================================================================== *
 * Errors and reports
 * ========================================================================== */

export type MaterialsErrorCode = 'invalid' | 'not-found' | 'conflict' | 'forbidden';

/**
 * An operation was refused before anything was written: invalid input, an id
 * the student does not own (reported as `not-found`), a name collision with an
 * existing file (`conflict`), or a file stored outside the student's Materials
 * area (`forbidden`).
 */
export class MaterialsOperationError extends Error {
  readonly code: MaterialsErrorCode;

  constructor(code: MaterialsErrorCode, message: string) {
    super(message);
    this.name = 'MaterialsOperationError';
    this.code = code;
  }
}

/** The kind of write that failed. */
export type OperationStep =
  | 'copy-object'
  | 'remove-object'
  | 'check-object'
  | 'update-file'
  | 'delete-file'
  | 'update-folder'
  | 'delete-folder';

export interface OperationFailure {
  step: OperationStep;
  /** The S3 key for object steps, the row id otherwise. */
  target: string;
  message: string;
}

export interface ObjectCopy {
  from: string;
  to: string;
}

/** What an operation changed, and what it could not. */
export interface MaterialsOperationReport {
  /** True when every step succeeded. When false, call the same operation again to resume it. */
  complete: boolean;
  /** Folder rows as last written (rewritten paths, then the committed folder). */
  foldersUpdated: FolderNode[];
  foldersDeleted: string[];
  /** File rows as last written. */
  filesUpdated: MaterialFile[];
  filesDeleted: string[];
  objectsCopied: ObjectCopy[];
  objectsRemoved: string[];
  failures: OperationFailure[];
  /** Ids of rows deliberately left unchanged because a step they depend on failed. */
  deferred: string[];
}

/* ========================================================================== *
 * Keys and derived paths
 * ========================================================================== */

/** `MaterialFile.folderId` of a file in the Knowledge Base root (what the upload flow writes). */
export const ROOT_FILE_FOLDER_ID = '';

/** Default number of S3 / AppSync steps an operation runs at once. */
export const DEFAULT_CONCURRENCY = 4;

/** An absolute Materials object key, split into its owner prefix and the part below it. */
export interface MaterialsKeyParts {
  layout: 'private' | 'students';
  /** The Cognito identity id (`private`) or user id (`students`). */
  ownerSegment: string;
  /** `private/{identityId}/` or `students/{userId}/`. */
  ownerPrefix: string;
  /** `materials/{folderPath}/{fileName}`. */
  relativeKey: string;
}

const MATERIALS_KEY_PATTERN = /^(private|students)\/([^/]+)\/(materials\/[\s\S]*[^/])$/;

/** Splits `private|students/{owner}/materials/...`; `null` for any other key. */
export function splitMaterialsKey(s3Key: string): MaterialsKeyParts | null {
  const match = typeof s3Key === 'string' ? MATERIALS_KEY_PATTERN.exec(s3Key) : null;
  if (!match) {
    return null;
  }
  const [, layout, ownerSegment, relativeKey] = match;
  return {
    layout: layout as MaterialsKeyParts['layout'],
    ownerSegment,
    ownerPrefix: `${layout}/${ownerSegment}/`,
    relativeKey,
  };
}

/** The absolute key of `fileName` in the folder whose materialized path is `folderPath`. */
export function materialsKeyFor(ownerPrefix: string, folderPath: string, fileName: string): string {
  return `${ownerPrefix}${buildMaterialsKey(folderPath, fileName)}`;
}

/** A pending change to one folder's adjacency fields. */
export interface AdjacencyChange {
  id: string;
  name?: string;
  parentId?: string | null;
}

/**
 * The materialized path of every folder, computed from the adjacency list
 * (names joined with "/" from the root) with `change` applied. `null` marks
 * folders whose parent chain is broken (a missing parent or a cycle).
 */
export function materializedPaths(
  folders: readonly FolderNode[],
  change?: AdjacencyChange
): Map<string, string | null> {
  const byId = indexById(folders);
  const paths = new Map<string, string | null>();
  const resolving = new Set<string>();

  const resolve = (id: string): string | null => {
    const known = paths.get(id);
    if (known !== undefined) {
      return known;
    }
    const node = byId.get(id);
    if (!node || resolving.has(id)) {
      return null;
    }
    resolving.add(id);
    const changed = change !== undefined && change.id === id;
    const name = normalizeFolderName(changed && change.name !== undefined ? change.name : node.name);
    const parentId =
      changed && change.parentId !== undefined ? change.parentId : node.parentId ?? null;
    let path: string | null;
    if (parentId === null) {
      path = name;
    } else {
      const parentPath = resolve(parentId);
      path = parentPath === null ? null : `${parentPath}${PATH_SEPARATOR}${name}`;
    }
    resolving.delete(id);
    paths.set(id, path);
    return path;
  };

  for (const folder of folders) {
    resolve(folder.id);
  }
  return paths;
}

/* ========================================================================== *
 * Service
 * ========================================================================== */

/** The Materials operations. Every method takes the signed-in student's id. */
export interface FolderService {
  listFolders(studentId: string): Promise<FolderNode[]>;
  /** Direct children sorted by name; `parentId` null lists the root folders. */
  listChildren(studentId: string, parentId: string | null): Promise<FolderNode[]>;
  listFiles(studentId: string): Promise<MaterialFile[]>;
  createFolder(studentId: string, parentId: string | null, name: string): Promise<FolderNode>;
  renameFolder(studentId: string, folderId: string, newName: string): Promise<MaterialsOperationReport>;
  /** `newParentId` null makes the folder a root folder. */
  moveFolder(
    studentId: string,
    folderId: string,
    newParentId: string | null
  ): Promise<MaterialsOperationReport>;
  deleteFolder(studentId: string, folderId: string): Promise<MaterialsOperationReport>;
  renameFile(studentId: string, fileId: string, newName: string): Promise<MaterialsOperationReport>;
  /** `targetFolderId` null moves the file to the Knowledge Base root. */
  moveFile(
    studentId: string,
    fileId: string,
    targetFolderId: string | null
  ): Promise<MaterialsOperationReport>;
  deleteFile(studentId: string, fileId: string): Promise<MaterialsOperationReport>;
}

export interface FolderServiceDeps {
  data: MaterialsDataStore;
  objects: MaterialsObjectStore;
  /** Clock for `createdDate`. Defaults to the current time. */
  now?: () => Date;
  /** Maximum S3 / AppSync steps in flight at once. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
}

const INCONSISTENT_HIERARCHY =
  'The folder hierarchy is inconsistent (a missing parent folder or a cycle). Reload the Materials app and try again.';

interface Snapshot {
  folders: FolderNode[];
  files: MaterialFile[];
}

/** One file whose object key may change. */
interface Placement {
  file: MaterialFile;
  /** Key derived from the adjacency before the operation (the old location). */
  currentKey: string;
  /** Key derived from the adjacency after the operation. */
  targetKey: string;
  /** Display folder path after the operation. */
  targetFolderPath: string;
}

/** The adjacency write that completes a rename / move. */
interface Commit {
  target: string;
  step: OperationStep;
  run: (report: ReportBuilder) => Promise<void>;
}

/** Builds a {@link FolderService} over the given stores. */
export function createFolderService(deps: FolderServiceDeps): FolderService {
  const { data, objects } = deps;
  const now = deps.now ?? (() => new Date());
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY));

  const loadFolders = async (studentId: string): Promise<FolderNode[]> =>
    (await data.listFoldersByStudent(studentId)).filter((folder) => folder.studentId === studentId);

  const loadFiles = async (studentId: string): Promise<MaterialFile[]> =>
    (await data.listFilesByStudent(studentId)).filter((file) => file.studentId === studentId);

  const loadAll = async (studentId: string): Promise<Snapshot> => {
    const [folders, files] = await Promise.all([loadFolders(studentId), loadFiles(studentId)]);
    return { folders, files };
  };

  /* ------------------------------ relocation ----------------------------- */

  async function runRelocation(
    placements: readonly Placement[],
    folderPathUpdates: readonly { id: string; path: string }[],
    commit: Commit | null,
    files: readonly MaterialFile[]
  ): Promise<MaterialsOperationReport> {
    const report = new ReportBuilder();
    const refs = new KeyReferences(files);

    // 2. Objects, and the rows pointing at them.
    await forEachConcurrently(groupPlacements(placements), concurrency, (group) =>
      relocateGroup(group, refs, report)
    );

    // 3. Objects an interrupted earlier run left at the old location: their
    //    rows already point at the new key, so only the derived old key finds them.
    const leftovers = unique(
      placements
        .filter((p) => p.currentKey !== p.file.s3Key && p.currentKey !== p.targetKey)
        .map((p) => p.currentKey)
    );
    await forEachConcurrently(leftovers, concurrency, (key) => removeLeftover(key, refs, report));

    // 4. Denormalized paths of the folders below the committed one.
    await forEachConcurrently(folderPathUpdates, concurrency, async ({ id, path }) => {
      try {
        report.folderUpdated(await data.updateFolder({ id, path }));
      } catch (error) {
        report.fail('update-folder', id, error);
      }
    });

    // 5. Commit last, so a partial run leaves the adjacency (and therefore the
    //    derived old keys) intact for the resume.
    if (commit) {
      if (report.failed) {
        report.defer(commit.target);
      } else {
        try {
          await commit.run(report);
        } catch (error) {
          report.fail(commit.step, commit.target, error);
        }
      }
    }
    return report.build();
  }

  async function relocateGroup(
    group: PlacementGroup,
    refs: KeyReferences,
    report: ReportBuilder
  ): Promise<void> {
    const { storedKey, targetKey, targetFolderPath, files: groupFiles } = group;

    if (storedKey === targetKey) {
      // Already at its key (a resumed run, or the key does not change): only
      // repair a stale display path.
      for (const file of groupFiles) {
        if (file.folderPath === targetFolderPath) {
          continue;
        }
        try {
          report.fileUpdated(await data.updateFile({ id: file.id, folderPath: targetFolderPath }));
        } catch (error) {
          report.fail('update-file', file.id, error);
        }
      }
      return;
    }

    try {
      await objects.copy(storedKey, targetKey);
      report.copied(storedKey, targetKey);
    } catch (error) {
      report.fail('copy-object', storedKey, error);
      groupFiles.forEach((file) => report.defer(file.id));
      return;
    }

    for (const file of groupFiles) {
      try {
        const updated = await data.updateFile({
          id: file.id,
          s3Key: targetKey,
          folderPath: targetFolderPath,
          // The new key is a new Knowledge Base document; the trigger indexes it.
          indexingStatus: 'PENDING',
        });
        refs.point(file.id, targetKey);
        report.fileUpdated(updated);
      } catch (error) {
        report.fail('update-file', file.id, error);
      }
    }

    // The old object goes once no row, in this operation or elsewhere, points at it.
    if (refs.isReferenced(storedKey)) {
      return;
    }
    try {
      await objects.remove(storedKey);
      report.removed(storedKey);
    } catch (error) {
      report.fail('remove-object', storedKey, error);
    }
  }

  async function removeLeftover(key: string, refs: KeyReferences, report: ReportBuilder): Promise<void> {
    if (refs.isReferenced(key)) {
      return;
    }
    let present: boolean;
    try {
      present = await objects.exists(key);
    } catch (error) {
      report.fail('check-object', key, error);
      return;
    }
    if (!present) {
      return;
    }
    try {
      await objects.remove(key);
      report.removed(key);
    } catch (error) {
      report.fail('remove-object', key, error);
    }
  }

  function relocateFolder(
    studentId: string,
    state: Snapshot,
    folder: FolderNode,
    change: AdjacencyChange
  ): Promise<MaterialsOperationReport> {
    const currentPaths = materializedPaths(state.folders);
    const targetPaths = materializedPaths(state.folders, change);
    const pathsOf = (folderId: string): { current: string; target: string } => {
      const current = currentPaths.get(folderId);
      const target = targetPaths.get(folderId);
      if (current === undefined || current === null || target === undefined || target === null) {
        throw new MaterialsOperationError('invalid', INCONSISTENT_HIERARCHY);
      }
      return { current, target };
    };

    const subtree = subtreeLevels(folder.id, state.folders).flat();
    const subtreeIds = new Set(subtree.map((node) => node.id));
    subtree.forEach((node) => pathsOf(node.id));

    const placements: Placement[] = state.files
      .filter((file) => subtreeIds.has(file.folderId))
      .map((file) => {
        const { ownerPrefix } = requireMaterialsKey(studentId, file);
        const { current, target } = pathsOf(file.folderId);
        return {
          file,
          currentKey: materialsKeyFor(ownerPrefix, current, file.name),
          targetKey: materialsKeyFor(ownerPrefix, target, file.name),
          targetFolderPath: toDisplayPath(target),
        };
      });
    assertNoCollisions(placements, state.files);

    const folderPathUpdates = subtree
      .filter((node) => node.id !== folder.id && node.path !== pathsOf(node.id).target)
      .map((node) => ({ id: node.id, path: pathsOf(node.id).target }));

    const commitInput = folderCommitInput(folder, change, pathsOf(folder.id).target);
    const commit: Commit | null = commitInput && {
      target: folder.id,
      step: 'update-folder',
      run: async (report) => report.folderUpdated(await data.updateFolder(commitInput)),
    };
    return runRelocation(placements, folderPathUpdates, commit, state.files);
  }

  function relocateFile(
    studentId: string,
    state: Snapshot,
    file: MaterialFile,
    target: { name: string; folderId: string },
    currentFolderPath: string | null,
    targetFolderPath: string
  ): Promise<MaterialsOperationReport> {
    const { ownerPrefix } = requireMaterialsKey(studentId, file);
    const placement: Placement = {
      file,
      // Without a resolvable current folder there is no derived old key to sweep.
      currentKey:
        currentFolderPath === null
          ? file.s3Key
          : materialsKeyFor(ownerPrefix, currentFolderPath, file.name),
      targetKey: materialsKeyFor(ownerPrefix, targetFolderPath, target.name),
      targetFolderPath: toDisplayPath(targetFolderPath),
    };
    assertNoCollisions([placement], state.files);

    const commitInput: UpdateMaterialFileInput = { id: file.id };
    if (target.name !== file.name) {
      commitInput.name = target.name;
    }
    if (target.folderId !== file.folderId) {
      commitInput.folderId = target.folderId;
    }
    const commit: Commit | null =
      commitInput.name !== undefined || commitInput.folderId !== undefined
        ? {
            target: file.id,
            step: 'update-file',
            run: async (report) => report.fileUpdated(await data.updateFile(commitInput)),
          }
        : null;
    return runRelocation([placement], [], commit, state.files);
  }

  /* -------------------------------- deletion ------------------------------ */

  async function deleteFileGroup(
    key: string,
    groupFiles: readonly MaterialFile[],
    refs: KeyReferences,
    report: ReportBuilder
  ): Promise<void> {
    const ids = new Set(groupFiles.map((file) => file.id));
    // The object first: if that fails the rows stay, so a re-run finds it again.
    if (!refs.isReferenced(key, ids)) {
      try {
        await objects.remove(key);
        report.removed(key);
      } catch (error) {
        report.fail('remove-object', key, error);
        groupFiles.forEach((file) => report.defer(file.id));
        return;
      }
    }
    for (const file of groupFiles) {
      try {
        await data.deleteFile(file.id);
        refs.release(file.id);
        report.fileDeleted(file.id);
      } catch (error) {
        report.fail('delete-file', file.id, error);
      }
    }
  }

  /* ------------------------------- the service ---------------------------- */

  return {
    async listFolders(studentId) {
      requireStudent(studentId);
      return loadFolders(studentId);
    },

    async listChildren(studentId, parentId) {
      requireStudent(studentId);
      if (parentId === null) {
        // Root folders have no `parentId`, so they are not in the byParent index.
        return getChildren(null, await loadFolders(studentId));
      }
      const children = (await data.listFoldersByParent(parentId)).filter(
        (folder) => folder.studentId === studentId
      );
      return getChildren(parentId, children);
    },

    async listFiles(studentId) {
      requireStudent(studentId);
      return loadFiles(studentId);
    },

    async createFolder(studentId, parentId, name) {
      requireStudent(studentId);
      const folders = await loadFolders(studentId);
      if (parentId !== null) {
        requireFolder(folders, parentId, 'Parent folder');
      }
      const check = validateCreate(parentId, name, studentId, folders);
      if (!check.valid) {
        throw new MaterialsOperationError('invalid', check.error ?? 'Invalid folder name.');
      }
      const normalized = normalizeFolderName(name);
      let path = normalized;
      if (parentId !== null) {
        const parentPath = materializedPaths(folders).get(parentId);
        if (parentPath === undefined || parentPath === null) {
          throw new MaterialsOperationError('invalid', INCONSISTENT_HIERARCHY);
        }
        path = `${parentPath}${PATH_SEPARATOR}${normalized}`;
      }
      const input: CreateFolderNodeInput = {
        studentId,
        name: normalized,
        path,
        createdDate: now().toISOString(),
      };
      if (parentId !== null) {
        input.parentId = parentId;
      }
      return data.createFolder(input);
    },

    async renameFolder(studentId, folderId, newName) {
      requireStudent(studentId);
      const state = await loadAll(studentId);
      const folder = requireFolder(state.folders, folderId, 'Folder');
      const siblingNames = getChildren(folder.parentId ?? null, state.folders)
        .filter((node) => node.id !== folder.id)
        .map((node) => node.name);
      const check = validateFolderName(newName, siblingNames);
      if (!check.valid) {
        throw new MaterialsOperationError('invalid', check.error ?? 'Invalid folder name.');
      }
      return relocateFolder(studentId, state, folder, {
        id: folder.id,
        name: normalizeFolderName(newName),
      });
    },

    async moveFolder(studentId, folderId, newParentId) {
      requireStudent(studentId);
      const state = await loadAll(studentId);
      const folder = requireFolder(state.folders, folderId, 'Folder');
      if (newParentId !== null) {
        requireFolder(state.folders, newParentId, 'Destination folder');
      }
      const check = validateMove(folder.id, newParentId, state.folders);
      if (!check.valid) {
        throw new MaterialsOperationError('invalid', check.error ?? 'Invalid move.');
      }
      return relocateFolder(studentId, state, folder, { id: folder.id, parentId: newParentId });
    },

    async deleteFolder(studentId, folderId) {
      requireStudent(studentId);
      const state = await loadAll(studentId);
      const folder = requireFolder(state.folders, folderId, 'Folder');
      const levels = subtreeLevels(folder.id, state.folders);
      const subtreeIds = new Set(levels.flat().map((node) => node.id));
      const doomed = state.files.filter((file) => subtreeIds.has(file.folderId));
      doomed.forEach((file) => requireMaterialsKey(studentId, file));

      const report = new ReportBuilder();
      const refs = new KeyReferences(state.files);

      // 2. Objects, then their rows.
      await forEachConcurrently([...groupByKey(doomed)], concurrency, ([key, groupFiles]) =>
        deleteFileGroup(key, groupFiles, refs, report)
      );

      // 3. Folders, deepest level first; a folder that still holds a file or a
      //    subfolder stays, and so do its ancestors.
      const blocked = new Set(
        doomed.filter((file) => !report.isFileDeleted(file.id)).map((file) => file.folderId)
      );
      const block = (node: FolderNode): void => {
        if (node.parentId !== null) {
          blocked.add(node.parentId);
        }
      };
      for (const level of [...levels].reverse()) {
        await forEachConcurrently(level, concurrency, async (node) => {
          if (blocked.has(node.id)) {
            report.defer(node.id);
            block(node);
            return;
          }
          try {
            await data.deleteFolder(node.id);
            report.folderDeleted(node.id);
          } catch (error) {
            report.fail('delete-folder', node.id, error);
            block(node);
          }
        });
      }
      return report.build();
    },

    async renameFile(studentId, fileId, newName) {
      requireStudent(studentId);
      const state = await loadAll(studentId);
      const file = requireFile(state.files, fileId);
      const name = validateFileRename(file, newName);
      const folderPath = folderPathOf(file.folderId, state.folders);
      if (folderPath === null) {
        throw new MaterialsOperationError(
          'invalid',
          'The folder of this file no longer exists. Move the file to an existing folder first.'
        );
      }
      return relocateFile(studentId, state, file, { name, folderId: file.folderId }, folderPath, folderPath);
    },

    async moveFile(studentId, fileId, targetFolderId) {
      requireStudent(studentId);
      const state = await loadAll(studentId);
      const file = requireFile(state.files, fileId);
      const destination =
        targetFolderId === null || targetFolderId === ROOT_FILE_FOLDER_ID ? null : targetFolderId;
      if (destination !== null) {
        requireFolder(state.folders, destination, 'Destination folder');
      }
      const targetPath = folderPathOf(destination ?? ROOT_FILE_FOLDER_ID, state.folders);
      if (targetPath === null) {
        throw new MaterialsOperationError('invalid', INCONSISTENT_HIERARCHY);
      }
      return relocateFile(
        studentId,
        state,
        file,
        { name: file.name, folderId: destination ?? ROOT_FILE_FOLDER_ID },
        folderPathOf(file.folderId, state.folders),
        targetPath
      );
    },

    async deleteFile(studentId, fileId) {
      requireStudent(studentId);
      const files = await loadFiles(studentId);
      const file = requireFile(files, fileId);
      requireMaterialsKey(studentId, file);
      const report = new ReportBuilder();
      await deleteFileGroup(file.s3Key, [file], new KeyReferences(files), report);
      return report.build();
    },
  };
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function requireStudent(studentId: string): void {
  if (typeof studentId !== 'string' || studentId.trim() === '') {
    throw new MaterialsOperationError('invalid', 'A signed-in student is required.');
  }
}

function requireFolder(folders: readonly FolderNode[], id: string, label: string): FolderNode {
  const folder = folders.find((node) => node.id === id);
  if (!folder) {
    throw new MaterialsOperationError('not-found', `${label} does not exist.`);
  }
  return folder;
}

function requireFile(files: readonly MaterialFile[], id: string): MaterialFile {
  const file = files.find((candidate) => candidate.id === id);
  if (!file) {
    throw new MaterialsOperationError('not-found', 'File does not exist.');
  }
  return file;
}

/** The key's parts, or `forbidden` when the key is outside the student's Materials area. */
function requireMaterialsKey(studentId: string, file: MaterialFile): MaterialsKeyParts {
  const parts = splitMaterialsKey(file.s3Key);
  if (!parts || (parts.layout === 'students' && parts.ownerSegment !== studentId)) {
    throw new MaterialsOperationError(
      'forbidden',
      `"${file.name}" is not stored in your Materials area, so it cannot be changed here.`
    );
  }
  return parts;
}

/** Materialized path of a file's folder: '' for the root, null when it cannot be resolved. */
function folderPathOf(folderId: string, folders: readonly FolderNode[]): string | null {
  if (folderId === ROOT_FILE_FOLDER_ID) {
    return '';
  }
  return materializedPaths(folders).get(folderId) ?? null;
}

/** The trimmed new name; the extension must stay the same (Bedrock parses by extension). */
function validateFileRename(file: MaterialFile, newName: string): string {
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (name === '') {
    throw new MaterialsOperationError('invalid', 'File name cannot be empty.');
  }
  if (name.includes('/')) {
    throw new MaterialsOperationError('invalid', 'File name cannot contain the "/" character.');
  }
  const extension = extractExtension(name);
  if (!isAllowedExtension(extension)) {
    throw new MaterialsOperationError(
      'invalid',
      `Unsupported file format. Allowed formats: ${allowedFormatsMessage()}.`
    );
  }
  if (extension !== extractExtension(file.name)) {
    throw new MaterialsOperationError('invalid', 'Renaming a file cannot change its extension.');
  }
  return name;
}

/** Refuses a move whose target key already belongs to a file outside the move. */
function assertNoCollisions(placements: readonly Placement[], files: readonly MaterialFile[]): void {
  const moving = new Set(placements.map((placement) => placement.file.id));
  for (const placement of placements) {
    if (placement.file.s3Key === placement.targetKey) {
      continue;
    }
    const clash = files.find((other) => !moving.has(other.id) && other.s3Key === placement.targetKey);
    if (clash) {
      throw new MaterialsOperationError(
        'conflict',
        `A file named "${clash.name}" already exists at the destination.`
      );
    }
  }
}

function folderCommitInput(
  folder: FolderNode,
  change: AdjacencyChange,
  targetPath: string
): UpdateFolderNodeInput | null {
  const input: UpdateFolderNodeInput = { id: folder.id };
  let changed = false;
  if (change.name !== undefined && change.name !== folder.name) {
    input.name = change.name;
    changed = true;
  }
  if (change.parentId !== undefined && change.parentId !== (folder.parentId ?? null)) {
    input.parentId = change.parentId;
    changed = true;
  }
  if (targetPath !== folder.path) {
    input.path = targetPath;
    changed = true;
  }
  return changed ? input : null;
}

/** The subtree of `rootId` by depth: `[[root], [children], [grandchildren], ...]`. Cycle-safe. */
function subtreeLevels(rootId: string, folders: readonly FolderNode[]): FolderNode[][] {
  const root = folders.find((node) => node.id === rootId);
  if (!root) {
    return [];
  }
  const childrenOf = new Map<string, FolderNode[]>();
  for (const node of folders) {
    if (node.parentId === null) {
      continue;
    }
    const siblings = childrenOf.get(node.parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenOf.set(node.parentId, [node]);
    }
  }
  const levels: FolderNode[][] = [[root]];
  const seen = new Set<string>([root.id]);
  for (;;) {
    const next: FolderNode[] = [];
    for (const node of levels[levels.length - 1]) {
      for (const child of childrenOf.get(node.id) ?? []) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          next.push(child);
        }
      }
    }
    if (next.length === 0) {
      return levels;
    }
    levels.push(next);
  }
}

interface PlacementGroup {
  storedKey: string;
  targetKey: string;
  targetFolderPath: string;
  /** Rows sharing the stored key (a file uploaded twice under one name). */
  files: MaterialFile[];
}

function groupPlacements(placements: readonly Placement[]): PlacementGroup[] {
  const groups = new Map<string, PlacementGroup>();
  for (const placement of placements) {
    const id = JSON.stringify([placement.file.s3Key, placement.targetKey]);
    const group = groups.get(id);
    if (group) {
      group.files.push(placement.file);
    } else {
      groups.set(id, {
        storedKey: placement.file.s3Key,
        targetKey: placement.targetKey,
        targetFolderPath: placement.targetFolderPath,
        files: [placement.file],
      });
    }
  }
  return [...groups.values()];
}

function groupByKey(files: readonly MaterialFile[]): Map<string, MaterialFile[]> {
  const groups = new Map<string, MaterialFile[]>();
  for (const file of files) {
    const group = groups.get(file.s3Key);
    if (group) {
      group.push(file);
    } else {
      groups.set(file.s3Key, [file]);
    }
  }
  return groups;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Runs `worker` over `items` with at most `limit` in flight. Workers must not throw. */
async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Which MaterialFile rows point at which object key, kept current while an operation runs. */
class KeyReferences {
  private readonly idsByKey = new Map<string, Set<string>>();

  private readonly keyById = new Map<string, string>();

  constructor(files: readonly MaterialFile[]) {
    for (const file of files) {
      this.point(file.id, file.s3Key);
    }
  }

  point(id: string, key: string): void {
    this.release(id);
    this.keyById.set(id, key);
    const ids = this.idsByKey.get(key);
    if (ids) {
      ids.add(id);
    } else {
      this.idsByKey.set(key, new Set([id]));
    }
  }

  release(id: string): void {
    const key = this.keyById.get(id);
    if (key === undefined) {
      return;
    }
    this.keyById.delete(id);
    const ids = this.idsByKey.get(key);
    ids?.delete(id);
    if (ids && ids.size === 0) {
      this.idsByKey.delete(key);
    }
  }

  /** Whether a row other than those in `except` points at `key`. */
  isReferenced(key: string, except: ReadonlySet<string> = new Set()): boolean {
    for (const id of this.idsByKey.get(key) ?? []) {
      if (!except.has(id)) {
        return true;
      }
    }
    return false;
  }
}

class ReportBuilder {
  private readonly folders = new Map<string, FolderNode>();

  private readonly files = new Map<string, MaterialFile>();

  private readonly deletedFolders: string[] = [];

  private readonly deletedFiles = new Set<string>();

  private readonly copies: ObjectCopy[] = [];

  private readonly removals: string[] = [];

  private readonly failures: OperationFailure[] = [];

  private readonly deferredIds = new Set<string>();

  get failed(): boolean {
    return this.failures.length > 0;
  }

  folderUpdated(folder: FolderNode): void {
    this.folders.delete(folder.id);
    this.folders.set(folder.id, folder);
  }

  fileUpdated(file: MaterialFile): void {
    this.files.delete(file.id);
    this.files.set(file.id, file);
  }

  folderDeleted(id: string): void {
    this.deletedFolders.push(id);
  }

  fileDeleted(id: string): void {
    this.deletedFiles.add(id);
  }

  isFileDeleted(id: string): boolean {
    return this.deletedFiles.has(id);
  }

  copied(from: string, to: string): void {
    this.copies.push({ from, to });
  }

  removed(key: string): void {
    this.removals.push(key);
  }

  fail(step: OperationStep, target: string, error: unknown): void {
    this.failures.push({ step, target, message: errorMessage(error) });
  }

  defer(id: string): void {
    this.deferredIds.add(id);
  }

  build(): MaterialsOperationReport {
    return {
      complete: this.failures.length === 0,
      foldersUpdated: [...this.folders.values()],
      foldersDeleted: [...this.deletedFolders],
      filesUpdated: [...this.files.values()],
      filesDeleted: [...this.deletedFiles],
      objectsCopied: [...this.copies],
      objectsRemoved: [...this.removals],
      failures: [...this.failures],
      deferred: [...this.deferredIds],
    };
  }
}

/** A one-line description of anything thrown (Error, GraphQL error payload, ...). */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'object' && error !== null) {
    const { errors, message } = error as { errors?: unknown; message?: unknown };
    if (Array.isArray(errors)) {
      const messages = errors
        .map((entry) => (entry as { message?: unknown } | null)?.message)
        .filter((text): text is string => typeof text === 'string' && text !== '');
      if (messages.length > 0) {
        return messages.join('; ');
      }
    }
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
}

/* ========================================================================== *
 * Default (production) seams
 *
 * Bound to the Amplify SDK only through dynamic `import()` inside the method
 * bodies, exactly like `uploadMaterial.ts`: importing this module never runs
 * Amplify code, and tests inject their own seams.
 * ========================================================================== */

/** A GraphQL operation as sent through {@link GraphqlRequester}. */
export interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

export interface GraphqlErrorLike {
  message?: string;
  errorType?: string | null;
}

export interface GraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: readonly GraphqlErrorLike[];
}

/**
 * Sends one GraphQL operation. Amplify's client rejects with the
 * `{ data, errors }` response when AppSync reports errors; both that and a
 * resolved response carrying `errors` are handled.
 */
export type GraphqlRequester = (request: GraphqlRequest) => Promise<GraphqlResponse>;

/** AppSync reported errors for an operation. */
export class GraphqlOperationError extends Error {
  /** AppSync `errorType`s, e.g. `DynamoDB:ConditionalCheckFailedException`. */
  readonly errorTypes: readonly string[];

  constructor(operation: string, errors: readonly GraphqlErrorLike[]) {
    const messages = errors
      .map((entry) => entry?.message)
      .filter((text): text is string => typeof text === 'string' && text !== '');
    super(`${operation} failed: ${messages.length > 0 ? messages.join('; ') : 'unknown GraphQL error'}`);
    this.name = 'GraphqlOperationError';
    this.errorTypes = errors
      .map((entry) => entry?.errorType)
      .filter((type): type is string => typeof type === 'string');
  }
}

/** What an Amplify `@model` delete resolver reports for a row that does not exist. */
export const CONDITIONAL_CHECK_FAILED = 'DynamoDB:ConditionalCheckFailedException';

/** Page size requested from the list queries (`nextToken` is followed to the end). */
export const DEFAULT_PAGE_SIZE = 100;

const FOLDER_FIELDS = 'id studentId name parentId path createdDate';
const FILE_FIELDS =
  'id studentId folderId name size format uploadDate indexingStatus s3Key folderPath';

/*
 * Inline documents for the queries / mutations the `@model` and `@index`
 * directives in `amplify/backend/api/fmios/schema.graphql` generate (no
 * generated `src/graphql` exists yet, as in `uploadMaterial.ts`).
 */

export const FOLDER_NODES_BY_STUDENT_QUERY = /* GraphQL */ `
  query FolderNodesByStudent($studentId: ID!, $limit: Int, $nextToken: String) {
    folderNodesByStudent(studentId: $studentId, limit: $limit, nextToken: $nextToken) {
      items { ${FOLDER_FIELDS} }
      nextToken
    }
  }
`;

export const FOLDER_NODES_BY_PARENT_QUERY = /* GraphQL */ `
  query FolderNodesByParent($parentId: ID!, $limit: Int, $nextToken: String) {
    folderNodesByParent(parentId: $parentId, sortDirection: ASC, limit: $limit, nextToken: $nextToken) {
      items { ${FOLDER_FIELDS} }
      nextToken
    }
  }
`;

export const MATERIAL_FILES_BY_STUDENT_QUERY = /* GraphQL */ `
  query MaterialFilesByStudent($studentId: ID!, $limit: Int, $nextToken: String) {
    materialFilesByStudent(studentId: $studentId, limit: $limit, nextToken: $nextToken) {
      items { ${FILE_FIELDS} }
      nextToken
    }
  }
`;

export const CREATE_FOLDER_NODE_MUTATION = /* GraphQL */ `
  mutation CreateFolderNode($input: CreateFolderNodeInput!) {
    createFolderNode(input: $input) { ${FOLDER_FIELDS} }
  }
`;

export const UPDATE_FOLDER_NODE_MUTATION = /* GraphQL */ `
  mutation UpdateFolderNode($input: UpdateFolderNodeInput!) {
    updateFolderNode(input: $input) { ${FOLDER_FIELDS} }
  }
`;

export const DELETE_FOLDER_NODE_MUTATION = /* GraphQL */ `
  mutation DeleteFolderNode($input: DeleteFolderNodeInput!) {
    deleteFolderNode(input: $input) { id }
  }
`;

export const UPDATE_MATERIAL_FILE_MUTATION = /* GraphQL */ `
  mutation UpdateMaterialFile($input: UpdateMaterialFileInput!) {
    updateMaterialFile(input: $input) { ${FILE_FIELDS} }
  }
`;

export const DELETE_MATERIAL_FILE_MUTATION = /* GraphQL */ `
  mutation DeleteMaterialFile($input: DeleteMaterialFileInput!) {
    deleteMaterialFile(input: $input) { id }
  }
`;

interface GraphqlClientLike {
  graphql(request: GraphqlRequest): Promise<GraphqlResponse>;
}

/** Production transport; binds to Amplify only when a request is made. */
const amplifyGraphql: GraphqlRequester = async (request) => {
  const { generateClient } = await import('aws-amplify/api');
  const client = generateClient() as unknown as GraphqlClientLike;
  return client.graphql(request);
};

export interface AppSyncMaterialsDataStoreOptions {
  /** GraphQL transport. Defaults to Amplify's `generateClient().graphql`. */
  graphql?: GraphqlRequester;
  /** `limit` per list page. Defaults to {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
}

/** {@link MaterialsDataStore} over the AppSync API generated from the `fmios` schema. */
export function createAppSyncMaterialsDataStore(
  options: AppSyncMaterialsDataStoreOptions = {}
): MaterialsDataStore {
  const graphql = options.graphql ?? amplifyGraphql;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  async function request(
    operation: string,
    query: string,
    variables: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    let response: GraphqlResponse;
    try {
      response = await graphql({ query, variables });
    } catch (error) {
      const errors = (error as { errors?: unknown } | null)?.errors;
      if (Array.isArray(errors)) {
        throw new GraphqlOperationError(operation, errors as GraphqlErrorLike[]);
      }
      throw error;
    }
    if (response?.errors && response.errors.length > 0) {
      throw new GraphqlOperationError(operation, response.errors);
    }
    return response?.data ?? {};
  }

  async function listAll<T>(
    field: string,
    query: string,
    variables: Record<string, unknown>,
    toRow: (raw: unknown) => T | null
  ): Promise<T[]> {
    const rows: T[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    do {
      const data: Record<string, unknown> = await request(field, query, {
        ...variables,
        limit: pageSize,
        nextToken,
      });
      const page = data[field] as { items?: unknown; nextToken?: unknown } | null | undefined;
      const items: unknown[] = Array.isArray(page?.items) ? (page?.items as unknown[]) : [];
      for (const raw of items) {
        // AppSync nulls out items the caller may not read; skip them.
        const row = toRow(raw);
        if (row !== null) {
          rows.push(row);
        }
      }
      const token: unknown = page?.nextToken;
      nextToken = typeof token === 'string' && token !== '' ? token : null;
      if (nextToken !== null) {
        if (seenTokens.has(nextToken)) {
          throw new Error(`${field} returned the same nextToken twice.`);
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken !== null);
    return rows;
  }

  async function mutateRow<T>(
    field: string,
    query: string,
    input: object,
    toRow: (raw: unknown) => T | null
  ): Promise<T> {
    const data = await request(field, query, { input });
    const row = toRow(data[field]);
    if (row === null) {
      throw new Error(`${field} returned no record.`);
    }
    return row;
  }

  async function deleteRow(field: string, query: string, id: string): Promise<void> {
    try {
      await request(field, query, { input: { id } });
    } catch (error) {
      if (error instanceof GraphqlOperationError && error.errorTypes.includes(CONDITIONAL_CHECK_FAILED)) {
        return; // Already gone: deletes are idempotent so a resumed operation can repeat them.
      }
      throw error;
    }
  }

  return {
    listFoldersByStudent: (studentId) =>
      listAll('folderNodesByStudent', FOLDER_NODES_BY_STUDENT_QUERY, { studentId }, toFolderNode),
    listFoldersByParent: (parentId) =>
      listAll('folderNodesByParent', FOLDER_NODES_BY_PARENT_QUERY, { parentId }, toFolderNode),
    listFilesByStudent: (studentId) =>
      listAll('materialFilesByStudent', MATERIAL_FILES_BY_STUDENT_QUERY, { studentId }, toMaterialFile),
    createFolder: (input) =>
      mutateRow('createFolderNode', CREATE_FOLDER_NODE_MUTATION, input, toFolderNode),
    updateFolder: (input) =>
      mutateRow('updateFolderNode', UPDATE_FOLDER_NODE_MUTATION, input, toFolderNode),
    deleteFolder: (id) => deleteRow('deleteFolderNode', DELETE_FOLDER_NODE_MUTATION, id),
    updateFile: (input) =>
      mutateRow('updateMaterialFile', UPDATE_MATERIAL_FILE_MUTATION, input, toMaterialFile),
    deleteFile: (id) => deleteRow('deleteMaterialFile', DELETE_MATERIAL_FILE_MUTATION, id),
  };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

function toFolderNode(raw: unknown): FolderNode | null {
  const row = asRecord(raw);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.studentId !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.path !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    studentId: row.studentId,
    name: row.name,
    parentId: typeof row.parentId === 'string' && row.parentId !== '' ? row.parentId : null,
    path: row.path,
    createdDate: typeof row.createdDate === 'string' ? row.createdDate : '',
  };
}

const INDEXING_STATUSES: readonly string[] = ['PENDING', 'INDEXING', 'INDEXED', 'FAILED'];

function toMaterialFile(raw: unknown): MaterialFile | null {
  const row = asRecord(raw);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.studentId !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.s3Key !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    studentId: row.studentId,
    folderId: typeof row.folderId === 'string' ? row.folderId : ROOT_FILE_FOLDER_ID,
    name: row.name,
    size: typeof row.size === 'number' ? row.size : 0,
    format: typeof row.format === 'string' ? row.format : '',
    uploadDate: typeof row.uploadDate === 'string' ? row.uploadDate : '',
    indexingStatus:
      typeof row.indexingStatus === 'string' && INDEXING_STATUSES.includes(row.indexingStatus)
        ? (row.indexingStatus as IndexingStatus)
        : 'PENDING',
    s3Key: row.s3Key,
    folderPath: typeof row.folderPath === 'string' ? row.folderPath : '',
  };
}

/**
 * {@link MaterialsObjectStore} over Amplify Storage. Keys are absolute
 * (`private/{identityId}/materials/...`, as stored in `MaterialFile.s3Key`);
 * the student's IAM policy only admits their own prefix.
 */
export function createAmplifyMaterialsObjectStore(): MaterialsObjectStore {
  return {
    async copy(sourceKey, destinationKey) {
      const { copy } = await import('aws-amplify/storage');
      // CopyObject with MetadataDirective COPY: the `studentid` metadata stays.
      await copy({ source: { path: sourceKey }, destination: { path: destinationKey } });
    },

    async remove(key) {
      const { remove } = await import('aws-amplify/storage');
      await remove({ path: key });
    },

    async exists(key) {
      // A one-item listing under the key itself rather than HEAD: the student's
      // ListBucket permission is prefix-scoped, and without it S3 answers HEAD
      // on a missing key with 403 instead of 404.
      const { list } = await import('aws-amplify/storage');
      const { items } = await list({ path: key, options: { pageSize: 1 } });
      return items.some((item) => item.path === key);
    },
  };
}

/** The production {@link FolderService}: AppSync rows and Amplify Storage objects. */
export function createDefaultFolderService(): FolderService {
  return createFolderService({
    data: createAppSyncMaterialsDataStore(),
    objects: createAmplifyMaterialsObjectStore(),
  });
}
