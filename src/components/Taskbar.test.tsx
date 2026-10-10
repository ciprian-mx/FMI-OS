import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Taskbar from './Taskbar';

/**
 * Unit tests for the Taskbar shell (task 3.1).
 *
 * These cover the shell's contract only: exactly three controls are present,
 * each control invokes its callback, and the Taskbar itself is rendered and
 * visible. The persistent-visibility property test across arbitrary desktop
 * states is a separate task (3.2); here we only make visibility observable.
 */
describe('Taskbar', () => {
  it('renders the taskbar and it is present/visible', () => {
    render(<Taskbar />);
    const taskbar = screen.getByTestId('taskbar');
    expect(taskbar).toBeInTheDocument();
    expect(taskbar).toBeVisible();
    expect(taskbar).toHaveAttribute('role', 'toolbar');
  });

  it('renders exactly three controls: start-session, ask-gus, account-center', () => {
    render(<Taskbar />);

    // The three design-doc controls.
    expect(screen.getByTestId('taskbar-start-session')).toBeInTheDocument();
    expect(screen.getByTestId('taskbar-ask-gus')).toBeInTheDocument();
    expect(screen.getByTestId('taskbar-account-center')).toBeInTheDocument();

    // Exactly three top-level control regions sit directly in the taskbar: the
    // Start-session button, the Ask-Gus group, and the Account Center button.
    const taskbar = screen.getByTestId('taskbar');
    expect(taskbar.children).toHaveLength(3);
  });

  it('exposes the "Ask Gus" input and the microphone icon within control 2', () => {
    render(<Taskbar />);
    expect(screen.getByTestId('taskbar-ask-gus-input')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask Gus')).toBeInTheDocument();
    expect(screen.getByTestId('taskbar-mic')).toBeInTheDocument();
  });

  it('fires onStartSession when the start-session button is clicked', async () => {
    const user = userEvent.setup();
    const onStartSession = jest.fn();
    render(<Taskbar onStartSession={onStartSession} />);

    await user.click(screen.getByTestId('taskbar-start-session'));

    expect(onStartSession).toHaveBeenCalledTimes(1);
  });

  it('fires onAccountCenterOpen when the Account Center button is clicked', async () => {
    const user = userEvent.setup();
    const onAccountCenterOpen = jest.fn();
    render(<Taskbar onAccountCenterOpen={onAccountCenterOpen} />);

    await user.click(screen.getByTestId('taskbar-account-center'));

    expect(onAccountCenterOpen).toHaveBeenCalledTimes(1);
  });

  it('fires onVoiceActivate when the microphone icon is clicked (voice supported)', async () => {
    const user = userEvent.setup();
    const onVoiceActivate = jest.fn();
    render(<Taskbar onVoiceActivate={onVoiceActivate} isVoiceSupported />);

    await user.click(screen.getByTestId('taskbar-mic'));

    expect(onVoiceActivate).toHaveBeenCalledTimes(1);
  });

  it('fires onGusQuery with the trimmed query when Enter is pressed', async () => {
    const user = userEvent.setup();
    const onGusQuery = jest.fn();
    render(<Taskbar onGusQuery={onGusQuery} />);

    const input = screen.getByTestId('taskbar-ask-gus-input');
    await user.type(input, '  what is a red-black tree?  ');
    await user.keyboard('{Enter}');

    expect(onGusQuery).toHaveBeenCalledTimes(1);
    expect(onGusQuery).toHaveBeenCalledWith('what is a red-black tree?');
    // Input clears after submit.
    expect(input).toHaveValue('');
  });

  it('does not fire onGusQuery for an empty/whitespace-only query', async () => {
    const user = userEvent.setup();
    const onGusQuery = jest.fn();
    render(<Taskbar onGusQuery={onGusQuery} />);

    const input = screen.getByTestId('taskbar-ask-gus-input');
    await user.type(input, '   ');
    await user.keyboard('{Enter}');

    expect(onGusQuery).not.toHaveBeenCalled();
  });

  it('disables the microphone and does not fire onVoiceActivate when voice is unsupported', async () => {
    const user = userEvent.setup();
    const onVoiceActivate = jest.fn();
    render(<Taskbar onVoiceActivate={onVoiceActivate} isVoiceSupported={false} />);

    const mic = screen.getByTestId('taskbar-mic');
    expect(mic).toBeDisabled();
    expect(mic).toHaveAttribute(
      'aria-label',
      'Voice commands are not supported in this browser'
    );

    await user.click(mic);
    expect(onVoiceActivate).not.toHaveBeenCalled();
  });

  it('reflects listening state on the microphone icon', () => {
    const { rerender } = render(<Taskbar isListening={false} />);
    expect(screen.getByTestId('taskbar-mic')).toHaveAttribute('data-listening', 'false');

    rerender(<Taskbar isListening />);
    expect(screen.getByTestId('taskbar-mic')).toHaveAttribute('data-listening', 'true');
  });

  it('does not throw when controls are activated without callbacks provided', async () => {
    const user = userEvent.setup();
    render(<Taskbar />);

    await user.click(screen.getByTestId('taskbar-start-session'));
    await user.click(screen.getByTestId('taskbar-account-center'));
    await user.click(screen.getByTestId('taskbar-mic'));

    expect(screen.getByTestId('taskbar')).toBeInTheDocument();
  });
});
