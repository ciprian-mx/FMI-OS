import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceCommandHandler, {
  isSessionStartPhrase,
  normalizeVoicePhrase,
  SESSION_START_PHRASE,
} from './VoiceCommandHandler';
import type { SpeechRecognitionFailure } from './useSpeechRecognition';
import {
  createFakeSpeechRecognition,
  type FakeSpeechRecognitionApi,
} from './testing/fakeSpeechRecognition';

/**
 * Unit tests for voice command routing (task 3.3, Requirements 5.1-5.5): the
 * session-start phrase match, and the handler's render-prop state.
 */

describe('isSessionStartPhrase', () => {
  it.each([
    SESSION_START_PHRASE,
    "start today's session",
    'Start today’s session.',
    "  START TODAY'S SESSION!  ",
    'start todays session',
    'Start session',
  ])('recognizes %j as the session-start command', (transcript) => {
    expect(isSessionStartPhrase(transcript)).toBe(true);
  });

  it.each([
    '',
    'start',
    "How do I start today's session?",
    "Start today's session please",
    'Restart session',
    "Start yesterday's session",
  ])('does not treat %j as the command', (transcript) => {
    expect(isSessionStartPhrase(transcript)).toBe(false);
  });

  it('normalizes case, apostrophes, punctuation and spacing only for comparison', () => {
    expect(normalizeVoicePhrase("  Start   Today’s\tsession!? ")).toBe('start todays session');
  });
});

describe('VoiceCommandHandler', () => {
  function renderHandler(speech: FakeSpeechRecognitionApi | null) {
    const onTranscript = jest.fn<void, [string]>();
    const onSessionStart = jest.fn<void, []>();
    const onError = jest.fn<void, [SpeechRecognitionFailure]>();
    render(
      <VoiceCommandHandler
        onTranscript={onTranscript}
        onSessionStart={onSessionStart}
        onError={onError}
        getRecognitionConstructor={() => speech?.Recognition}
      >
        {(voice) => (
          <>
            <button
              type="button"
              disabled={!voice.isSupported}
              aria-pressed={voice.isListening}
              onClick={voice.activate}
            >
              mic
            </button>
            <output data-testid="interim">{voice.interimTranscript}</output>
            <output data-testid="error">{voice.error?.message}</output>
          </>
        )}
      </VoiceCommandHandler>
    );
    return {
      user: userEvent.setup(),
      onTranscript,
      onSessionStart,
      onError,
      mic: screen.getByRole('button', { name: 'mic' }),
    };
  }

  it('starts listening on activate and sends a spoken question to onTranscript verbatim', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, onTranscript, onSessionStart } = renderHandler(speech);

    await user.click(mic);
    expect(speech.latest().startCalls).toBe(1);
    expect(mic).toHaveAttribute('aria-pressed', 'true');

    act(() => speech.latest().emitFinal(' What is a heap? '));

    expect(onTranscript.mock.calls).toEqual([[' What is a heap? ']]);
    expect(onSessionStart).not.toHaveBeenCalled();
  });

  it('calls onSessionStart instead of onTranscript for "Start today\'s session"', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, onTranscript, onSessionStart } = renderHandler(speech);

    await user.click(mic);
    act(() => speech.latest().emitFinal("Start today's session."));

    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('acts on final results only: an interim command does nothing', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, onTranscript, onSessionStart } = renderHandler(speech);

    await user.click(mic);
    act(() => speech.latest().emitInterim("start today's session"));

    expect(screen.getByTestId('interim')).toHaveTextContent("start today's session");
    expect(onSessionStart).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('exposes failures and forwards them to onError', async () => {
    const speech = createFakeSpeechRecognition();
    const { user, mic, onError } = renderHandler(speech);

    await user.click(mic);
    act(() => speech.latest().emitError('network'));

    expect(mic).toHaveAttribute('aria-pressed', 'false');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'network' }));
    expect(screen.getByTestId('error')).toHaveTextContent(
      'Voice recognition needs a network connection.'
    );
  });

  it('reports isSupported=false when the Web Speech API is unavailable', () => {
    const { mic } = renderHandler(null);
    expect(mic).toBeDisabled();
  });
});
