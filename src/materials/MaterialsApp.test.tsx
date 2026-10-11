import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MaterialsApp, {
  MaterialFile,
  ROOT_FOLDER_ID,
} from './MaterialsApp';
import { FolderNode } from './folderHierarchy';

/**
 * Task 4.2 — MaterialsApp hierarchical tree view.
 *
 * These tests exercise the presentational tree behaviour the task calls for:
 * rendering a nested folder tree, expanding a folder to reveal its children,
 * selecting a folder, listing the files inside a folder, and collapsing to hide
 * children. Folder/file data is passed as props (the flat adjacency-list shape
 * from the task 4.1 data layer); the component is driven uncontrolled unless a
 * test opts into controlled props.
 *
 * Validates: Requirements 7.1, 7.2
 */

const STUDENT = 'student-1';

function folder(
  id: string,
  parentId: string | null,
  name: string,
  path: string
): FolderNode {
  return {
    id,
    studentId: STUDENT,
    name,
    parentId,
    path,
    createdDate: '2024-01-01T00:00:00.000Z',
  };
}

function file(
  id: string,
  folderId: string,
  name: string,
  folderPath: string,
  indexingStatus: MaterialFile['indexingStatus'] = 'INDEXED'
): MaterialFile {
  return {
    id,
    studentId: STUDENT,
    folderId,
    name,
    size: 1024,
    format: 'application/pdf',
    uploadDate: '2024-01-02T00:00:00.000Z',
    indexingStatus,
    s3Key: `students/${STUDENT}/materials/${folderPath}/${name}`,
    folderPath,
  };
}

// A small hierarchy:
//   Knowledge Base (root)
//     └ Data Structures (ds)
//         ├ Week 3 (w3)
//         │    └ sorting.pdf
//         └ overview.pdf
const DS = folder('ds', null, 'Data Structures', 'Data Structures');
const WEEK3 = folder('w3', 'ds', 'Week 3', 'Data Structures/Week 3');
const FOLDERS: FolderNode[] = [DS, WEEK3];
const FILES: MaterialFile[] = [
  file('f-overview', 'ds', 'overview.pdf', 'Data Structures'),
  file('f-sorting', 'w3', 'sorting.pdf', 'Data Structures/Week 3', 'PENDING'),
];

describe('MaterialsApp tree view', () => {
  it('renders the Knowledge Base root with its top-level folder expanded', () => {
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        expandedFolderIds={[ROOT_FOLDER_ID]}
      />
    );

    expect(screen.getByTestId('materials-app')).toBeInTheDocument();
    expect(screen.getByText('Knowledge Base')).toBeInTheDocument();
    // Root is expanded -> its direct child folder is visible.
    expect(screen.getByTestId('folder-ds')).toBeInTheDocument();
    // Deeper folder stays hidden until "Data Structures" is expanded.
    expect(screen.queryByTestId('folder-w3')).not.toBeInTheDocument();
  });

  it('expanding a folder reveals its child folders and files', async () => {
    const user = userEvent.setup();
    render(<MaterialsApp studentId={STUDENT} folders={FOLDERS} files={FILES} />);

    // Root starts expanded (uncontrolled default); Data Structures is collapsed.
    expect(screen.getByTestId('folder-ds')).toBeInTheDocument();
    expect(screen.queryByTestId('folder-w3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-f-overview')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('folder-toggle-ds'));

    // Now the child folder and the file directly in Data Structures appear.
    expect(screen.getByTestId('folder-w3')).toBeInTheDocument();
    expect(screen.getByTestId('file-f-overview')).toBeInTheDocument();
    // The grandchild file is still hidden (Week 3 is collapsed).
    expect(screen.queryByTestId('file-f-sorting')).not.toBeInTheDocument();
  });

  it('lists the files inside a folder once it is expanded, with status', async () => {
    const user = userEvent.setup();
    render(<MaterialsApp studentId={STUDENT} folders={FOLDERS} files={FILES} />);

    await user.click(screen.getByTestId('folder-toggle-ds'));
    await user.click(screen.getByTestId('folder-toggle-w3'));

    const sorting = screen.getByTestId('file-f-sorting');
    expect(within(sorting).getByText('sorting.pdf')).toBeInTheDocument();
    expect(screen.getByTestId('file-status-f-sorting')).toHaveTextContent(
      'Pending'
    );
    expect(screen.getByTestId('file-status-f-overview')).toHaveTextContent(
      'Indexed'
    );
  });

  it('selecting a folder highlights it and reports the selection', async () => {
    const user = userEvent.setup();
    const onSelectFolder = jest.fn();
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        onSelectFolder={onSelectFolder}
      />
    );

    await user.click(screen.getByTestId('folder-label-ds'));

    expect(onSelectFolder).toHaveBeenCalledWith('ds');
    expect(screen.getByTestId('folder-ds').className).toContain(
      'materials-app__folder--selected'
    );
  });

  it('reports the root as a null selection', async () => {
    const user = userEvent.setup();
    const onSelectFolder = jest.fn();
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        onSelectFolder={onSelectFolder}
      />
    );

    await user.click(screen.getByTestId(`folder-label-${ROOT_FOLDER_ID}`));

    expect(onSelectFolder).toHaveBeenCalledWith(null);
  });

  it('collapsing a folder hides its children again', async () => {
    const user = userEvent.setup();
    render(<MaterialsApp studentId={STUDENT} folders={FOLDERS} files={FILES} />);

    await user.click(screen.getByTestId('folder-toggle-ds'));
    expect(screen.getByTestId('folder-w3')).toBeInTheDocument();

    await user.click(screen.getByTestId('folder-toggle-ds'));
    expect(screen.queryByTestId('folder-w3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-f-overview')).not.toBeInTheDocument();
  });

  it('fires onToggleExpand with the folder id and next expanded state', async () => {
    const user = userEvent.setup();
    const onToggleExpand = jest.fn();
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        onToggleExpand={onToggleExpand}
      />
    );

    await user.click(screen.getByTestId('folder-toggle-ds'));
    expect(onToggleExpand).toHaveBeenCalledWith('ds', true);

    await user.click(screen.getByTestId('folder-toggle-ds'));
    expect(onToggleExpand).toHaveBeenCalledWith('ds', false);
  });

  it('shows an empty-state message when there are no folders or files', () => {
    render(<MaterialsApp studentId={STUDENT} folders={[]} files={[]} />);
    expect(screen.getByTestId('materials-app-empty')).toBeInTheDocument();
  });

  // Updated deliberately when task 4.2's context menu landed: `onCreateFolder`
  // changed from `(parentId)`, fired on click, to `(parentId, name)`, fired once
  // the student names the folder in the inline entry the button opens.
  it('offers a create-folder control targeting the selected folder', async () => {
    const user = userEvent.setup();
    const onCreateFolder = jest.fn();
    render(
      <MaterialsApp
        studentId={STUDENT}
        folders={FOLDERS}
        files={FILES}
        onCreateFolder={onCreateFolder}
      />
    );

    // Clicking only opens the inline name entry; nothing is created yet.
    await user.click(screen.getByTestId('materials-app-new-folder'));
    expect(onCreateFolder).not.toHaveBeenCalled();

    // Nothing selected beyond the root -> targets null (root).
    await user.type(
      screen.getByRole('textbox', { name: 'New folder name' }),
      'Algorithms{Enter}'
    );
    await waitFor(() =>
      expect(onCreateFolder).toHaveBeenLastCalledWith(null, 'Algorithms')
    );

    // Select a folder, then create -> targets that folder id.
    await user.click(screen.getByTestId('folder-label-ds'));
    await user.click(screen.getByTestId('materials-app-new-folder'));
    await user.type(
      await screen.findByRole('textbox', { name: 'New folder name' }),
      'Week 4{Enter}'
    );
    await waitFor(() =>
      expect(onCreateFolder).toHaveBeenLastCalledWith('ds', 'Week 4')
    );
    expect(onCreateFolder).toHaveBeenCalledTimes(2);
  });
});
