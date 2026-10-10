import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceTaskbar, { LISTENING_PLACEHOLDER, type VoiceTaskbarProps } from './VoiceTaskbar';
import { describeSpeechRecognitionError } from './useSpeechRecognition';
import {
  createFakeSpeechRecognition,
  type FakeSpeechRecognitionApi,
} from './testing/fakeSpeechRecognition';

/**
 * Voice commands on the real Taskbar (task 3.3, Requirements 5.1-5.5): mic
 * click to listen, transcription into "Ask Gus", the spoken session-start
 * command, listening feedback, failures, and the unsupported-API path.
 */

function renderVoiceTaskbar(
  speech: FakeSpeechRecognitionApi | null = createFakeSpeechRecognition(),
  props: Partial<VoiceTaskbarProps> = {}
) {
  const callbacks = {
    onStartSession: jest.fn<void, []>(),
    onGusQuery: jest.fn<void, [string]>(),
    onAccountCenterOpen: jest.fn<void, []>(),
  };
  render(
    <VoiceTaskbar
      {...callbacks}
      getRecognitionConstructor={() => speech?.Recognition}
      {...props}
    />
  );
  return {
    ...callbacks,
    user: userEvent.setup(),
    input: screen.getByTestId('taskbar-ask-gus-input'),
    mic: screen.getByTestId('taskbar-mic'),
    status: screen.getByTestId('voice-taskbar-status'),
  };
}

describe('VoiceTaskbar', () => {
  it('starts listening when the mic is clicked, with visual feedback', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, input, status } = renderVoiceTaskbar(speech);
    expect(mic).toHaveAttribute('data-listening', 'false');
    expect(input).toHaveAttribute('placeholder', 'Ask Gus…');

    await user.click(mic);

    expect(speech.latest().startCalls).toBe(1);
    expect(mic).toHaveAttribute('data-listening', 'true');
    expect(mic).toHaveAttribute('aria-pressed', 'true');
    expect(input).toHaveAttribute('placeholder', LISTENING_PLACEHOLDER);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('');
  });

  it('shows interim words as the placeholder without changing the input', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, input } = renderVoiceTaskbar(speech);
    await user.click(mic);

    act(() => speech.latest().emitInterim('what is a'));

    expect(input).toHaveAttribute('placeholder', 'what is a');
    expect(input).toHaveValue('');
  });

  it('populates "Ask Gus" with the exact transcription and focuses it for sending', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, input, onGusQuery, onStartSession } = renderVoiceTaskbar(speech);
    await user.click(mic);

    act(() => speech.latest().emitFinal('  What is a B-tree?  '));
    act(() => speech.latest().emitEnd());

    expect(input).toHaveValue('  What is a B-tree?  ');
    expect(input).toHaveFocus();
    expect(mic).toHaveAttribute('data-listening', 'false');
    expect(input).toHaveAttribute('placeholder', 'Ask Gus…');
    // Nothing is sent until the student confirms with Enter.
    expect(onGusQuery).not.toHaveBeenCalled();
    expect(onStartSession).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');

    expect(onGusQuery.mock.calls).toEqual([['What is a B-tree?']]);
    expect(input).toHaveValue('');
  });

  it('replaces a typed draft with the transcription', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, input } = renderVoiceTaskbar(speech);
    await user.type(input, 'old draft');
    await user.click(mic);

    act(() => speech.latest().emitFinal('new question'));

    expect(input).toHaveValue('new question');
  });

  it('starts the session when "Start today\'s session" is spoken, leaving the input alone', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, input, onStartSession, onGusQuery } = renderVoiceTaskbar(speech);
    await user.type(input, 'draft');
    await user.click(mic);

    act(() => speech.latest().emitFinal("Start today's session"));
    act(() => speech.latest().emitEnd());

    expect(onStartSession).toHaveBeenCalledTimes(1);
    expect(onGusQuery).not.toHaveBeenCalled();
    expect(input).toHaveValue('draft');
  });

  it('stops listening and says why when no speech is heard, until the student moves on', async () => {
    const speech = createFakeSpeechRecognition();
    const onVoiceError = jest.fn();
    const { user, mic, input, status } = renderVoiceTaskbar(speech, { onVoiceError });
    await user.click(mic);

    act(() => speech.latest().emitError('no-speech'));
    act(() => speech.latest().emitEnd());

    const message = describeSpeechRecognitionError('no-speech');
    expect(mic).toHaveAttribute('data-listening', 'false');
    expect(input).toHaveAttribute('placeholder', message);
    expect(status).toHaveTextContent(message);
    expect(onVoiceError).toHaveBeenCalledWith({ code: 'no-speech', message });
    expect(input).toHaveValue('');

    await user.type(input, 'x');
    expect(status).toHaveTextContent('');
    expect(input).toHaveAttribute('placeholder', 'Ask Gus…');

    // The mic can be used again.
    await user.click(mic);
    expect(speech.instances).toHaveLength(2);
    expect(mic).toHaveAttribute('data-listening', 'true');
  });

  it('ends quietly when the session ends without a result', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, input, status, onGusQuery, onStartSession } = renderVoiceTaskbar(speech);
    await user.click(mic);

    act(() => speech.latest().emitEnd());

    expect(mic).toHaveAttribute('data-listening', 'false');
    expect(input).toHaveValue('');
    expect(status).toHaveTextContent('');
    expect(onGusQuery).not.toHaveBeenCalled();
    expect(onStartSession).not.toHaveBeenCalled();
  });

  it('stops listening when the mic is clicked again', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic } = renderVoiceTaskbar(speech);
    await user.click(mic);

    await user.click(mic);
    expect(speech.instances).toHaveLength(1);
    expect(speech.latest().stopCalls).toBe(1);

    act(() => speech.latest().emitEnd());
    expect(mic).toHaveAttribute('data-listening', 'false');
  });

  it('disables the mic with a tooltip when the Web Speech API is unavailable; typing still works', async () => {
    const { user, mic, input, onGusQuery } = renderVoiceTaskbar(null);

    expect(mic).toBeDisabled();
    expect(mic).toHaveAttribute('title', expect.stringMatching(/not supported/i));
    await user.click(mic);
    expect(mic).toHaveAttribute('data-listening', 'false');

    await user.type(input, 'typed question{Enter}');
    expect(onGusQuery).toHaveBeenCalledWith('typed question');
  });

  describe('browser detection', () => {
    afterEach(() => {
      Reflect.deleteProperty(window, 'webkitSpeechRecognition');
    });

    it('is unsupported in a browser without the Web Speech API', () => {
      render(<VoiceTaskbar />);
      expect(screen.getByTestId('taskbar-mic')).toBeDisabled();
    });

    it('uses window.webkitSpeechRecognition when the browser provides it', async () => {
      const speech = createFakeSpeechRecognition();
      Object.defineProperty(window, 'webkitSpeechRecognition', {
        configurable: true,
        writable: true,
        value: speech.Recognition,
      });
      const user = userEvent.setup();
      render(<VoiceTaskbar />);

      const mic = screen.getByTestId('taskbar-mic');
      expect(mic).toBeEnabled();
      await user.click(mic);
      expect(speech.latest().startCalls).toBe(1);
    });
  });
});
