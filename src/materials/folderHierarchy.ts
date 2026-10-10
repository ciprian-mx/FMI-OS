/**
 * Materials folder-hierarchy data-layer helpers (Task 4.1, Requirements 7.1 / 7.2).
 *
 * The Materials App stores folders as an *adjacency list* in DynamoDB: each
 * {@link FolderNode} row holds the id of its `parentId` (null for a student's
 * root). On top of that minimal representation this module provides the pure,
 * framework-agnostic operations the UI tree view (task 4.2) and the upload flow
 * (task 4.5) consume:
 *
 *   • building and recomputing the denormalized materialized `path`
 *     (e.g. "Data Structures/Week 3") used for Bedrock KB citations,
 *   • validating parent references before a create / move,
 *   • preventing cycles (a folder may never become its own ancestor),
 *   • listing a node's direct children or its whole subtree,
 *   • planning the recursive `path` rewrites a move entails and the full set of
 *     node ids a recursive delete must remove.
 *
 * Everything here is deliberately storage- and React-agnostic: it operates on
 * plain {@link FolderNode} objects (or a lookup collection of them) and returns
 * plain data describing *what* should change, leaving the actual AppSync /
 * DynamoDB mutations to the caller. That keeps the tricky hierarchy logic
 * trivially unit-testable, mirroring the pure-helper style used in `src/auth/`.
 */

/**
 * A single folder in the Materials hierarchy. Mirrors the `FolderNode` GraphQL
 * `@model` (see `amplify/backend/api/fmios/schema.graphql`): a node knows its
 * owning student, its display `name`, its `parentId` (null at the root) and a
 * denormalized materialized `path`.
 */
export interface FolderNode {
  id: string;
  studentId: string;
  name: string;
  /** `null` for a root folder; otherwise the id of the containing folder. */
  parentId: string | null;
  /** Materialized path, e.g. "Data Structures/Week 3". Root path === its name. */
  path: string;
  createdDate: string;
}

/** Separator used between folder names in a materialized {@link FolderNode.path}. */
export const PATH_SEPARATOR = '/';

/** Structured outcome of a validation check. */
export interface ValidationResult {
  valid: boolean;
  /** Present only when `valid` is false; a human-readable reason. */
  error?: string;
}

/**
 * Describes a single node whose materialized `path` must be rewritten as the
 * result of a create / rename / move. Returned by the planning helpers so the
 * caller can issue exactly the needed `updateFolderNode` mutations.
 */
export interface PathUpdate {
  id: string;
  path: string;
}

/**
 * Normalizes a user-supplied folder name: trims surrounding whitespace and
 * collapses internal runs of whitespace to single spaces. Returns the empty
 * string for input that is empty / whitespace-only, which callers treat as
 * invalid.
 */
export function normalizeFolderName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Validates a proposed folder name. A name is rejected when it is empty after
 * normalization or contains the reserved {@link PATH_SEPARATOR} (which would
 * corrupt the materialized path), and may optionally be rejected as a duplicate
 * of an existing sibling (case-insensitive).
 */
export function validateFolderName(
  name: string,
  siblingNames: readonly string[] = []
): ValidationResult {
  const normalized = normalizeFolderName(name);
  if (normalized.length === 0) {
    return { valid: false, error: 'Folder name cannot be empty.' };
  }
  if (normalized.includes(PATH_SEPARATOR)) {
    return {
      valid: false,
      error: `Folder name cannot contain the "${PATH_SEPARATOR}" character.`,
    };
  }
  const lower = normalized.toLowerCase();
  const clash = siblingNames.some(
    (sibling) => normalizeFolderName(sibling).toLowerCase() === lower
  );
  if (clash) {
    return {
      valid: false,
      error: `A folder named "${normalized}" already exists here.`,
    };
  }
  return { valid: true };
}

/**
 * Builds an id → node lookup map from a flat collection of folders. The input
 * is typically the result of a single `folderNodesByStudent` query.
 */
export function indexById(nodes: readonly FolderNode[]): Map<string, FolderNode> {
  const map = new Map<string, FolderNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

/**
 * Computes the materialized path for a folder named `name` nested under
 * `parent` (or at the root when `parent` is null). The root's path is simply
 * its own (normalized) name; a child's path is `parent.path + "/" + name`.
 */
export function buildPath(parent: FolderNode | null, name: string): string {
  const normalized = normalizeFolderName(name);
  if (!parent) {
    return normalized;
  }
  return `${parent.path}${PATH_SEPARATOR}${normalized}`;
}

/**
 * Returns the chain of ancestors of `node`, nearest parent first, up to and
 * including the root. Returns an empty array for a root node. Guards against a
 * corrupt graph by stopping if a cycle or dangling parent is encountered.
 */
export function getAncestors(
  node: FolderNode,
  byId: ReadonlyMap<string, FolderNode>
): FolderNode[] {
  const ancestors: FolderNode[] = [];
  const seen = new Set<string>([node.id]);
  let current = node.parentId;
  while (current !== null && current !== undefined) {
    if (seen.has(current)) {
      // Cycle detected; stop rather than loop forever.
      break;
    }
    const parent = byId.get(current);
    if (!parent) {
      // Dangling parent reference; stop.
      break;
    }
    ancestors.push(parent);
    seen.add(parent.id);
    current = parent.parentId;
  }
  return ancestors;
}

/**
 * True when `ancestorId` is `node` itself or any ancestor of `node`. Used to
 * reject a move that would place a folder inside its own subtree (a cycle).
 */
export function isAncestor(
  ancestorId: string,
  node: FolderNode,
  byId: ReadonlyMap<string, FolderNode>
): boolean {
  if (ancestorId === node.id) {
    return true;
  }
  return getAncestors(node, byId).some((a) => a.id === ancestorId);
}

/**
 * Returns the direct children of `parentId` (pass `null` for root folders),
 * sorted by name (case-insensitive) for stable tree rendering. Only nodes
 * belonging to the same student as implied by the collection are considered —
 * callers should pass a per-student collection.
 */
export function getChildren(
  parentId: string | null,
  nodes: readonly FolderNode[]
): FolderNode[] {
  return nodes
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' })
    );
}

/**
 * Returns all descendants of `rootId` (children, grandchildren, …), excluding
 * `rootId` itself, via breadth-first traversal of the adjacency list. The
 * traversal is cycle-safe: each node is visited at most once.
 */
export function getDescendants(
  rootId: string,
  nodes: readonly FolderNode[]
): FolderNode[] {
  const childrenByParent = new Map<string, FolderNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? '';
    const bucket = childrenByParent.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      childrenByParent.set(key, [node]);
    }
  }

  const descendants: FolderNode[] = [];
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (seen.has(child.id)) {
        continue;
      }
      seen.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

/**
 * Returns the subtree rooted at `rootId` — the root node followed by all of its
 * descendants. Returns an empty array if `rootId` is unknown.
 */
export function getSubtree(
  rootId: string,
  nodes: readonly FolderNode[]
): FolderNode[] {
  const byId = indexById(nodes);
  const root = byId.get(rootId);
  if (!root) {
    return [];
  }
  return [root, ...getDescendants(rootId, nodes)];
}

/**
 * Validates that a folder with `name` may be created under `parentId`.
 *
 * Checks that the parent exists (when not root) and belongs to `studentId`, and
 * that the name is non-empty, separator-free, and not a duplicate sibling.
 */
export function validateCreate(
  parentId: string | null,
  name: string,
  studentId: string,
  nodes: readonly FolderNode[]
): ValidationResult {
  if (parentId !== null) {
    const byId = indexById(nodes);
    const parent = byId.get(parentId);
    if (!parent) {
      return { valid: false, error: 'Parent folder does not exist.' };
    }
    if (parent.studentId !== studentId) {
      return { valid: false, error: 'Parent folder belongs to another student.' };
    }
  }
  const siblingNames = getChildren(parentId, nodes).map((n) => n.name);
  return validateFolderName(name, siblingNames);
}

/**
 * Validates a proposed move of `nodeId` under `newParentId` (null === promote
 * to root).
 *
 * A move is rejected when:
 *   • the node does not exist,
 *   • the new parent does not exist (and is not root),
 *   • the new parent belongs to a different student,
 *   • the new parent is the node itself or any descendant of it (would create a
 *     cycle), or
 *   • a sibling with the same name already exists at the destination.
 */
export function validateMove(
  nodeId: string,
  newParentId: string | null,
  nodes: readonly FolderNode[]
): ValidationResult {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node) {
    return { valid: false, error: 'Folder to move does not exist.' };
  }

  if (newParentId !== null) {
    const newParent = byId.get(newParentId);
    if (!newParent) {
      return { valid: false, error: 'Destination folder does not exist.' };
    }
    if (newParent.studentId !== node.studentId) {
      return {
        valid: false,
        error: 'Destination folder belongs to another student.',
      };
    }
    // A folder cannot be moved into itself or any of its own descendants.
    if (isAncestor(nodeId, newParent, byId)) {
      return {
        valid: false,
        error: 'A folder cannot be moved into itself or one of its subfolders.',
      };
    }
  }

  // No-op moves (same parent) are allowed; only check sibling-name clashes
  // against *other* folders at the destination.
  const siblingNames = getChildren(newParentId, nodes)
    .filter((n) => n.id !== nodeId)
    .map((n) => n.name);
  const nameCheck = validateFolderName(node.name, siblingNames);
  if (!nameCheck.valid) {
    return nameCheck;
  }

  return { valid: true };
}

/**
 * Plans the materialized-path rewrites for moving `nodeId` under `newParentId`.
 *
 * Returns the new path for the moved node plus every descendant, so the caller
 * can persist the recomputed paths. The caller is still responsible for
 * updating the moved node's `parentId`. Throws if the move is invalid — callers
 * should gate with {@link validateMove} first.
 */
export function planMove(
  nodeId: string,
  newParentId: string | null,
  nodes: readonly FolderNode[]
): PathUpdate[] {
  const validation = validateMove(nodeId, newParentId, nodes);
  if (!validation.valid) {
    throw new Error(validation.error ?? 'Invalid move.');
  }

  const byId = indexById(nodes);
  const node = byId.get(nodeId) as FolderNode;
  const newParent = newParentId === null ? null : byId.get(newParentId) ?? null;

  const movedPath = buildPath(newParent, node.name);
  const updates: PathUpdate[] = [{ id: node.id, path: movedPath }];

  // Recompute descendant paths by replacing the moved node's old path prefix
  // with its new path. Processing in subtree order keeps parents' new paths
  // available, but prefix replacement off the *old* paths is order-independent.
  const oldPrefix = node.path;
  for (const descendant of getDescendants(nodeId, nodes)) {
    const suffix = descendant.path.slice(oldPrefix.length);
    updates.push({ id: descendant.id, path: `${movedPath}${suffix}` });
  }
  return updates;
}

/**
 * Plans the materialized-path rewrites for renaming `nodeId` to `newName`.
 *
 * Like {@link planMove}, returns the new path for the renamed node and all of
 * its descendants. Throws if the new name is invalid (empty, contains the
 * separator, or clashes with a sibling).
 */
export function planRename(
  nodeId: string,
  newName: string,
  nodes: readonly FolderNode[]
): PathUpdate[] {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node) {
    throw new Error('Folder to rename does not exist.');
  }

  const siblingNames = getChildren(node.parentId ?? null, nodes)
    .filter((n) => n.id !== nodeId)
    .map((n) => n.name);
  const nameCheck = validateFolderName(newName, siblingNames);
  if (!nameCheck.valid) {
    throw new Error(nameCheck.error ?? 'Invalid folder name.');
  }

  const parent = node.parentId === null ? null : byId.get(node.parentId) ?? null;
  const newPath = buildPath(parent, newName);
  const updates: PathUpdate[] = [{ id: node.id, path: newPath }];

  const oldPrefix = node.path;
  for (const descendant of getDescendants(nodeId, nodes)) {
    const suffix = descendant.path.slice(oldPrefix.length);
    updates.push({ id: descendant.id, path: `${newPath}${suffix}` });
  }
  return updates;
}

/**
 * Returns the complete set of folder ids a recursive delete of `nodeId` must
 * remove: the node itself plus every descendant. The caller uses this to delete
 * all `FolderNode` rows (and trigger KB deletion for files in them). Returns an
 * empty array when `nodeId` is unknown.
 */
export function planDelete(
  nodeId: string,
  nodes: readonly FolderNode[]
): string[] {
  return getSubtree(nodeId, nodes).map((n) => n.id);
}
