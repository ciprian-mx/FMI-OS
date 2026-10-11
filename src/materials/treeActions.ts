/**
 * Pure decision helpers behind the MaterialsApp context-menu actions
 * (Task 4.2, Requirements 7.2 / 7.8).
 *
 * The tree view lets a student create, rename, move and delete folders, and
 * rename, move and delete files. Everything the UI must *decide* before it fires
 * a callback lives here so it can be unit-tested without a DOM:
 *
 *   • which destinations a move picker may offer — folders follow
 *     `validateMove` (no cycles, no sibling-name clash), files may go to any
 *     folder (or the Knowledge Base root) other than the one they are in;
 *   • how a file rename treats the extension (see {@link validateFileRename});
 *   • name validation for folder / file renames and new folders;
 *   • how much a recursive folder delete removes, for the confirmation copy.
 *
 * Folder rules are not reimplemented: names go through `normalizeFolderName` /
 * `validateFolderName` / `validateCreate` and moves through `validateMove` from
 * the task 4.1 data layer (`./folderHierarchy`).
 */
import {
  FolderNode,
  PATH_SEPARATOR,
  ValidationResult,
  getAncestors,
  getChildren,
  getDescendants,
  indexById,
  normalizeFolderName,
  validateCreate,
  validateFolderName,
  validateMove,
} from './folderHierarchy';
import type { MaterialFile } from './MaterialsApp';

/** Display name of the synthetic root that represents the whole Knowledge Base. */
export const KNOWLEDGE_BASE_LABEL = 'Knowledge Base';

/** Separator for human-readable locations (matches `MaterialFile.folderPath`). */
export const LOCATION_SEPARATOR = ' > ';

/** A name check that, on success, carries the exact (normalized) name to persist. */
export type NameCheck =
  | { valid: true; name: string }
  | { valid: false; error: string };

/** A destination offered by a move picker. `folderId: null` is the Knowledge Base root. */
export interface MoveTarget {
  folderId: string | null;
  /** Full location, e.g. "Knowledge Base > Data Structures > Week 3". */
  label: string;
}

/** How much a recursive folder delete removes besides the folder itself. */
export interface FolderContents {
  /** Every descendant folder (children, grandchildren, ...). */
  folders: number;
  /** Every file in the folder or any descendant folder. */
  files: number;
}

/** The parts of a file name the rename editor works with. */
export interface FileNameParts {
  /** Everything before the last dot, e.g. "Sorting" for "Sorting.pdf". */
  base: string;
  /** The extension without its dot, e.g. "pdf"; empty when there is none. */
  extension: string;
}

/** Case- and whitespace-insensitive name equality, mirroring the folder sibling rule. */
function sameName(a: string, b: string): boolean {
  return normalizeFolderName(a).toLowerCase() === normalizeFolderName(b).toLowerCase();
}

/**
 * Folders reachable from the Knowledge Base root, in the depth-first,
 * name-sorted order the tree renders them. Orphans (dangling `parentId`) are
 * not rendered by the tree, so they are not listed here either. Cycle-safe.
 */
export function foldersInTreeOrder(folders: readonly FolderNode[]): FolderNode[] {
  const ordered: FolderNode[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    for (const child of getChildren(parentId, folders)) {
      if (seen.has(child.id)) {
        continue;
      }
      seen.add(child.id);
      ordered.push(child);
      visit(child.id);
    }
  };
  visit(null);
  return ordered;
}

/**
 * Human-readable location of a folder, rooted at the Knowledge Base, e.g.
 * "Knowledge Base > Data Structures > Week 3". `null` (or an unknown id) is the
 * root itself.
 */
export function describeLocation(
  folderId: string | null,
  byId: ReadonlyMap<string, FolderNode>
): string {
  const node = folderId === null ? undefined : byId.get(folderId);
  if (!node) {
    return KNOWLEDGE_BASE_LABEL;
  }
  const ancestorNames = getAncestors(node, byId)
    .reverse()
    .map((ancestor) => ancestor.name);
  return [KNOWLEDGE_BASE_LABEL, ...ancestorNames, node.name].join(LOCATION_SEPARATOR);
}

/**
 * The folder a file is displayed in: its `folderId` when that folder exists,
 * otherwise `null` (the Knowledge Base root). This mirrors the tree, which
 * surfaces files with an unknown folder (e.g. root uploads stored with an empty
 * `folderId`) at the root.
 */
export function resolveFileFolderId(
  file: Pick<MaterialFile, 'folderId'>,
  byId: ReadonlyMap<string, FolderNode>
): string | null {
  return byId.has(file.folderId) ? file.folderId : null;
}

/**
 * Valid destinations for moving folder `folderId`: the root plus every rendered
 * folder for which `validateMove` succeeds — which excludes the folder itself,
 * its descendants (cycles) and any parent that already has a same-named child.
 * The folder's current parent is omitted too: "moving" there is a no-op.
 */
export function getFolderMoveTargets(
  folderId: string,
  folders: readonly FolderNode[]
): MoveTarget[] {
  const byId = indexById(folders);
  const node = byId.get(folderId);
  if (!node) {
    return [];
  }
  const currentParentId = node.parentId ?? null;
  const candidates: Array<string | null> = [
    null,
    ...foldersInTreeOrder(folders).map((folder) => folder.id),
  ];
  return candidates
    .filter(
      (candidate) =>
        candidate !== currentParentId &&
        validateMove(folderId, candidate, folders).valid
    )
    .map((candidate) => ({
      folderId: candidate,
      label: describeLocation(candidate, byId),
    }));
}

/**
 * Destinations for moving a file: files may go to any folder (or the root) —
 * there is no cycle constraint — except the one they are already in. A name
 * clash at the destination is reported by {@link validateFileMove} on submit.
 */
export function getFileMoveTargets(
  file: Pick<MaterialFile, 'folderId'>,
  folders: readonly FolderNode[]
): MoveTarget[] {
  const byId = indexById(folders);
  const currentFolderId = resolveFileFolderId(file, byId);
  const candidates: Array<string | null> = [
    null,
    ...foldersInTreeOrder(folders).map((folder) => folder.id),
  ];
  return candidates
    .filter((candidate) => candidate !== currentFolderId)
    .map((candidate) => ({
      folderId: candidate,
      label: describeLocation(candidate, byId),
    }));
}

/**
 * Validates moving `file` into `destinationId` (`null` === root). Rejects an
 * unknown or foreign destination, a no-op move, and a destination that already
 * holds a file with the same name (which would overwrite its S3 object, whose
 * key is `materials/{folderPath}/{fileName}`).
 */
export function validateFileMove(
  file: MaterialFile,
  destinationId: string | null,
  folders: readonly FolderNode[],
  files: readonly MaterialFile[]
): ValidationResult {
  const byId = indexById(folders);
  if (destinationId !== null) {
    const destination = byId.get(destinationId);
    if (!destination) {
      return { valid: false, error: 'Destination folder does not exist.' };
    }
    if (destination.studentId !== file.studentId) {
      return {
        valid: false,
        error: 'Destination folder belongs to another student.',
      };
    }
  }
  if (destinationId === resolveFileFolderId(file, byId)) {
    return { valid: false, error: 'The file is already in this folder.' };
  }
  const clash = files.some(
    (other) =>
      other.id !== file.id &&
      resolveFileFolderId(other, byId) === destinationId &&
      sameName(other.name, file.name)
  );
  if (clash) {
    return {
      valid: false,
      error: `A file named "${file.name}" already exists in ${describeLocation(
        destinationId,
        byId
      )}.`,
    };
  }
  return { valid: true };
}

/**
 * Splits a file name at its last dot. Names without a usable extension — no
 * dot, a leading dot only (".env") or a trailing dot ("draft.") — keep the whole
 * name as `base` and an empty `extension`.
 */
export function splitFileName(name: string): FileNameParts {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return { base: name, extension: '' };
  }
  return { base: name.slice(0, dot), extension: name.slice(dot + 1) };
}

/**
 * Validates a file rename and builds the name to persist.
 *
 * Extension policy: the student edits only the base name; the original
 * extension (with its original casing) is always re-appended. A rename can
 * therefore never change a file's format, so the stored content type, the
 * Knowledge Base parser and the `validateUpload` allow-list stay truthful. If
 * the student types the extension anyway ("Intro.pdf"), it is not doubled.
 * Files without an extension are renamed exactly as typed.
 *
 * The base name is normalized like a folder name (trimmed, inner whitespace
 * collapsed) and must be non-empty and free of the path separator. The result
 * must not clash (case-insensitively) with another file in the same folder.
 */
export function validateFileRename(
  file: MaterialFile,
  typedBase: string,
  folders: readonly FolderNode[],
  files: readonly MaterialFile[]
): NameCheck {
  const { extension } = splitFileName(file.name);
  let base = normalizeFolderName(typedBase);
  if (extension.length > 0) {
    const suffix = `.${extension}`.toLowerCase();
    if (base.toLowerCase().endsWith(suffix)) {
      base = normalizeFolderName(base.slice(0, base.length - suffix.length));
    }
  }
  if (base.length === 0) {
    return { valid: false, error: 'File name cannot be empty.' };
  }
  if (base.includes(PATH_SEPARATOR)) {
    return {
      valid: false,
      error: `File name cannot contain the "${PATH_SEPARATOR}" character.`,
    };
  }
  const name = extension.length > 0 ? `${base}.${extension}` : base;
  const byId = indexById(folders);
  const folderId = resolveFileFolderId(file, byId);
  const clash = files.some(
    (other) =>
      other.id !== file.id &&
      resolveFileFolderId(other, byId) === folderId &&
      sameName(other.name, name)
  );
  if (clash) {
    return { valid: false, error: `A file named "${name}" already exists here.` };
  }
  return { valid: true, name };
}

/**
 * Validates renaming folder `folderId` to `typedName` with `validateFolderName`
 * against its siblings (excluding itself, so a case-only change is allowed).
 */
export function validateFolderRename(
  folderId: string,
  typedName: string,
  folders: readonly FolderNode[]
): NameCheck {
  const node = indexById(folders).get(folderId);
  if (!node) {
    return { valid: false, error: 'Folder to rename does not exist.' };
  }
  const siblingNames = getChildren(node.parentId ?? null, folders)
    .filter((sibling) => sibling.id !== folderId)
    .map((sibling) => sibling.name);
  const check = validateFolderName(typedName, siblingNames);
  if (!check.valid) {
    return { valid: false, error: check.error ?? 'Invalid folder name.' };
  }
  return { valid: true, name: normalizeFolderName(typedName) };
}

/**
 * Validates creating a folder named `typedName` under `parentId` (`null` ===
 * root) with `validateCreate`, returning the normalized name on success.
 */
export function validateNewFolder(
  parentId: string | null,
  typedName: string,
  studentId: string,
  folders: readonly FolderNode[]
): NameCheck {
  const check = validateCreate(parentId, typedName, studentId, folders);
  if (!check.valid) {
    return { valid: false, error: check.error ?? 'Invalid folder name.' };
  }
  return { valid: true, name: normalizeFolderName(typedName) };
}

/** Counts what a recursive delete of `folderId` removes besides the folder itself. */
export function countFolderContents(
  folderId: string,
  folders: readonly FolderNode[],
  files: readonly Pick<MaterialFile, 'folderId'>[]
): FolderContents {
  const descendants = getDescendants(folderId, folders);
  const removed = new Set<string>([
    folderId,
    ...descendants.map((descendant) => descendant.id),
  ]);
  return {
    folders: descendants.length,
    files: files.filter((file) => removed.has(file.folderId)).length,
  };
}

/** "1 subfolder and 2 files"; empty string when there is nothing inside. */
export function describeFolderContents({ folders, files }: FolderContents): string {
  const parts: string[] = [];
  if (folders > 0) {
    parts.push(`${folders} ${folders === 1 ? 'subfolder' : 'subfolders'}`);
  }
  if (files > 0) {
    parts.push(`${files} ${files === 1 ? 'file' : 'files'}`);
  }
  return parts.join(' and ');
}
