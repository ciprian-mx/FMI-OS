import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FolderNode,
  getAncestors,
  getChildren,
  indexById,
  validateMove,
} from './folderHierarchy';
import ContextMenu, {
  ContextMenuCloseReason,
  ContextMenuItem,
  MenuPosition,
} from './ContextMenu';
import {
  KNOWLEDGE_BASE_LABEL,
  MoveTarget,
  countFolderContents,
  describeFolderContents,
  describeLocation,
  getFileMoveTargets,
  getFolderMoveTargets,
  resolveFileFolderId,
  splitFileName,
  validateFileMove,
  validateFileRename,
  validateFolderRename,
  validateNewFolder,
} from './treeActions';
import './MaterialsApp.css';

/**
 * MaterialsApp tree view (Task 4.2, Requirements 7.1 / 7.2 / 7.8).
 *
 * Renders the student's Materials Knowledge Base as a hierarchical, expandable
 * folder tree with the files that live inside each folder, and lets the student
 * manage it through a context menu. The component is the presentational /
 * interaction layer only: it consumes the *flat* adjacency-list
 * {@link FolderNode}s produced by the data layer (task 4.1,
 * `src/materials/folderHierarchy.ts`) and never reimplements tree traversal or
 * hierarchy rules — child lookup is delegated to {@link getChildren}, and every
 * create / rename / move is validated with the folderHierarchy helpers (via
 * `./treeActions`) before a callback fires. Data loading over AppSync and S3
 * uploads live elsewhere (task 4.5+/16.x); folders and files arrive as props and
 * all mutations are surfaced as callbacks so the parent owns side effects and
 * updates `folders` / `files` once a callback resolves.
 *
 * Tree behaviour:
 * - a hierarchical tree of nested, expandable folders (expand / collapse),
 * - a root entry representing the entire Knowledge Base,
 * - the files inside each expanded folder, each showing its indexing status,
 * - a single "selected" folder, highlighted and used as the target of the
 *   header "New folder" button.
 *
 * Context menu (Requirements 7.2 / 7.8). Folders, files and the root each have
 * a menu, opened by right-click, by the context-menu key or Shift+F10 while the
 * row has focus, or by the row's visible "More actions" button. It follows the
 * ARIA menu pattern (see `./ContextMenu`): arrow keys move between items,
 * Escape and Tab close it and return focus to the row; an outside press closes
 * it too and returns focus to the row unless the press focused another control.
 * - Folders: New folder, Rename, Move, Delete. Root: New folder. Files: Rename,
 *   Move, Delete. An item (and the "More actions" button of a row with no
 *   items) only appears when its callback prop is provided.
 * - New folder opens an inline name entry inside the target folder (expanding
 *   it); Rename turns the row label into an inline editor; Move opens a
 *   destination picker listing only valid targets (folders: per `validateMove`;
 *   files: any folder other than their own); Delete asks for confirmation and
 *   warns that a folder's contents are deleted with it.
 * - File renames keep the extension: only the base name is editable, the
 *   original extension is re-appended, and typing it anyway does not double it
 *   (see `validateFileRename`).
 * - Callbacks may return a promise. While it is pending the action's controls
 *   are inert; if it rejects (or throws) the action stays open with its input
 *   intact and a retryable error. Escape / Cancel abandon an action. When an
 *   action ends, focus returns to the row (or control) that started it.
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

/**
 * What an action callback may return. A returned promise is awaited; a
 * rejection (or a synchronous throw) keeps the action open with a retryable
 * error message.
 */
export type MaterialsActionResult = Promise<unknown> | void;

export interface MaterialsAppProps {
  /** The student whose Knowledge Base is shown; used for labelling and create validation. */
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
  /**
   * Fired when the student expands or collapses a folder — including when a
   * "New folder" entry is opened inside a collapsed folder, which expands it.
   */
  onToggleExpand?: (folderId: string, expanded: boolean) => void;
  /**
   * Creates a folder named `name` under `parentId` (`null` = Knowledge Base
   * root). Enables the header "New folder" button (targets the selected folder)
   * and the "New folder" menu item on folders and the root; both open an inline
   * name entry, and `name` arrives validated (`validateCreate`) and normalized.
   *
   * Signature change: this used to be `(parentId) => void`, fired as soon as
   * the header button was clicked. It now fires once the folder is named.
   */
  onCreateFolder?: (parentId: string | null, name: string) => MaterialsActionResult;
  /** Renames a folder. `name` is validated against its siblings and normalized. */
  onRenameFolder?: (folderId: string, name: string) => MaterialsActionResult;
  /** Moves a folder under `newParentId` (`null` = root); always a `validateMove`-valid target. */
  onMoveFolder?: (folderId: string, newParentId: string | null) => MaterialsActionResult;
  /** Deletes a folder and, recursively, everything inside it (after confirmation). */
  onDeleteFolder?: (folderId: string) => MaterialsActionResult;
  /** Renames a file. `name` is the full new name with the original extension kept. */
  onRenameFile?: (fileId: string, name: string) => MaterialsActionResult;
  /** Moves a file into `folderId` (`null` = root). */
  onMoveFile?: (fileId: string, folderId: string | null) => MaterialsActionResult;
  /** Deletes a file (after confirmation). */
  onDeleteFile?: (fileId: string) => MaterialsActionResult;
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

/** Shown (with `role="alert"`) when an action's callback rejects. */
export const ACTION_ERROR_MESSAGES = {
  createFolder: "Couldn't create the folder. Please try again.",
  renameFolder: "Couldn't rename the folder. Please try again.",
  moveFolder: "Couldn't move the folder. Please try again.",
  deleteFolder: "Couldn't delete the folder. Please try again.",
  renameFile: "Couldn't rename the file. Please try again.",
  moveFile: "Couldn't move the file. Please try again.",
  deleteFile: "Couldn't delete the file. Please try again.",
} as const;

/** Shown when the move picker is submitted without choosing a destination. */
export const MOVE_DESTINATION_REQUIRED = 'Choose a destination folder.';

/* -------------------------------------------------------------------------- *
 * Internal state shapes
 * -------------------------------------------------------------------------- */

/** What a context menu or action is about. */
type TreeTarget =
  | { kind: 'root' }
  | { kind: 'folder'; id: string }
  | { kind: 'file'; id: string };

/** The action the student is currently carrying out, if any (one at a time). */
type ActionState =
  | { type: 'create'; parentId: string | null }
  | { type: 'rename-folder'; id: string }
  | { type: 'move-folder'; id: string }
  | { type: 'delete-folder'; id: string }
  | { type: 'rename-file'; id: string }
  | { type: 'move-file'; id: string }
  | { type: 'delete-file'; id: string };

/** Where focus goes when a menu or action ends, in order of preference. */
interface FocusReturn {
  /** The control that opened the menu / action, if it is still mounted. */
  element: HTMLElement | null;
  /** The row it belongs to (its label, or the file row itself). */
  rowKey: string;
  /** Used when that row is gone too (e.g. it was deleted or moved out of view). */
  fallbackRowKey?: string;
}

interface MenuState {
  /** Remounts the menu (fresh focus) each time one is opened. */
  key: number;
  target: TreeTarget;
  position: MenuPosition;
  returnFocus: FocusReturn;
  /** The "More actions" button that opened the menu, if any. */
  trigger: HTMLElement | null;
}

const ROOT_TARGET: TreeTarget = { kind: 'root' };
const ROOT_ROW_KEY = 'root';
const folderRowKey = (folderId: string | null) =>
  folderId === null ? ROOT_ROW_KEY : `folder:${folderId}`;
const fileRowKey = (fileId: string) => `file:${fileId}`;
const rowKeyOf = (target: TreeTarget) =>
  target.kind === 'root'
    ? ROOT_ROW_KEY
    : target.kind === 'folder'
      ? folderRowKey(target.id)
      : fileRowKey(target.id);

/** Text-entry controls keep the browser's own context menu and key handling. */
function isTextEntry(target: EventTarget): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** Menu position just below an element (keyboard / button opening). */
function anchorBelow(element: Element): MenuPosition {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

function canTakeFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element && element.isConnected && !element.matches(':disabled'));
}

/* -------------------------------------------------------------------------- *
 * Tree context (shared by the recursive row components)
 * -------------------------------------------------------------------------- */

interface TreeContextValue {
  folders: readonly FolderNode[];
  filesByFolder: ReadonlyMap<string, MaterialFile[]>;
  selectedFolderId: string | null;
  isExpanded: (folderId: string) => boolean;
  onSelect: (folderId: string) => void;
  onToggle: (folderId: string) => void;
  hasActions: (target: TreeTarget) => boolean;
  /** Row key of the row whose menu is open, if any. */
  openMenuRowKey: string | null;
  menuId: string;
  action: ActionState | null;
  /** Changes every time an action starts, so its editor remounts fresh. */
  actionSeq: number;
  actionError: string | null;
  pending: boolean;
  registerRowFocus: (rowKey: string, element: HTMLElement | null) => void;
  onRowContextMenu: (event: React.MouseEvent<HTMLElement>, target: TreeTarget) => void;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>, target: TreeTarget) => void;
  onActionsButtonClick: (
    event: React.MouseEvent<HTMLButtonElement>,
    target: TreeTarget
  ) => void;
  onSubmitCreate: (parentId: string | null, value: string) => void;
  onSubmitFolderRename: (folderId: string, value: string) => void;
  onSubmitFileRename: (fileId: string, value: string) => void;
  onCancelAction: () => void;
  onEditAction: () => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTree(): TreeContextValue {
  const value = useContext(TreeContext);
  if (!value) {
    throw new Error('Materials tree rows must render inside MaterialsApp.');
  }
  return value;
}

/* -------------------------------------------------------------------------- *
 * Inline name editor (new folder / rename)
 * -------------------------------------------------------------------------- */

interface InlineNameFormProps {
  /** Accessible name of the text field. */
  label: string;
  initialValue: string;
  /** A fixed suffix shown after the field (a file's kept extension). */
  suffix?: string;
  /** Accessible name of the confirm button. */
  submitLabel: string;
  testId: string;
  pending: boolean;
  error: string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Called on every edit, so a stale error message can be cleared. */
  onEdit: () => void;
}

const InlineNameForm: React.FC<InlineNameFormProps> = ({
  label,
  initialValue,
  suffix,
  submitLabel,
  testId,
  pending,
  error,
  onSubmit,
  onCancel,
  onEdit,
}) => {
  const baseId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `${baseId}-error`;
  const suffixId = `${baseId}-suffix`;

  // Opening an editor is always student-initiated: focus it, ready to retype.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  const describedBy =
    [suffix ? suffixId : null, error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <form
      className="materials-app__inline-form"
      data-testid={testId}
      aria-busy={pending || undefined}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) {
          onSubmit(value);
        }
      }}
    >
      <input
        ref={inputRef}
        className="materials-app__inline-input"
        type="text"
        aria-label={label}
        value={value}
        // Read-only (not disabled) while saving so focus stays put for a retry.
        readOnly={pending}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setValue(event.target.value);
          onEdit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault();
            event.stopPropagation();
            if (!pending) {
              onCancel();
            }
          }
        }}
      />
      {suffix && (
        <span id={suffixId} className="materials-app__extension">
          <span aria-hidden="true">{suffix}</span>
          <span className="materials-app__sr-only">
            The {suffix} extension is kept.
          </span>
        </span>
      )}
      <button
        type="submit"
        className="materials-app__inline-button"
        aria-label={submitLabel}
        title={submitLabel}
        aria-disabled={pending || undefined}
      >
        <span aria-hidden="true">✓</span>
      </button>
      <button
        type="button"
        className="materials-app__inline-button"
        aria-label="Cancel"
        title="Cancel"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (!pending) {
            onCancel();
          }
        }}
      >
        <span aria-hidden="true">✕</span>
      </button>
      {error && (
        <p id={errorId} className="materials-app__inline-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
};

/* -------------------------------------------------------------------------- *
 * Tree rows
 * -------------------------------------------------------------------------- */

/** The visible per-row "More actions" button; absent when the row has no actions. */
const RowActionsButton: React.FC<{ target: TreeTarget; name: string }> = ({
  target,
  name,
}) => {
  const tree = useTree();
  if (!tree.hasActions(target)) {
    return null;
  }
  const open = tree.openMenuRowKey === rowKeyOf(target);
  const testId =
    target.kind === 'file'
      ? `file-actions-${target.id}`
      : `folder-actions-${target.kind === 'root' ? ROOT_FOLDER_ID : target.id}`;
  return (
    <button
      type="button"
      className="materials-app__row-actions"
      data-testid={testId}
      aria-label={`More actions for ${name}`}
      title="More actions"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? tree.menuId : undefined}
      disabled={tree.pending}
      onClick={(event) => tree.onActionsButtonClick(event, target)}
    >
      <span aria-hidden="true">⋯</span>
    </button>
  );
};

/** The inline "New folder" entry, rendered as the first child of its parent. */
const NewFolderRow: React.FC<{ parentId: string | null; depth: number }> = ({
  parentId,
  depth,
}) => {
  const tree = useTree();
  return (
    <li
      className="materials-app__folder materials-app__draft"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={false}
      aria-label="New folder"
      data-testid="new-folder-row"
    >
      <span className="materials-app__folder-icon" aria-hidden="true">
        📁
      </span>
      <InlineNameForm
        key={tree.actionSeq}
        label="New folder name"
        initialValue=""
        submitLabel="Create folder"
        testId="new-folder-form"
        pending={tree.pending}
        error={tree.actionError}
        onSubmit={(value) => tree.onSubmitCreate(parentId, value)}
        onCancel={tree.onCancelAction}
        onEdit={tree.onEditAction}
      />
    </li>
  );
};

interface FileTreeItemProps {
  file: MaterialFile;
  level: number;
  paddingLeft: number;
}

/** A file row: name (or its inline rename editor), indexing status, actions. */
const FileTreeItem: React.FC<FileTreeItemProps> = ({ file, level, paddingLeft }) => {
  const tree = useTree();
  const target = useMemo<TreeTarget>(() => ({ kind: 'file', id: file.id }), [file.id]);
  const rowKey = fileRowKey(file.id);
  const register = tree.registerRowFocus;
  const rowRef = useCallback(
    (element: HTMLLIElement | null) => register(rowKey, element),
    [register, rowKey]
  );
  const actionable = tree.hasActions(target);
  const renaming = tree.action?.type === 'rename-file' && tree.action.id === file.id;
  const { base, extension } = splitFileName(file.name);

  return (
    <li
      ref={rowRef}
      className="materials-app__file"
      style={{ paddingLeft: `${paddingLeft}px` }}
      role="treeitem"
      aria-level={level}
      // Only folders are selectable; files never carry the selection.
      aria-selected={false}
      data-testid={`file-${file.id}`}
      // Focusable when it has actions, so the context-menu key can reach it.
      tabIndex={actionable ? 0 : undefined}
      onContextMenu={(event) => tree.onRowContextMenu(event, target)}
      onKeyDown={(event) => tree.onRowKeyDown(event, target)}
    >
      <span className="materials-app__file-icon" aria-hidden="true">
        📄
      </span>
      {renaming ? (
        <InlineNameForm
          key={tree.actionSeq}
          label={`Rename ${file.name}`}
          initialValue={extension ? base : file.name}
          suffix={extension ? `.${extension}` : undefined}
          submitLabel="Save name"
          testId={`rename-form-${file.id}`}
          pending={tree.pending}
          error={tree.actionError}
          onSubmit={(value) => tree.onSubmitFileRename(file.id, value)}
          onCancel={tree.onCancelAction}
          onEdit={tree.onEditAction}
        />
      ) : (
        <span className="materials-app__file-name">{file.name}</span>
      )}
      <span
        className={`materials-app__status materials-app__status--${file.indexingStatus.toLowerCase()}`}
        data-testid={`file-status-${file.id}`}
      >
        {STATUS_LABEL[file.indexingStatus]}
      </span>
      {!renaming && <RowActionsButton target={target} name={file.name} />}
    </li>
  );
};

interface TreeChildrenProps {
  /** The folder whose children these are (`null` = Knowledge Base root). */
  parentId: string | null;
  /** Depth of that parent (the root is 0). */
  depth: number;
  childFolders: readonly FolderNode[];
  childFiles: readonly MaterialFile[];
  filePaddingLeft: number;
}

/** A parent's children group: the new-folder entry (if any), folders, then files. */
const TreeChildren: React.FC<TreeChildrenProps> = ({
  parentId,
  depth,
  childFolders,
  childFiles,
  filePaddingLeft,
}) => {
  const tree = useTree();
  const draftHere =
    tree.action?.type === 'create' && tree.action.parentId === parentId;
  return (
    <ul className="materials-app__children" role="group">
      {draftHere && <NewFolderRow parentId={parentId} depth={depth + 1} />}
      {childFolders.map((child) => (
        <FolderTreeItem key={child.id} node={child} depth={depth + 1} />
      ))}
      {childFiles.map((file) => (
        <FileTreeItem
          key={file.id}
          file={file}
          level={depth + 2}
          paddingLeft={filePaddingLeft}
        />
      ))}
    </ul>
  );
};

interface FolderTreeItemProps {
  node: FolderNode;
  depth: number;
}

/**
 * Renders a single folder row plus — when expanded — its files and its child
 * folders (recursively). Child folders are discovered with {@link getChildren}
 * so the ordering and parent/child semantics stay owned by the data layer.
 */
const FolderTreeItem: React.FC<FolderTreeItemProps> = ({ node, depth }) => {
  const tree = useTree();
  const childFolders = useMemo(
    () => getChildren(node.id, tree.folders),
    [node.id, tree.folders]
  );
  const childFiles = tree.filesByFolder.get(node.id) ?? [];
  const target = useMemo<TreeTarget>(() => ({ kind: 'folder', id: node.id }), [node.id]);
  const rowKey = folderRowKey(node.id);
  const register = tree.registerRowFocus;
  const labelRef = useCallback(
    (element: HTMLButtonElement | null) => register(rowKey, element),
    [register, rowKey]
  );
  const expanded = tree.isExpanded(node.id);
  const hasChildren = childFolders.length > 0 || childFiles.length > 0;
  const draftHere = tree.action?.type === 'create' && tree.action.parentId === node.id;
  const renaming = tree.action?.type === 'rename-folder' && tree.action.id === node.id;
  const selected = tree.selectedFolderId === node.id;

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
        aria-expanded={hasChildren || draftHere ? expanded : undefined}
        data-testid={`folder-${node.id}`}
        onContextMenu={(event) => tree.onRowContextMenu(event, target)}
        onKeyDown={(event) => tree.onRowKeyDown(event, target)}
      >
        <button
          type="button"
          className="materials-app__toggle"
          data-testid={`folder-toggle-${node.id}`}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
          // Collapse/expand without changing the selection.
          onClick={(event) => {
            event.stopPropagation();
            tree.onToggle(node.id);
          }}
          disabled={!hasChildren}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : '·'}
        </button>
        {renaming ? (
          <InlineNameForm
            key={tree.actionSeq}
            label={`Rename ${node.name}`}
            initialValue={node.name}
            submitLabel="Save name"
            testId={`rename-form-${node.id}`}
            pending={tree.pending}
            error={tree.actionError}
            onSubmit={(value) => tree.onSubmitFolderRename(node.id, value)}
            onCancel={tree.onCancelAction}
            onEdit={tree.onEditAction}
          />
        ) : (
          <button
            ref={labelRef}
            type="button"
            className="materials-app__folder-label"
            data-testid={`folder-label-${node.id}`}
            onClick={() => tree.onSelect(node.id)}
          >
            <span className="materials-app__folder-icon" aria-hidden="true">
              📁
            </span>
            <span className="materials-app__folder-name">{node.name}</span>
          </button>
        )}
        {!renaming && <RowActionsButton target={target} name={node.name} />}
      </div>

      {expanded && (hasChildren || draftHere) && (
        <TreeChildren
          parentId={node.id}
          depth={depth}
          childFolders={childFolders}
          childFiles={childFiles}
          filePaddingLeft={(depth + 1) * 16 + 28}
        />
      )}
    </li>
  );
};

/* -------------------------------------------------------------------------- *
 * Move picker and delete confirmation
 * -------------------------------------------------------------------------- */

/** Closes a dialog on Escape unless its callback is in flight. */
function dialogKeyDown(pending: boolean, onCancel: () => void) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' || event.key === 'Esc') {
      event.preventDefault();
      event.stopPropagation();
      if (!pending) {
        onCancel();
      }
    }
  };
}

interface MoveDialogProps {
  itemName: string;
  itemKind: 'folder' | 'file';
  /** Where the item is now, e.g. "Knowledge Base > Data Structures". */
  currentLocation: string;
  targets: readonly MoveTarget[];
  pending: boolean;
  error: string | null;
  /** `undefined` when no destination was chosen; `null` is the root. */
  onSubmit: (destination: string | null | undefined) => void;
  onCancel: () => void;
  onEdit: () => void;
}

const MoveDialog: React.FC<MoveDialogProps> = ({
  itemName,
  itemKind,
  currentLocation,
  targets,
  pending,
  error,
  onSubmit,
  onCancel,
  onEdit,
}) => {
  const baseId = useId();
  const [choice, setChoice] = useState('');
  const selectRef = useRef<HTMLSelectElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const selectId = `${baseId}-destination`;
  const errorId = `${baseId}-error`;

  useLayoutEffect(() => {
    (selectRef.current ?? cancelRef.current)?.focus();
  }, []);

  return (
    <div
      className="materials-app__dialog"
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="move-dialog"
      onKeyDown={dialogKeyDown(pending, onCancel)}
    >
      <h3 id={titleId} className="materials-app__dialog-title">
        Move "{itemName}"
      </h3>
      <p id={descriptionId} className="materials-app__dialog-text">
        Currently in {currentLocation}.
      </p>
      <form
        noValidate
        aria-busy={pending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) {
            return;
          }
          if (choice === '') {
            onSubmit(undefined);
          } else {
            onSubmit(choice === ROOT_FOLDER_ID ? null : choice);
          }
        }}
      >
        {targets.length > 0 ? (
          <>
            <label className="materials-app__dialog-label" htmlFor={selectId}>
              Destination
            </label>
            <select
              ref={selectRef}
              id={selectId}
              className="materials-app__dialog-select"
              data-testid="move-destination"
              value={choice}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setChoice(event.target.value);
                onEdit();
              }}
            >
              <option value="" disabled>
                Choose a folder…
              </option>
              {targets.map((target) => (
                <option
                  key={target.folderId ?? ROOT_FOLDER_ID}
                  value={target.folderId ?? ROOT_FOLDER_ID}
                >
                  {target.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <p className="materials-app__dialog-text" data-testid="move-no-targets">
            There is no other folder to move this {itemKind} to.
          </p>
        )}
        {error && (
          <p id={errorId} className="materials-app__dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="materials-app__dialog-actions">
          {targets.length > 0 && (
            <button
              type="submit"
              className="materials-app__button materials-app__button--primary"
              data-testid="move-confirm"
              aria-disabled={pending || undefined}
            >
              {pending ? 'Moving…' : 'Move'}
            </button>
          )}
          <button
            ref={cancelRef}
            type="button"
            className="materials-app__button"
            data-testid="move-cancel"
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!pending) {
                onCancel();
              }
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};

interface DeleteDialogProps {
  title: string;
  message: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteDialog: React.FC<DeleteDialogProps> = ({
  title,
  message,
  pending,
  error,
  onConfirm,
  onCancel,
}) => {
  const baseId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  // Land on the least destructive choice.
  useLayoutEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="materials-app__dialog materials-app__dialog--danger"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="delete-dialog"
      onKeyDown={dialogKeyDown(pending, onCancel)}
    >
      <h3 id={titleId} className="materials-app__dialog-title">
        {title}
      </h3>
      <p id={descriptionId} className="materials-app__dialog-text">
        {message}
      </p>
      {error && (
        <p className="materials-app__dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="materials-app__dialog-actions">
        <button
          type="button"
          className="materials-app__button materials-app__button--danger"
          data-testid="delete-confirm"
          aria-disabled={pending || undefined}
          onClick={() => {
            if (!pending) {
              onConfirm();
            }
          }}
        >
          {pending ? 'Deleting…' : 'Delete'}
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="materials-app__button"
          data-testid="delete-cancel"
          aria-disabled={pending || undefined}
          onClick={() => {
            if (!pending) {
              onCancel();
            }
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- *
 * App
 * -------------------------------------------------------------------------- */

const MaterialsApp: React.FC<MaterialsAppProps> = ({
  studentId,
  folders,
  files,
  selectedFolderId,
  expandedFolderIds,
  onSelectFolder,
  onToggleExpand,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
}) => {
  const menuId = useId();

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

  const byId = useMemo(() => indexById(folders), [folders]);
  const filesById = useMemo(
    () => new Map(files.map((file) => [file.id, file] as const)),
    [files]
  );

  // ---- Menu / action state --------------------------------------------------
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuSeqRef = useRef(0);
  const [action, setAction] = useState<ActionState | null>(null);
  const [actionSeq, setActionSeq] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPendingState] = useState(false);
  // Mirrors `pending` synchronously, so a double submit in one tick is ignored.
  const pendingRef = useRef(false);
  const actionReturnRef = useRef<FocusReturn | null>(null);

  const setPending = useCallback((value: boolean) => {
    pendingRef.current = value;
    setPendingState(value);
  }, []);

  // While a "New folder" entry is open, its parent chain renders expanded even
  // if the (controlled) expansion state has not caught up yet.
  const revealedIds = useMemo(() => {
    const ids = new Set<string>();
    if (action?.type !== 'create') {
      return ids;
    }
    ids.add(ROOT_FOLDER_ID);
    const parent = action.parentId === null ? undefined : byId.get(action.parentId);
    if (parent) {
      ids.add(parent.id);
      for (const ancestor of getAncestors(parent, byId)) {
        ids.add(ancestor.id);
      }
    }
    return ids;
  }, [action, byId]);

  const isExpanded = useCallback(
    (folderId: string) => expandedSet.has(folderId) || revealedIds.has(folderId),
    [expandedSet, revealedIds]
  );

  // Group files under their folder id once per render so each tree item does a
  // single map lookup. Files whose folder is unknown are surfaced at the root.
  const filesByFolder = useMemo(() => {
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
  }, [byId, files]);

  const rootFolders = useMemo(() => getChildren(null, folders), [folders]);
  const rootFiles = filesByFolder.get(ROOT_FOLDER_ID) ?? [];
  const rootExpanded = isExpanded(ROOT_FOLDER_ID);
  const rootHasChildren = rootFolders.length > 0 || rootFiles.length > 0;
  const rootSelected = effectiveSelected === ROOT_FOLDER_ID;
  const draftAtRoot = action?.type === 'create' && action.parentId === null;

  // ---- Focus management -----------------------------------------------------
  // Each row registers the element that represents it for focus purposes: a
  // folder's (or the root's) label button, or a file's row itself.
  const rowFocusRef = useRef(new Map<string, HTMLElement>());
  const registerRowFocus = useCallback(
    (rowKey: string, element: HTMLElement | null) => {
      if (element) {
        rowFocusRef.current.set(rowKey, element);
      } else {
        rowFocusRef.current.delete(rowKey);
      }
    },
    []
  );

  const resolveFocusTarget = useCallback((request: FocusReturn) => {
    const rows = rowFocusRef.current;
    const candidates = [
      request.element,
      rows.get(request.rowKey),
      request.fallbackRowKey ? rows.get(request.fallbackRowKey) : undefined,
      rows.get(ROOT_ROW_KEY),
    ];
    return candidates.find(canTakeFocus) ?? null;
  }, []);

  // Focus requests are applied after the render that closes the menu/action,
  // once the row (re)rendered with its final elements.
  const pendingFocusRef = useRef<FocusReturn | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  useLayoutEffect(() => {
    if (focusRequest === 0) {
      return;
    }
    const request = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (request) {
      resolveFocusTarget(request)?.focus();
    }
  }, [focusRequest, resolveFocusTarget]);

  const focusAfterRender = useCallback((request: FocusReturn | null) => {
    if (!request) {
      return;
    }
    pendingFocusRef.current = request;
    setFocusRequest((count) => count + 1);
  }, []);

  // After an outside press, let the press move focus wherever the student
  // pointed; only if it landed on nothing focusable does focus return to the row.
  const deferredFocusTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(deferredFocusTimer.current), []);
  const focusIfUnclaimed = useCallback(
    (request: FocusReturn) => {
      window.clearTimeout(deferredFocusTimer.current);
      deferredFocusTimer.current = window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) {
          return;
        }
        resolveFocusTarget(request)?.focus();
      }, 0);
    },
    [resolveFocusTarget]
  );

  // ---- Selection / expansion ------------------------------------------------
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

  /** Expands `folderId` and its ancestors (the root included), reporting each. */
  const revealFolder = (folderId: string | null) => {
    const chain = [ROOT_FOLDER_ID];
    const node = folderId === null ? undefined : byId.get(folderId);
    if (node) {
      chain.push(
        ...getAncestors(node, byId)
          .reverse()
          .map((ancestor) => ancestor.id),
        node.id
      );
    }
    const collapsed = chain.filter((id) => !expandedSet.has(id));
    if (collapsed.length === 0) {
      return;
    }
    if (!expansionControlled) {
      setInternalExpanded((prev) => new Set([...prev, ...collapsed]));
    }
    for (const id of collapsed) {
      if (id !== ROOT_FOLDER_ID) {
        onToggleExpand?.(id, true);
      }
    }
  };

  // ---- Actions ----------------------------------------------------------------
  const folderHasActions = Boolean(
    onCreateFolder || onRenameFolder || onMoveFolder || onDeleteFolder
  );
  const fileHasActions = Boolean(onRenameFile || onMoveFile || onDeleteFile);

  const hasActions = (target: TreeTarget) =>
    target.kind === 'root'
      ? Boolean(onCreateFolder)
      : target.kind === 'folder'
        ? folderHasActions
        : fileHasActions;

  const targetName = (target: TreeTarget): string | undefined =>
    target.kind === 'root'
      ? KNOWLEDGE_BASE_LABEL
      : target.kind === 'folder'
        ? byId.get(target.id)?.name
        : filesById.get(target.id)?.name;

  /** The row a target's focus falls back to if its own row disappears. */
  const parentRowKeyOf = (target: TreeTarget): string => {
    if (target.kind === 'folder') {
      return folderRowKey(byId.get(target.id)?.parentId ?? null);
    }
    if (target.kind === 'file') {
      const file = filesById.get(target.id);
      return folderRowKey(file ? resolveFileFolderId(file, byId) : null);
    }
    return ROOT_ROW_KEY;
  };

  const startAction = (next: ActionState, returnFocus: FocusReturn) => {
    if (pendingRef.current) {
      return;
    }
    actionReturnRef.current = returnFocus;
    setActionError(null);
    setAction(next);
    setActionSeq((seq) => seq + 1);
    if (next.type === 'create') {
      revealFolder(next.parentId);
    }
  };

  const finishAction = () => {
    setAction(null);
    setActionError(null);
    setPending(false);
    focusAfterRender(actionReturnRef.current);
    actionReturnRef.current = null;
  };

  /**
   * Runs an action's callback. While it is pending the action's controls are
   * inert; on rejection the action stays open with `errorMessage` so the
   * student can retry; on success the action closes and focus returns.
   */
  const runAction = async (
    invoke: () => MaterialsActionResult,
    errorMessage: string,
    fallbackRowKey?: string
  ) => {
    if (pendingRef.current) {
      return;
    }
    setPending(true);
    setActionError(null);
    try {
      await invoke();
    } catch {
      setPending(false);
      setActionError(errorMessage);
      return;
    }
    if (fallbackRowKey && actionReturnRef.current) {
      actionReturnRef.current = { ...actionReturnRef.current, fallbackRowKey };
    }
    finishAction();
  };

  const cancelAction = () => {
    if (!pendingRef.current) {
      finishAction();
    }
  };

  const clearActionError = () => setActionError(null);

  const submitCreate = (parentId: string | null, typed: string) => {
    if (!onCreateFolder) {
      return;
    }
    const check = validateNewFolder(parentId, typed, studentId, folders);
    if (!check.valid) {
      setActionError(check.error);
      return;
    }
    void runAction(
      () => onCreateFolder(parentId, check.name),
      ACTION_ERROR_MESSAGES.createFolder
    );
  };

  const submitFolderRename = (folderId: string, typed: string) => {
    const node = byId.get(folderId);
    if (!onRenameFolder || !node) {
      return;
    }
    const check = validateFolderRename(folderId, typed, folders);
    if (!check.valid) {
      setActionError(check.error);
      return;
    }
    if (check.name === node.name) {
      // Nothing changed: close the editor without a round trip.
      finishAction();
      return;
    }
    void runAction(
      () => onRenameFolder(folderId, check.name),
      ACTION_ERROR_MESSAGES.renameFolder
    );
  };

  const submitFileRename = (fileId: string, typed: string) => {
    const file = filesById.get(fileId);
    if (!onRenameFile || !file) {
      return;
    }
    const check = validateFileRename(file, typed, folders, files);
    if (!check.valid) {
      setActionError(check.error);
      return;
    }
    if (check.name === file.name) {
      finishAction();
      return;
    }
    void runAction(
      () => onRenameFile(fileId, check.name),
      ACTION_ERROR_MESSAGES.renameFile
    );
  };

  const submitFolderMove = (folderId: string, destination: string | null | undefined) => {
    if (!onMoveFolder) {
      return;
    }
    if (destination === undefined) {
      setActionError(MOVE_DESTINATION_REQUIRED);
      return;
    }
    const check = validateMove(folderId, destination, folders);
    if (!check.valid) {
      setActionError(check.error ?? 'The folder cannot be moved there.');
      return;
    }
    void runAction(
      () => onMoveFolder(folderId, destination),
      ACTION_ERROR_MESSAGES.moveFolder,
      folderRowKey(destination)
    );
  };

  const submitFileMove = (fileId: string, destination: string | null | undefined) => {
    const file = filesById.get(fileId);
    if (!onMoveFile || !file) {
      return;
    }
    if (destination === undefined) {
      setActionError(MOVE_DESTINATION_REQUIRED);
      return;
    }
    const check = validateFileMove(file, destination, folders, files);
    if (!check.valid) {
      setActionError(check.error ?? 'The file cannot be moved there.');
      return;
    }
    void runAction(
      () => onMoveFile(fileId, destination),
      ACTION_ERROR_MESSAGES.moveFile,
      folderRowKey(destination)
    );
  };

  // ---- Menu -------------------------------------------------------------------
  const openMenu = (
    target: TreeTarget,
    position: MenuPosition,
    opener: HTMLElement | null,
    trigger: HTMLElement | null
  ) => {
    menuSeqRef.current += 1;
    setMenu({
      key: menuSeqRef.current,
      target,
      position,
      trigger,
      returnFocus: { element: opener, rowKey: rowKeyOf(target) },
    });
  };

  const handleMenuClose = (closing: MenuState, reason: ContextMenuCloseReason) => {
    // Only close the menu this request came from, never a newer one.
    setMenu((current) => (current && current.key === closing.key ? null : current));
    if (reason === 'escape' || reason === 'tab') {
      focusAfterRender(closing.returnFocus);
    } else if (reason === 'outside') {
      focusIfUnclaimed(closing.returnFocus);
    }
  };

  const menuItemsFor = (current: MenuState): ContextMenuItem[] => {
    const { target } = current;
    const returnFocus: FocusReturn = {
      ...current.returnFocus,
      fallbackRowKey: parentRowKeyOf(target),
    };
    const item = (
      id: string,
      label: string,
      next: ActionState,
      danger = false
    ): ContextMenuItem => ({
      id,
      label,
      danger,
      onSelect: () => startAction(next, returnFocus),
    });
    const items: ContextMenuItem[] = [];
    if (target.kind === 'root') {
      if (onCreateFolder) {
        items.push(item('new-folder', 'New folder', { type: 'create', parentId: null }));
      }
    } else if (target.kind === 'folder') {
      if (onCreateFolder) {
        items.push(
          item('new-folder', 'New folder', { type: 'create', parentId: target.id })
        );
      }
      if (onRenameFolder) {
        items.push(item('rename', 'Rename', { type: 'rename-folder', id: target.id }));
      }
      if (onMoveFolder) {
        items.push(item('move', 'Move', { type: 'move-folder', id: target.id }));
      }
      if (onDeleteFolder) {
        items.push(
          item('delete', 'Delete', { type: 'delete-folder', id: target.id }, true)
        );
      }
    } else {
      if (onRenameFile) {
        items.push(item('rename', 'Rename', { type: 'rename-file', id: target.id }));
      }
      if (onMoveFile) {
        items.push(item('move', 'Move', { type: 'move-file', id: target.id }));
      }
      if (onDeleteFile) {
        items.push(item('delete', 'Delete', { type: 'delete-file', id: target.id }, true));
      }
    }
    return items;
  };

  const handleRowContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    target: TreeTarget
  ) => {
    // Text fields and rows without actions keep the browser's own menu.
    if (isTextEntry(event.target) || !hasActions(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (pendingRef.current) {
      return;
    }
    const opener = rowFocusRef.current.get(rowKeyOf(target)) ?? null;
    // A keyboard-initiated `contextmenu` carries no pointer position: anchor
    // the menu to the row instead.
    const position =
      event.clientX === 0 && event.clientY === 0
        ? anchorBelow(opener ?? event.currentTarget)
        : { x: event.clientX, y: event.clientY };
    openMenu(target, position, opener, null);
  };

  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLElement>,
    target: TreeTarget
  ) => {
    const menuKey =
      event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (!menuKey || isTextEntry(event.target) || !hasActions(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (pendingRef.current) {
      return;
    }
    // Focus returns to whichever control of the row had it.
    const opener =
      event.target instanceof HTMLElement
        ? event.target
        : rowFocusRef.current.get(rowKeyOf(target)) ?? null;
    openMenu(target, anchorBelow(opener ?? event.currentTarget), opener, null);
  };

  const handleActionsButtonClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    target: TreeTarget
  ) => {
    event.stopPropagation();
    const button = event.currentTarget;
    if (menu && menu.trigger === button) {
      // A second press on the trigger closes its menu; focus stays on it.
      setMenu(null);
      return;
    }
    if (pendingRef.current) {
      return;
    }
    openMenu(target, anchorBelow(button), button, button);
  };

  const menuLabel = menu ? targetName(menu.target) : undefined;
  const menuItems = menu && menuLabel !== undefined ? menuItemsFor(menu) : [];

  // The header button creates inside the selected folder, or the root when the
  // root (or a folder that no longer exists) is selected.
  const createTargetId =
    effectiveSelected !== null &&
    effectiveSelected !== ROOT_FOLDER_ID &&
    byId.has(effectiveSelected)
      ? effectiveSelected
      : null;

  // ---- Move / delete dialogs -------------------------------------------------
  let dialog: React.ReactNode = null;
  if (action?.type === 'move-folder' && onMoveFolder) {
    const node = byId.get(action.id);
    if (node) {
      dialog = (
        <MoveDialog
          key={actionSeq}
          itemName={node.name}
          itemKind="folder"
          currentLocation={describeLocation(node.parentId ?? null, byId)}
          targets={getFolderMoveTargets(node.id, folders)}
          pending={pending}
          error={actionError}
          onSubmit={(destination) => submitFolderMove(node.id, destination)}
          onCancel={cancelAction}
          onEdit={clearActionError}
        />
      );
    }
  } else if (action?.type === 'move-file' && onMoveFile) {
    const file = filesById.get(action.id);
    if (file) {
      dialog = (
        <MoveDialog
          key={actionSeq}
          itemName={file.name}
          itemKind="file"
          currentLocation={describeLocation(resolveFileFolderId(file, byId), byId)}
          targets={getFileMoveTargets(file, folders)}
          pending={pending}
          error={actionError}
          onSubmit={(destination) => submitFileMove(file.id, destination)}
          onCancel={cancelAction}
          onEdit={clearActionError}
        />
      );
    }
  } else if (action?.type === 'delete-folder' && onDeleteFolder) {
    const node = byId.get(action.id);
    if (node) {
      const contents = describeFolderContents(
        countFolderContents(node.id, folders, files)
      );
      dialog = (
        <DeleteDialog
          key={actionSeq}
          title={`Delete folder "${node.name}"?`}
          message={
            contents
              ? `Everything inside it is deleted too: ${contents}. Deleted files are also removed from your Knowledge Base. This can't be undone.`
              : "This folder is empty. This can't be undone."
          }
          pending={pending}
          error={actionError}
          onConfirm={() => {
            void runAction(
              () => onDeleteFolder(node.id),
              ACTION_ERROR_MESSAGES.deleteFolder
            );
          }}
          onCancel={cancelAction}
        />
      );
    }
  } else if (action?.type === 'delete-file' && onDeleteFile) {
    const file = filesById.get(action.id);
    if (file) {
      dialog = (
        <DeleteDialog
          key={actionSeq}
          title={`Delete file "${file.name}"?`}
          message="It is also removed from your Knowledge Base. This can't be undone."
          pending={pending}
          error={actionError}
          onConfirm={() => {
            void runAction(
              () => onDeleteFile(file.id),
              ACTION_ERROR_MESSAGES.deleteFile
            );
          }}
          onCancel={cancelAction}
        />
      );
    }
  }

  const treeContext: TreeContextValue = {
    folders,
    filesByFolder,
    selectedFolderId: effectiveSelected,
    isExpanded,
    onSelect: handleSelect,
    onToggle: handleToggle,
    hasActions,
    openMenuRowKey: menu && menuItems.length > 0 ? rowKeyOf(menu.target) : null,
    menuId,
    action,
    actionSeq,
    actionError,
    pending,
    registerRowFocus,
    onRowContextMenu: handleRowContextMenu,
    onRowKeyDown: handleRowKeyDown,
    onActionsButtonClick: handleActionsButtonClick,
    onSubmitCreate: submitCreate,
    onSubmitFolderRename: submitFolderRename,
    onSubmitFileRename: submitFileRename,
    onCancelAction: cancelAction,
    onEditAction: clearActionError,
  };

  const rootLabelRef = useCallback(
    (element: HTMLButtonElement | null) => registerRowFocus(ROOT_ROW_KEY, element),
    [registerRowFocus]
  );

  return (
    <TreeContext.Provider value={treeContext}>
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
              disabled={pending}
              onClick={(event) =>
                startAction(
                  { type: 'create', parentId: createTargetId },
                  {
                    element: event.currentTarget,
                    rowKey: folderRowKey(createTargetId),
                  }
                )
              }
            >
              New folder
            </button>
          )}
        </header>

        {dialog}

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
              aria-expanded={rootHasChildren || draftAtRoot ? rootExpanded : undefined}
              data-testid={`folder-${ROOT_FOLDER_ID}`}
              onContextMenu={(event) => handleRowContextMenu(event, ROOT_TARGET)}
              onKeyDown={(event) => handleRowKeyDown(event, ROOT_TARGET)}
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
                ref={rootLabelRef}
                type="button"
                className="materials-app__folder-label"
                data-testid={`folder-label-${ROOT_FOLDER_ID}`}
                onClick={() => handleSelect(ROOT_FOLDER_ID)}
              >
                <span className="materials-app__folder-icon" aria-hidden="true">
                  🗄️
                </span>
                <span className="materials-app__folder-name">
                  {KNOWLEDGE_BASE_LABEL}
                </span>
              </button>
              <RowActionsButton target={ROOT_TARGET} name={KNOWLEDGE_BASE_LABEL} />
            </div>

            {rootExpanded && (rootHasChildren || draftAtRoot) && (
              <TreeChildren
                parentId={null}
                depth={0}
                childFolders={rootFolders}
                childFiles={rootFiles}
                filePaddingLeft={36}
              />
            )}
          </li>
        </ul>

        {!rootHasChildren && !draftAtRoot && (
          <p className="materials-app__empty" data-testid="materials-app-empty">
            No materials yet. Create a folder and upload files to build your
            Knowledge Base.
          </p>
        )}

        {menu && menuLabel !== undefined && menuItems.length > 0 && (
          <ContextMenu
            key={menu.key}
            id={menuId}
            label={`Actions for ${menuLabel}`}
            items={menuItems}
            position={menu.position}
            triggerElement={menu.trigger}
            onClose={(reason) => handleMenuClose(menu, reason)}
          />
        )}
      </section>
    </TreeContext.Provider>
  );
};

export default MaterialsApp;
