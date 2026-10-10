import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountCenter, {
  API_KEY_DELETED_MESSAGE,
  API_KEY_DELETE_ERROR_MESSAGE,
  API_KEY_GENERATE_ERROR_MESSAGE,
  API_KEY_ONE_TIME_WARNING,
  LOGOUT_ERROR_MESSAGE,
  PROFILE_SAVED_MESSAGE,
  PROFILE_SAVE_ERROR_MESSAGE,
  type AccountCenterProps,
} from './AccountCenter';
import { DISPLAY_NAME_ERRORS, type AuthenticatedStudent } from '../account/accountService';

/**
 * Task 3.5 — AccountCenter panel.
 *
 * Example-based checks of the panel's contract: read-only email, display-name
 * editing with validation and error states, API key generate / view /
 * regenerate / delete (with confirmation for the destructive actions), logout,
 * closing on an outside press and on Escape, and focus management. All side
 * effects are injected callbacks. The universal close-trigger property
 * (Property 26) is property-tested separately in task 3.6.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 */

const STUDENT: AuthenticatedStudent = {
  id: 'student-1',
  email: 'student@s.unibuc.ro',
  displayName: 'Ana',
  hasApiKey: false,
};
const STUDENT_WITH_KEY: AuthenticatedStudent = { ...STUDENT, hasApiKey: true };
const NEW_KEY = `fmios_${'0123456789abcdef'.repeat(4)}`;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function baseProps(overrides: Partial<AccountCenterProps> = {}): AccountCenterProps {
  return {
    student: STUDENT,
    onUpdateProfile: jest.fn().mockResolvedValue(undefined),
    onRegenerateApiKey: jest.fn().mockResolvedValue(NEW_KEY),
    onDeleteApiKey: jest.fn().mockResolvedValue(undefined),
    onLogout: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
}

/** Renders the open panel next to an unrelated "Outside" control. */
function renderPanel(overrides: Partial<AccountCenterProps> = {}) {
  const props = baseProps(overrides);
  const user = userEvent.setup();
  const utils = render(
    <>
      <button type="button">Outside</button>
      <AccountCenter {...props} />
    </>
  );
  return { user, props, ...utils };
}

/** An owner that opens the panel from a button and unmounts it on close. */
function Harness(props: Omit<AccountCenterProps, 'onClose'>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Account Center
      </button>
      <button type="button">Elsewhere</button>
      {open && <AccountCenter {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

describe('AccountCenter panel', () => {
  it('opens as a labelled modal dialog and moves focus into it', () => {
    renderPanel();

    const dialog = screen.getByRole('dialog', { name: 'Account Center' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    const opener = screen.getByRole('button', { name: 'Open Account Center' });

    await user.click(opener);
    await user.click(screen.getByLabelText('Display name'));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes on a press outside and leaves focus where the student clicked', async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'Open Account Center' }));

    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    await user.click(elsewhere);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });

  it('does not close on presses inside the panel', async () => {
    const { user, props } = renderPanel();

    await user.click(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('heading', { name: 'Account Center' }));
    await user.click(screen.getByRole('heading', { name: 'Bedrock API key' }));

    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('calls onClose once per outside interaction, however it is dispatched', async () => {
    const { user, props } = renderPanel();
    const outside = screen.getByRole('button', { name: 'Outside' });

    fireEvent.click(outside); // a lone click (e.g. keyboard activation)
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await user.click(outside); // pointerdown + mousedown + click: one press
    expect(props.onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(document.body); // a lone mousedown
    expect(props.onClose).toHaveBeenCalledTimes(3);

    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(4);
  });

  it('closes from the header close button', async () => {
    const { user, props } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Close Account Center' }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab focus inside the panel', async () => {
    const { user } = renderPanel({ student: STUDENT_WITH_KEY });
    const closeButton = screen.getByRole('button', { name: 'Close Account Center' });
    const logoutButton = screen.getByRole('button', { name: 'Log out' });

    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(logoutButton).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();
  });
});

describe('AccountCenter profile', () => {
  it('shows the student email read-only', async () => {
    const { user } = renderPanel();
    const email = screen.getByLabelText('Email');

    expect(email).toHaveValue('student@s.unibuc.ro');
    expect(email).toHaveAttribute('readonly');

    await user.type(email, 'x');
    expect(email).toHaveValue('student@s.unibuc.ro');
  });

  it('saves an edited display name, trimmed, and confirms it', async () => {
    const save = deferred<void>();
    const onUpdateProfile = jest.fn(() => save.promise);
    const { user } = renderPanel({ onUpdateProfile });
    const input = screen.getByLabelText('Display name');

    expect(input).toHaveValue('Ana');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(input);
    await user.type(input, '  Ana Maria  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdateProfile).toHaveBeenCalledWith('Ana Maria');
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await act(async () => {
      save.resolve();
    });

    expect(input).toHaveValue('Ana Maria');
    expect(screen.getByTestId('account-center-profile-status')).toHaveTextContent(
      PROFILE_SAVED_MESSAGE
    );
    // Nothing left to save until the name changes again.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('rejects an empty display name inline without saving', async () => {
    const { user, props } = renderPanel();
    const input = screen.getByLabelText('Display name');

    await user.clear(input);
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(props.onUpdateProfile).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(DISPLAY_NAME_ERRORS.required);
    expect(input).toHaveFocus();

    await user.type(input, 'B');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(DISPLAY_NAME_ERRORS.required)).not.toBeInTheDocument();
  });

  it('keeps the draft and shows a retryable error when saving fails', async () => {
    const onUpdateProfile = jest.fn().mockRejectedValue(new Error('network'));
    const { user } = renderPanel({ onUpdateProfile });
    const input = screen.getByLabelText('Display name');

    await user.clear(input);
    await user.type(input, 'Ana Maria{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(PROFILE_SAVE_ERROR_MESSAGE);
    expect(onUpdateProfile).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('Ana Maria');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('AccountCenter API key', () => {
  it('generates a first key without confirmation and reveals it', async () => {
    const { user, props } = renderPanel();
    expect(screen.getByTestId('account-center-api-key-status')).toHaveTextContent('Not set');

    await user.click(screen.getByRole('button', { name: 'Generate key' }));

    expect(props.onRegenerateApiKey).toHaveBeenCalledTimes(1);
    const keyField = await screen.findByLabelText('Your new API key');
    expect(keyField).toHaveValue(NEW_KEY);
    expect(keyField).toHaveAttribute('type', 'text');
    expect(keyField).toHaveFocus();
    expect(keyField).toHaveAccessibleDescription(API_KEY_ONE_TIME_WARNING);
    expect(screen.getByTestId('account-center-api-key-status')).toHaveTextContent('Active');

    await user.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(keyField).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show key' }));
    expect(keyField).toHaveAttribute('type', 'text');
  });

  it('shows an existing key only as masked, and never re-shows a generated key', async () => {
    const { user, unmount } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Generate key' }));
    expect(await screen.findByDisplayValue(NEW_KEY)).toBeInTheDocument();
    unmount();

    // Reopening: only the hash exists now, so the key is masked.
    renderPanel({ student: STUDENT_WITH_KEY });
    expect(screen.getByTestId('account-center-api-key-masked')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(NEW_KEY)).not.toBeInTheDocument();
    const stored = [localStorage, sessionStorage]
      .flatMap((store) => Object.keys(store).map((key) => store.getItem(key)))
      .join('\n');
    expect(stored).not.toContain(NEW_KEY);
  });

  it('asks for confirmation before regenerating an existing key', async () => {
    const { user, props } = renderPanel({ student: STUDENT_WITH_KEY });
    const regenerate = screen.getByRole('button', { name: 'Regenerate key' });

    await user.click(regenerate);
    const confirmation = screen.getByRole('group', { name: /Regenerate your API key\?/ });
    expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(regenerate).toHaveFocus();
    expect(props.onRegenerateApiKey).not.toHaveBeenCalled();

    await user.click(regenerate);
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(props.onRegenerateApiKey).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('Your new API key')).toHaveValue(NEW_KEY);
    expect(screen.queryByTestId('account-center-api-key-masked')).not.toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('keeps the current key and reports an error when regeneration fails', async () => {
    const onRegenerateApiKey = jest.fn().mockRejectedValue(new Error('denied'));
    const { user } = renderPanel({ student: STUDENT_WITH_KEY, onRegenerateApiKey });

    await user.click(screen.getByRole('button', { name: 'Regenerate key' }));
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(API_KEY_GENERATE_ERROR_MESSAGE);
    expect(screen.getByTestId('account-center-api-key-masked')).toBeInTheDocument();
    expect(screen.getByTestId('account-center-api-key-status')).toHaveTextContent('Active');
    // The confirmation stays open for a retry.
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  });

  it('asks for confirmation before deleting the key, then clears it', async () => {
    const { user, props } = renderPanel({ student: STUDENT_WITH_KEY });

    await user.click(screen.getByRole('button', { name: 'Delete key' }));
    const confirmation = screen.getByRole('group', { name: /Delete your API key\?/ });
    await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(props.onDeleteApiKey).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete key' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Delete key' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(props.onDeleteApiKey).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Generate key' })).toHaveFocus();
    expect(screen.getByTestId('account-center-api-key-status')).toHaveTextContent('Not set');
    expect(screen.queryByRole('button', { name: 'Delete key' })).not.toBeInTheDocument();
    expect(screen.getByTestId('account-center-api-key-status-message')).toHaveTextContent(
      API_KEY_DELETED_MESSAGE
    );
  });

  it('keeps the key and reports an error when deletion fails', async () => {
    const onDeleteApiKey = jest.fn().mockRejectedValue(new Error('offline'));
    const { user } = renderPanel({ student: STUDENT_WITH_KEY, onDeleteApiKey });

    await user.click(screen.getByRole('button', { name: 'Delete key' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(API_KEY_DELETE_ERROR_MESSAGE);
    expect(screen.getByTestId('account-center-api-key-status')).toHaveTextContent('Active');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});

describe('AccountCenter logout', () => {
  it('logs out through onLogout and stays busy while leaving', async () => {
    const logout = deferred<void>();
    const onLogout = jest.fn(() => logout.promise);
    const { user } = renderPanel({ onLogout });

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Logging out…' })).toBeDisabled();

    await act(async () => {
      logout.resolve();
    });
    expect(screen.getByRole('button', { name: 'Logging out…' })).toBeDisabled();
  });

  it('shows a retryable error when logout fails', async () => {
    const onLogout = jest.fn().mockRejectedValue(new Error('network'));
    const { user } = renderPanel({ onLogout });

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(LOGOUT_ERROR_MESSAGE);
    expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
  });
});
