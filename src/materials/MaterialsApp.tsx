import React, { useCallback, useMemo, useState } from 'react';
import {
  FolderNode,
  getChildren,
  indexById,
} from './folderHierarchy';
import './MaterialsApp.css';

/**
 * MaterialsApp tree view (Task 4.2, Requirements 7.1 / 7.2).
 *
 * Renders the student's Materials Knowledge Base as a hierarchical, expandable
 * folder tree with the files that live inside each folder. The component is the
 * presentational / interaction layer only: it consumes the *flat* adjacency-list
 * {@link FolderNode}s produced by the data layer (task 4.1,
 * `src/materials/folderHierarchy.ts`) and never reimplements tree traversal —
 * child lookup is delegated to {@link getChildren}. Data loading over AppSync and
 * S3 uploads are later tasks (4.5+/16.x); here the folders and files arrive as
 * props and all mutations are surfaced as callbacks so the parent owns side
 * effects.
 *
 * Behaviour mirrors the design's MaterialsApp:
 * - a hierarchical tree of nested, expandable folders (expand / collapse),
 * - a root entry representing the entire Knowledge Base,
 * - the files inside each expanded folder, each showing its indexing status,
 * - a single "selected" folder, highlighted and used as the default target for
 *   a new-folder action.
 */

/** Indexing lifecycle of a file in the Bedrock Knowledge Base. */
export type IndexingStatus = 'PENDING' | 'INDEXING' | 'INDEXED' | 'FAILED';

/**
 * A file stored inside a Materials folder. Mirrors the `MaterialFile` GraphQL
 * `@model`: a file knows its owning student, the `folderId` of the folder it
 * lives in, display metadata, and its Knowledge Base `indexingStatus`.
 */
export interface MaterialFile {
  id: string;
  studentId: string;
  /** Id of the containing {@link FolderNode}. */
  folderId: string;
  name: string;
  size: number;
  format: string;
  uploadDate: string;
  indexingStatus: IndexingStatus;
  s3Key: string;
  /** Denormalized folder path, e.g. "Data Structures > Week 3". */
  folderPath: string;
}

export interface MaterialsAppProps {
  /** The student whose Knowledge Base is shown; used only for labelling. */
  studentId: string;
  /** Flat adjacency-list of all folders for the student (task 4.1 shape). */
  folders: readonly FolderNode[];
  /** All files for the student; each is placed under its `folderId`. */
  files: readonly MaterialFile[];
  /** Currently selected folder id, or `null` for the Knowledge Base root. */
  selectedFolderId?: string | null;
  /** Ids of folders that should render expanded. Uncontrolled when omitted. */
  expandedFolderIds?: readonly string[];
  /** Fired when the student selects a folder (or the root, id `null`). */
  onSelectFolder?: (folderId: string | null) => void;
  /** Fired when the student expands or collapses a folder. */
  onToggleExpand?: (folderId: string, expanded: boolean) => void;
  /**
   * Optional extension point for the create-folder affordance (wired in a later
   * task). When provided, a "New folder" control targets the selected folder
   * (or the root when nothing is selected).
   */
  onCreateFolder?: (parentId: string | null) => void;
}

/** Human-readable label for each indexing status. */
const STATUS_LABEL: Record<IndexingStatus, string> = {
  PENDING: 'Pending',
  INDEXING: 'Indexing',
  INDEXED: 'Indexed',
  FAILED: 'Failed',
};

/** Synthetic id for the Knowledge Base root (which is not a real FolderNode). */
export const ROOT_FOLDER_ID = '__root__';

interface FolderTreeItemProps {
  node: FolderNode;
  depth: number;
  folders: readonly FolderNode[];
  filesByFolder: ReadonlyMap<string, MaterialFile[]>;
  selectedFolderId: string | null;
  isExpanded: (folderId: string) => boolean;
  onSelect: (folderId: string) => void;
  onToggle: (folderId: string) => void;
}

/**
 * Renders a single folder row plus — when expanded — its files and its child
 * folders (recursively). Child folders are discovered with {@link getChildren}
 * so the ordering and parent/child semantics stay owned by the data layer.
 */
const FolderTreeItem: React.FC<FolderTreeItemProps> = ({
  node,
  depth,
  folders,
  filesByFolder,
  selectedFolderId,
  isExpanded,
  onSelect,
  onToggle,
}) => {
  const childFolders = useMemo(
    () => getChildren(node.id, folders),
    [node.id, folders]
  );
  const childFiles = filesByFolder.get(node.id) ?? [];
  const expanded = isExpanded(node.id);
  const hasChildren = childFolders.length > 0 || childFiles.length > 0;
  const selected = selectedFolderId === node.id;

  return (
    <li className="materials-app__node" role="none">
      <div
        className={
          'materials-app__folder' +
          (selected ? ' materials-app__folder--selected' : '')
        }
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        data-testid={`folder-${node.id}`}
      >
        <button
          type="button"
          className="materials-app__toggle"
          data-testid={`folder-toggle-${node.id}`}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
          // Collapse/expand without changing the selection.
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.id);
          }}
          disabled={!hasChildren}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : '·'}
        </button>
        <button
          type="button"
          className="materials-app__folder-label"
          data-testid={`folder-label-${node.id}`}
          onClick={() => onSelect(node.id)}
        >
          <span className="materials-app__folder-icon" aria-hidden="true">
            📁
          </span>
          <span className="materials-app__folder-name">{node.name}</span>
        </button>
      </div>

      {expanded && hasChildren && (
        <ul className="materials-app__children" role="group">
          {childFolders.map((child) => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              folders={folders}
              filesByFolder={filesByFolder}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
          {childFiles.map((file) => (
            <li
              key={file.id}
              className="materials-app__file"
              style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}
              role="treeitem"
              aria-level={depth + 2}
              data-testid={`file-${file.id}`}
            >
              <span className="materials-app__file-icon" aria-hidden="true">
                📄
              </span>
              <span className="materials-app__file-name">{file.name}</span>
              <span
                className={`materials-app__status materials-app__status--${file.indexingStatus.toLowerCase()}`}
                data-testid={`file-status-${file.id}`}
              >
                {STATUS_LABEL[file.indexingStatus]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

const MaterialsApp: React.FC<MaterialsAppProps> = ({
  studentId,
  folders,
  files,
  selectedFolderId,
  expandedFolderIds,
  onSelectFolder,
  onToggleExpand,
  onCreateFolder,
}) => {
  // Selection and expansion can be driven by props (controlled) or managed
  // internally (uncontrolled) so the component is useful on its own in tests
  // and before the parent wires persistence.
  const selectionControlled = selectedFolderId !== undefined;
  const expansionControlled = expandedFolderIds !== undefined;

  const [internalSelected, setInternalSelected] = useState<string | null>(
    ROOT_FOLDER_ID
  );
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set([ROOT_FOLDER_ID])
  );

  const effectiveSelected = selectionControlled
    ? selectedFolderId ?? ROOT_FOLDER_ID
    : internalSelected;

  const expandedSet = useMemo(
    () =>
      expansionControlled
        ? new Set<string>(expandedFolderIds)
        : internalExpanded,
    [expansionControlled, expandedFolderIds, internalExpanded]
  );

  const isExpanded = useCallback(
    (folderId: string) => expandedSet.has(folderId),
    [expandedSet]
  );

  // Group files under their folder id once per render so each tree item does a
  // single map lookup. Files whose folder is unknown are surfaced at the root.
  const filesByFolder = useMemo(() => {
    const byId = indexById(folders);
    const map = new Map<string, MaterialFile[]>();
    for (const file of files) {
      const key = byId.has(file.folderId) ? file.folderId : ROOT_FOLDER_ID;
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(file);
      } else {
        map.set(key, [file]);
      }
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' })
      );
    }
    return map;
  }, [folders, files]);

  const rootFolders = useMemo(() => getChildren(null, folders), [folders]);
  const rootFiles = filesByFolder.get(ROOT_FOLDER_ID) ?? [];
  const rootExpanded = isExpanded(ROOT_FOLDER_ID);
  const rootHasChildren = rootFolders.length > 0 || rootFiles.length > 0;
  const rootSelected = effectiveSelected === ROOT_FOLDER_ID;

  const handleSelect = useCallback(
    (folderId: string | null) => {
      if (!selectionControlled) {
        setInternalSelected(folderId);
      }
      onSelectFolder?.(folderId === ROOT_FOLDER_ID ? null : folderId);
    },
    [selectionControlled, onSelectFolder]
  );

  const handleToggle = useCallback(
    (folderId: string) => {
      const willExpand = !expandedSet.has(folderId);
      if (!expansionControlled) {
        setInternalExpanded((prev) => {
          const next = new Set(prev);
          if (willExpand) {
            next.add(folderId);
          } else {
            next.delete(folderId);
          }
          return next;
        });
      }
      if (folderId !== ROOT_FOLDER_ID) {
        onToggleExpand?.(folderId, willExpand);
      }
    },
    [expandedSet, expansionControlled, onToggleExpand]
  );

  const createTargetId =
    effectiveSelected === ROOT_FOLDER_ID ? null : effectiveSelected;

  return (
    <section
      className="materials-app"
      data-testid="materials-app"
      data-student-id={studentId}
      aria-label="Materials knowledge base"
    >
      <header className="materials-app__header">
        <h2 className="materials-app__title">Materials</h2>
        {onCreateFolder && (
          <button
            type="button"
            className="materials-app__new-folder"
            data-testid="materials-app-new-folder"
            onClick={() => onCreateFolder(createTargetId)}
          >
            New folder
          </button>
        )}
      </header>

      <ul className="materials-app__tree" role="tree" aria-label="Folder tree">
        {/* The root entry represents the student's entire Knowledge Base. */}
        <li className="materials-app__node" role="none">
          <div
            className={
              'materials-app__folder materials-app__folder--root' +
              (rootSelected ? ' materials-app__folder--selected' : '')
            }
            style={{ paddingLeft: '8px' }}
            role="treeitem"
            aria-level={1}
            aria-selected={rootSelected}
            aria-expanded={rootHasChildren ? rootExpanded : undefined}
            data-testid={`folder-${ROOT_FOLDER_ID}`}
          >
            <button
              type="button"
              className="materials-app__toggle"
              data-testid={`folder-toggle-${ROOT_FOLDER_ID}`}
              aria-label={`${rootExpanded ? 'Collapse' : 'Expand'} Knowledge Base`}
              onClick={(event) => {
                event.stopPropagation();
                handleToggle(ROOT_FOLDER_ID);
              }}
              disabled={!rootHasChildren}
            >
              {rootHasChildren ? (rootExpanded ? '▾' : '▸') : '·'}
            </button>
            <button
              type="button"
              className="materials-app__folder-label"
              data-testid={`folder-label-${ROOT_FOLDER_ID}`}
              onClick={() => handleSelect(ROOT_FOLDER_ID)}
            >
              <span className="materials-app__folder-icon" aria-hidden="true">
                🗄️
              </span>
              <span className="materials-app__folder-name">Knowledge Base</span>
            </button>
          </div>

          {rootExpanded && rootHasChildren && (
            <ul className="materials-app__children" role="group">
              {rootFolders.map((folder) => (
                <FolderTreeItem
                  key={folder.id}
                  node={folder}
                  depth={1}
                  folders={folders}
                  filesByFolder={filesByFolder}
                  selectedFolderId={effectiveSelected}
                  isExpanded={isExpanded}
                  onSelect={handleSelect}
                  onToggle={handleToggle}
                />
              ))}
              {rootFiles.map((file) => (
                <li
                  key={file.id}
                  className="materials-app__file"
                  style={{ paddingLeft: '36px' }}
                  role="treeitem"
                  aria-level={2}
                  data-testid={`file-${file.id}`}
                >
                  <span className="materials-app__file-icon" aria-hidden="true">
                    📄
                  </span>
                  <span className="materials-app__file-name">{file.name}</span>
                  <span
                    className={`materials-app__status materials-app__status--${file.indexingStatus.toLowerCase()}`}
                    data-testid={`file-status-${file.id}`}
                  >
                    {STATUS_LABEL[file.indexingStatus]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>

      {rootFolders.length === 0 && rootFiles.length === 0 && (
        <p className="materials-app__empty" data-testid="materials-app-empty">
          No materials yet. Create a folder and upload files to build your
          Knowledge Base.
        </p>
      )}
    </section>
  );
};

export default MaterialsApp;
