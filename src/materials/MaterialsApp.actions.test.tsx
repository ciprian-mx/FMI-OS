import { useState } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MaterialsApp, {
  ACTION_ERROR_MESSAGES,
  MOVE_DESTINATION_REQUIRED,
  MaterialFile,
  MaterialsAppProps,
  ROOT_FOLDER_ID,
} from './MaterialsApp';
import { FolderNode } from './folderHierarchy';

/**
 * Task 4.2 — MaterialsApp context menu and folder / file actions.
 *
 * Covers how the menu opens (right-click, Shift+F10 / context-menu key, the
 * per-row "More actions" button), its ARIA menu semantics (arrow keys, Escape,
 * Tab, outside press, focus return), and every action it offers: validation
 * before the callback fires, rejection with a retryable error that keeps the
 * student's input, cancel, and the new-folder / move / delete specifics. The
 * callbacks are plain jest mocks; the component is callback-driven.
 *
 * Validates: Requirements 7.1, 7.2, 7.8
 */

type User = ReturnType<typeof userEvent.setup>;

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

function file(id: string, folderId: string, name: string, folderPath: string): MaterialFile {
  return {
    id,
    studentId: STUDENT,
    folderId,
    name,
    size: 1024,
    format: 'application/pdf',
    uploadDate: '2024-01-02T00:00:00.000Z',
    indexingStatus: 'INDEXED',
    s3Key: `students/${STUDENT}/materials/${folderPath}/${name}`,
    folderPath,
  };
}

//   Knowledge Base (root)
//     ├ Algorithms (alg)
//     │   └ Week 3 (alg-w3)
//     │       └ sorting.pdf (f-alg-sorting)
//     ├ Data Structures (ds)
//     │   ├ Week 3 (w3)
//     │   │   └ sorting.pdf (f-sorting)
//     │   ├ overview.pdf (f-overview)
//     │   └ summary.pdf (f-summary)
//     └ syllabus.md (f-syllabus, stored at the root with an empty folderId)
const FOLDERS: FolderNode[] = [
  folder('alg', null, 'Algorithms', 'Algorithms'),
  folder('alg-w3', 'alg', 'Week 3', 'Algorithms/Week 3'),
  folder('ds', null, 'Data Structures', 'Data Structures'),
  folder('w3', 'ds', 'Week 3', 'Data Structures/Week 3'),
];
const FILES: MaterialFile[] = [
  file('f-alg-sorting', 'alg-w3', 'sorting.pdf', 'Algorithms > Week 3'),
  file('f-sorting', 'w3', 'sorting.pdf', 'Data Structures > Week 3'),
  file('f-overview', 'ds', 'overview.pdf', 'Data Structures'),
  file('f-summary', 'ds', 'summary.pdf', 'Data Structures'),
  file('f-syllabus', '', 'syllabus.md', ''),
];
const ALL_EXPANDED = [ROOT_FOLDER_ID, 'alg', 'alg-w3', 'ds', 'w3'];

type ActionCallback =
  | 'onCreateFolder'
  | 'onRenameFolder'
  | 'onMoveFolder'
  | 'onDeleteFolder'
  | 'onRenameFile'
  | 'onMoveFile'
  | 'onDeleteFile';

/** Renders the fully-expanded fixture with every action callback mocked. */
function renderApp(overrides: Partial<MaterialsAppProps> = {}) {
  const props: MaterialsAppProps = {
    studentId: STUDENT,
    folders: FOLDERS,
    files: FILES,
    expandedFolderIds: ALL_EXPANDED,
    onCreateFolder: jest.fn(),
    onRenameFolder: jest.fn(),
    onMoveFolder: jest.fn(),
    onDeleteFolder: jest.fn(),
    onRenameFile: jest.fn(),
    onMoveFile: jest.fn(),
    onDeleteFile: jest.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  render(<MaterialsApp {...props} />);
  return { user, props };
}

function withCallback(name: ActionCallback, mock: jest.Mock): Partial<MaterialsAppProps> {
  const overrides: Partial<MaterialsAppProps> = {};
  overrides[name] = mock;
  return overrides;
}

/** Opens a row's menu with its "More actions" button and picks an item. */
async function chooseAction(user: User, actionsButtonTestId: string, item: string) {
  await user.click(screen.getByTestId(actionsButtonTestId));
  await user.click(screen.getByRole('menuitem', { name: item }));
}

async function retype(user: User, textboxName: string, text: string) {
  const input = screen.getByRole('textbox', { name: textboxName });
  await user.clear(input);
  await user.type(input, text);
}

const menuItemNames = () =>
  screen.getAllByRole('menuitem').map((item) => item.textContent);

/** The move picker's selectable destinations (the placeholder excluded). */
const destinationOptions = () =>
  within(screen.getByRole('combobox', { name: 'Destination' }))
    .getAllByRole('option')
    .filter((option) => !(option as HTMLOptionElement).disabled)
    .map((option) => option.textContent);

const focusIsWithin = (testId: string) =>
  screen.getByTestId(testId).contains(document.activeElement);

describe('MaterialsApp context menu', () => {
  it('opens on right-click as an ARIA menu of the row actions, first item focused', async () => {
    const { user } = renderApp();
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('folder-label-ds') });

    const menu = screen.getByRole('menu', { name: 'Actions for Data Structures' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'New folder',
      'Rename',
      'Move',
      'Delete',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'New folder' })).toHaveFocus();
  });

  it('replaces the native menu on files and lists the file actions', () => {
    renderApp();
    // `false` means the browser's own context menu was suppressed.
    expect(fireEvent.contextMenu(screen.getByTestId('file-f-overview'))).toBe(false);
    expect(screen.getByRole('menu', { name: 'Actions for overview.pdf' })).toBeInTheDocument();
    expect(menuItemNames()).toEqual(['Rename', 'Move', 'Delete']);
  });

  it('offers only "New folder" on the Knowledge Base root and creates at the top level', async () => {
    const { user, props } = renderApp();
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByTestId(`folder-label-${ROOT_FOLDER_ID}`),
    });
    expect(screen.getByRole('menu', { name: 'Actions for Knowledge Base' })).toBeInTheDocument();
    expect(menuItemNames()).toEqual(['New folder']);

    await user.click(screen.getByRole('menuitem', { name: 'New folder' }));
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'Physics{Enter}');
    await waitFor(() => expect(props.onCreateFolder).toHaveBeenCalledWith(null, 'Physics'));
  });

  it('opens from the keyboard (Shift+F10, context-menu key); Escape returns focus to the row', async () => {
    const { user } = renderApp();
    const label = screen.getByTestId('folder-label-ds');
    label.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu', { name: 'Actions for Data Structures' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'New folder' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(label).toHaveFocus();

    // File rows with actions are focusable so the keyboard can reach their menu.
    const fileRow = screen.getByTestId('file-f-overview');
    expect(fileRow).toHaveAttribute('tabindex', '0');
    fileRow.focus();
    await user.keyboard('{ContextMenu}');
    expect(screen.getByRole('menu', { name: 'Actions for overview.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(fileRow).toHaveFocus();
  });

  it('toggles from the visible "More actions" button, which reflects the menu state', async () => {
    const { user } = renderApp();
    const button = screen.getByRole('button', { name: 'More actions for Data Structures' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'Actions for Data Structures' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', menu.id);

    await user.click(button);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves between items with arrow keys (wrapping), Home and End; Enter activates', async () => {
    const { user } = renderApp();
    await user.click(screen.getByTestId('folder-actions-ds'));
    const item = (name: string) => screen.getByRole('menuitem', { name });

    expect(item('New folder')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(item('Rename')).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(item('Delete')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(item('New folder')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(item('Delete')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(item('New folder')).toHaveFocus();
    await user.keyboard('{End}');
    expect(item('Delete')).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(
      screen.getByRole('alertdialog', { name: 'Delete folder "Data Structures"?' })
    ).toBeInTheDocument();
  });

  it('closes on Tab and returns focus to the control that opened it', async () => {
    const { user } = renderApp();
    const button = screen.getByTestId('folder-actions-ds');
    await user.click(button);
    await user.tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes on an outside press and returns focus to the row when nothing else took it', async () => {
    const { user } = renderApp();
    const label = screen.getByTestId('folder-label-ds');
    await user.pointer({ keys: '[MouseRight]', target: label });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(screen.getByRole('heading', { name: 'Materials' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(label).toHaveFocus());
  });

  it('closes on an outside press on another control and leaves focus there', async () => {
    const { user } = renderApp();
    await user.click(screen.getByTestId('folder-actions-ds'));
    const otherLabel = screen.getByTestId('folder-label-alg');

    await user.click(otherLabel);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(otherLabel).toHaveFocus();
  });

  it('only offers the actions whose callbacks are provided', async () => {
    const user = userEvent.setup();
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        expandedFolderIds={ALL_EXPANDED}
        onRenameFolder={jest.fn()}
      />
    );

    // No create / file callbacks: the root and files have no actions at all and
    // keep the browser's own context menu.
    expect(screen.queryByTestId('materials-app-new-folder')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`folder-actions-${ROOT_FOLDER_ID}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-actions-f-overview')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-f-overview')).not.toHaveAttribute('tabindex');
    expect(fireEvent.contextMenu(screen.getByTestId('file-f-overview'))).toBe(true);
    expect(fireEvent.contextMenu(screen.getByTestId(`folder-label-${ROOT_FOLDER_ID}`))).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('folder-actions-ds'));
    expect(menuItemNames()).toEqual(['Rename']);
  });

  it('renders no action affordances without action callbacks', () => {
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        expandedFolderIds={ALL_EXPANDED}
      />
    );
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
    expect(fireEvent.contextMenu(screen.getByTestId('folder-label-ds'))).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- *
 * Shared behaviour of every action: rejection / retry and cancel
 * -------------------------------------------------------------------------- */

interface ActionCase {
  name: string;
  callback: ActionCallback;
  /** The row the action is started from. */
  rowTestId: string;
  /** Opens the action from the row's "More actions" menu and fills it in. */
  start: (user: User) => Promise<void>;
  submit: (user: User) => Promise<void>;
  cancel: (user: User) => Promise<void>;
  expectedArgs: unknown[];
  errorMessage: string;
  /** Whether the action's editor / dialog is on screen. */
  isOpen: () => boolean;
}

const clickButton = (name: string) => (user: User) =>
  user.click(screen.getByRole('button', { name }));
const pressEscape = (user: User) => user.keyboard('{Escape}');

const ACTION_CASES: ActionCase[] = [
  {
    name: 'create folder',
    callback: 'onCreateFolder',
    rowTestId: 'folder-ds',
    start: async (user) => {
      await chooseAction(user, 'folder-actions-ds', 'New folder');
      await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'Week 4');
    },
    submit: clickButton('Create folder'),
    cancel: pressEscape,
    expectedArgs: ['ds', 'Week 4'],
    errorMessage: ACTION_ERROR_MESSAGES.createFolder,
    isOpen: () => screen.queryByRole('textbox', { name: 'New folder name' }) !== null,
  },
  {
    name: 'rename folder',
    callback: 'onRenameFolder',
    rowTestId: 'folder-w3',
    start: async (user) => {
      await chooseAction(user, 'folder-actions-w3', 'Rename');
      await retype(user, 'Rename Week 3', 'Week 03');
    },
    submit: clickButton('Save name'),
    cancel: clickButton('Cancel'),
    expectedArgs: ['w3', 'Week 03'],
    errorMessage: ACTION_ERROR_MESSAGES.renameFolder,
    isOpen: () => screen.queryByRole('textbox', { name: 'Rename Week 3' }) !== null,
  },
  {
    name: 'move folder',
    callback: 'onMoveFolder',
    rowTestId: 'folder-w3',
    start: async (user) => {
      await chooseAction(user, 'folder-actions-w3', 'Move');
      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Destination' }),
        ROOT_FOLDER_ID
      );
    },
    submit: clickButton('Move'),
    cancel: clickButton('Cancel'),
    expectedArgs: ['w3', null],
    errorMessage: ACTION_ERROR_MESSAGES.moveFolder,
    isOpen: () => screen.queryByRole('dialog') !== null,
  },
  {
    name: 'delete folder',
    callback: 'onDeleteFolder',
    rowTestId: 'folder-ds',
    start: (user) => chooseAction(user, 'folder-actions-ds', 'Delete'),
    submit: clickButton('Delete'),
    cancel: clickButton('Cancel'),
    expectedArgs: ['ds'],
    errorMessage: ACTION_ERROR_MESSAGES.deleteFolder,
    isOpen: () => screen.queryByRole('alertdialog') !== null,
  },
  {
    name: 'rename file',
    callback: 'onRenameFile',
    rowTestId: 'file-f-overview',
    start: async (user) => {
      await chooseAction(user, 'file-actions-f-overview', 'Rename');
      await retype(user, 'Rename overview.pdf', 'intro');
    },
    submit: clickButton('Save name'),
    cancel: pressEscape,
    expectedArgs: ['f-overview', 'intro.pdf'],
    errorMessage: ACTION_ERROR_MESSAGES.renameFile,
    isOpen: () => screen.queryByRole('textbox', { name: 'Rename overview.pdf' }) !== null,
  },
  {
    name: 'move file',
    callback: 'onMoveFile',
    rowTestId: 'file-f-overview',
    start: async (user) => {
      await chooseAction(user, 'file-actions-f-overview', 'Move');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Destination' }), 'alg');
    },
    submit: clickButton('Move'),
    cancel: pressEscape,
    expectedArgs: ['f-overview', 'alg'],
    errorMessage: ACTION_ERROR_MESSAGES.moveFile,
    isOpen: () => screen.queryByRole('dialog') !== null,
  },
  {
    name: 'delete file',
    callback: 'onDeleteFile',
    rowTestId: 'file-f-overview',
    start: (user) => chooseAction(user, 'file-actions-f-overview', 'Delete'),
    submit: clickButton('Delete'),
    cancel: pressEscape,
    expectedArgs: ['f-overview'],
    errorMessage: ACTION_ERROR_MESSAGES.deleteFile,
    isOpen: () => screen.queryByRole('alertdialog') !== null,
  },
];

describe.each(ACTION_CASES)('$name', (action) => {
  it('shows a retryable error when the callback rejects, keeping the input', async () => {
    const mock = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const { user } = renderApp(withCallback(action.callback, mock));

    await action.start(user);
    await action.submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(action.errorMessage);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenLastCalledWith(...action.expectedArgs);
    expect(action.isOpen()).toBe(true);

    // Retrying resubmits exactly what the student had entered.
    await action.submit(user);
    await waitFor(() => expect(action.isOpen()).toBe(false));
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock).toHaveBeenLastCalledWith(...action.expectedArgs);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(focusIsWithin(action.rowTestId)).toBe(true);
  });

  it('cancels without calling back and returns focus to the row', async () => {
    const mock = jest.fn();
    const { user } = renderApp(withCallback(action.callback, mock));

    await action.start(user);
    expect(action.isOpen()).toBe(true);
    await action.cancel(user);
    expect(action.isOpen()).toBe(false);
    expect(mock).not.toHaveBeenCalled();
    expect(focusIsWithin(action.rowTestId)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Action specifics
 * -------------------------------------------------------------------------- */

describe('New folder', () => {
  it('validates the name with the folder rules before calling back', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'folder-actions-ds', 'New folder');
    const input = screen.getByRole('textbox', { name: 'New folder name' });
    expect(input).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Folder name cannot be empty.');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await user.type(input, 'a/b{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Folder name cannot contain the "/" character.'
    );

    await retype(user, 'New folder name', '  week   3 {Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A folder named "week 3" already exists here.'
    );
    expect(props.onCreateFolder).not.toHaveBeenCalled();

    // A valid name is normalized before it is reported.
    await retype(user, 'New folder name', '  Week   4 {Enter}');
    await waitFor(() => expect(props.onCreateFolder).toHaveBeenCalledWith('ds', 'Week 4'));
    await waitFor(() => expect(screen.getByTestId('folder-actions-ds')).toHaveFocus());
  });

  it('expands a collapsed folder to show the entry and reports the expansion', async () => {
    const onToggleExpand = jest.fn();
    const { user, props } = renderApp({ expandedFolderIds: undefined, onToggleExpand });
    expect(screen.queryByTestId('folder-alg-w3')).not.toBeInTheDocument();

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('folder-label-alg') });
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }));
    expect(onToggleExpand).toHaveBeenCalledWith('alg', true);
    expect(screen.getByTestId('folder-alg-w3')).toBeInTheDocument();
    const algNode = screen.getByTestId('folder-alg').parentElement as HTMLElement;
    const input = within(algNode).getByRole('textbox', { name: 'New folder name' });

    await user.type(input, 'Week 4{Enter}');
    await waitFor(() => expect(props.onCreateFolder).toHaveBeenCalledWith('alg', 'Week 4'));
    await waitFor(() => expect(input).not.toBeInTheDocument());
    // The folder stays open, and focus is back on the row it was opened from.
    expect(screen.getByTestId('folder-alg-w3')).toBeInTheDocument();
    expect(screen.getByTestId('folder-label-alg')).toHaveFocus();
  });

  it('ignores repeated submits while the callback is in flight', async () => {
    let resolveCreate: () => void = () => undefined;
    const onCreateFolder = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = () => resolve();
        })
    );
    const { user } = renderApp({ onCreateFolder });
    await chooseAction(user, 'folder-actions-ds', 'New folder');
    const input = screen.getByRole('textbox', { name: 'New folder name' });

    await user.type(input, 'Week 4{Enter}');
    expect(onCreateFolder).toHaveBeenCalledTimes(1);
    expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Create folder' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByTestId('folder-actions-alg')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(onCreateFolder).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate();
    });
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(screen.getByTestId('folder-actions-alg')).toBeEnabled();
  });
});

describe('Rename folder', () => {
  it('edits inline, validates against siblings, and skips unchanged names', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'folder-actions-ds', 'Rename');
    const input = screen.getByRole('textbox', { name: 'Rename Data Structures' });
    expect(input).toHaveValue('Data Structures');
    expect(input).toHaveFocus();

    await retype(user, 'Rename Data Structures', 'algorithms{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A folder named "algorithms" already exists here.'
    );

    // An unchanged name just closes the editor.
    await retype(user, 'Rename Data Structures', 'Data Structures{Enter}');
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(props.onRenameFolder).not.toHaveBeenCalled();
    expect(screen.getByTestId('folder-label-ds')).toHaveFocus();

    await chooseAction(user, 'folder-actions-ds', 'Rename');
    await retype(user, 'Rename Data Structures', '  Data   Structures II {Enter}');
    await waitFor(() =>
      expect(props.onRenameFolder).toHaveBeenCalledWith('ds', 'Data Structures II')
    );
  });
});

describe('Rename file', () => {
  it('edits only the base name and keeps the extension', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'file-actions-f-overview', 'Rename');
    const input = screen.getByRole('textbox', { name: 'Rename overview.pdf' });
    expect(input).toHaveValue('overview');
    expect(input).toHaveAccessibleDescription('The .pdf extension is kept.');

    await retype(user, 'Rename overview.pdf', '{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('File name cannot be empty.');

    await retype(user, 'Rename overview.pdf', 'SUMMARY{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A file named "SUMMARY.pdf" already exists here.'
    );
    expect(props.onRenameFile).not.toHaveBeenCalled();

    // Typing the extension anyway does not double it.
    await retype(user, 'Rename overview.pdf', 'Intro.PDF{Enter}');
    await waitFor(() => expect(props.onRenameFile).toHaveBeenCalledWith('f-overview', 'Intro.pdf'));
  });
});

describe('Move folder', () => {
  it('offers only valid destinations and requires a choice', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'folder-actions-w3', 'Move');
    const dialog = screen.getByRole('dialog', { name: 'Move "Week 3"' });
    expect(dialog).toHaveAccessibleDescription('Currently in Knowledge Base > Data Structures.');
    // Not itself, not its current parent, and not Algorithms (it already has a "Week 3").
    expect(destinationOptions()).toEqual([
      'Knowledge Base',
      'Knowledge Base > Algorithms > Week 3',
    ]);
    expect(screen.getByRole('combobox', { name: 'Destination' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(MOVE_DESTINATION_REQUIRED);
    expect(props.onMoveFolder).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Destination' }), 'alg-w3');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(props.onMoveFolder).toHaveBeenCalledWith('w3', 'alg-w3'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('folder-actions-w3')).toHaveFocus();
  });

  it('never offers a folder its own subtree', async () => {
    const { user } = renderApp();
    await chooseAction(user, 'folder-actions-ds', 'Move');
    expect(destinationOptions()).toEqual([
      'Knowledge Base > Algorithms',
      'Knowledge Base > Algorithms > Week 3',
    ]);
  });
});

describe('Move file', () => {
  it('offers every other folder and rejects a name clash at the destination', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'file-actions-f-sorting', 'Move');
    expect(screen.getByRole('dialog', { name: 'Move "sorting.pdf"' })).toBeInTheDocument();
    expect(destinationOptions()).toEqual([
      'Knowledge Base',
      'Knowledge Base > Algorithms',
      'Knowledge Base > Algorithms > Week 3',
      'Knowledge Base > Data Structures',
    ]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Destination' }), 'alg-w3');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A file named "sorting.pdf" already exists in Knowledge Base > Algorithms > Week 3.'
    );
    expect(props.onMoveFile).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Destination' }), 'ds');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(props.onMoveFile).toHaveBeenCalledWith('f-sorting', 'ds'));
  });
});

describe('Delete', () => {
  it('warns that a folder is deleted with everything inside it, focusing Cancel first', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'folder-actions-ds', 'Delete');
    const dialog = screen.getByRole('alertdialog', { name: 'Delete folder "Data Structures"?' });
    expect(dialog).toHaveAccessibleDescription(
      /Everything inside it is deleted too: 1 subfolder and 3 files\./
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(props.onDeleteFolder).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(props.onDeleteFolder).toHaveBeenCalledWith('ds'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('confirms a file delete', async () => {
    const { user, props } = renderApp();
    await chooseAction(user, 'file-actions-f-overview', 'Delete');
    expect(
      screen.getByRole('alertdialog', { name: 'Delete file "overview.pdf"?' })
    ).toHaveAccessibleDescription(/removed from your Knowledge Base/);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(props.onDeleteFile).toHaveBeenCalledWith('f-overview'));
  });

  it('moves focus to the parent row once the deleted folder disappears', async () => {
    function Harness() {
      const [folders, setFolders] = useState(FOLDERS);
      return (
        <MaterialsApp
          studentId={STUDENT}
          folders={folders}
          files={FILES}
          expandedFolderIds={ALL_EXPANDED}
          onDeleteFolder={async (id) => {
            setFolders((current) => current.filter((node) => node.id !== id));
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);

    await chooseAction(user, 'folder-actions-w3', 'Delete');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('folder-w3')).not.toBeInTheDocument());
    expect(screen.getByTestId('folder-label-ds')).toHaveFocus();
  });
});
