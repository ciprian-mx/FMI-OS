import { act, renderHook } from '@testing-library/react';
import {
  describeSpeechRecognitionError,
  getSpeechRecognitionConstructor,
  type SpeechRecognitionFailure,
  useSpeechRecognition,
  type UseSpeechRecognitionOptions,
} from './useSpeechRecognition';
import {
  createFakeSpeechRecognition,
  type FakeSpeechRecognitionOptions,
} from './testing/fakeSpeechRecognition';

/**
 * Unit tests for the Web Speech API binding (task 3.3, Requirements 5.1, 5.2,
 * 5.4, 5.5), driven by a fake recognizer since jsdom has none.
 */

function setup(
  options: UseSpeechRecognitionOptions = {},
  fakeOptions: FakeSpeechRecognitionOptions = {}
) {
  const speech = createFakeSpeechRecognition(fakeOptions);
  const onFinalTranscript = jest.fn<void, [string]>();
  const onError = jest.fn<void, [SpeechRecognitionFailure]>();
  const hook = renderHook(() =>
    useSpeechRecognition({
      getRecognitionConstructor: () => speech.Recognition,
      onFinalTranscript,
      onError,
      ...options,
    })
  );
  return { speech, onFinalTranscript, onError, hook };
}

describe('getSpeechRecognitionConstructor', () => {
  class Standard {}
  class Prefixed {}

  it('prefers SpeechRecognition and falls back to webkitSpeechRecognition', () => {
    expect(
      getSpeechRecognitionConstructor({ SpeechRecognition: Standard, webkitSpeechRecognition: Prefixed })
    ).toBe(Standard);
    expect(getSpeechRecognitionConstructor({ webkitSpeechRecognition: Prefixed })).toBe(Prefixed);
  });

  it('returns undefined when the API is missing or not a constructor', () => {
    expect(getSpeechRecognitionConstructor({})).toBeUndefined();
    expect(getSpeechRecognitionConstructor({ SpeechRecognition: 'nope' })).toBeUndefined();
    expect(getSpeechRecognitionConstructor(undefined)).toBeUndefined();
    // jsdom's window has no Web Speech API.
    expect(getSpeechRecognitionConstructor()).toBeUndefined();
  });
});

describe('useSpeechRecognition', () => {
  it('reports the API as unsupported and does not listen without an implementation', () => {
    const { hook, onError } = setup({ getRecognitionConstructor: () => undefined });
    expect(hook.result.current.isSupported).toBe(false);

    act(() => hook.result.current.start());

    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.error?.code).toBe('unsupported');
    expect(onError).toHaveBeenCalledWith({
      code: 'unsupported',
      message: 'Voice commands are not supported in this browser.',
    });
  });

  it('starts one single-utterance English session with interim results', () => {
    const { hook, speech } = setup();
    expect(hook.result.current.isSupported).toBe(true);
    expect(hook.result.current.isListening).toBe(false);

    act(() => hook.result.current.start());
    act(() => hook.result.current.start());

    expect(speech.instances).toHaveLength(1);
    const recognition = speech.latest();
    expect(recognition.startCalls).toBe(1);
    expect(recognition).toMatchObject({
      lang: 'en-US',
      continuous: false,
      interimResults: true,
      maxAlternatives: 1,
    });
    expect(hook.result.current.isListening).toBe(true);
  });

  it('uses the requested recognition language', () => {
    const { hook, speech } = setup({ lang: 'ro-RO' });
    act(() => hook.result.current.start());
    expect(speech.latest().lang).toBe('ro-RO');
  });

  it('exposes interim guesses without delivering them, then delivers the final transcript verbatim', () => {
    const { hook, speech, onFinalTranscript } = setup();
    act(() => hook.result.current.start());

    act(() => speech.latest().emitInterim('what is a'));
    expect(hook.result.current.interimTranscript).toBe('what is a');
    expect(onFinalTranscript).not.toHaveBeenCalled();

    act(() => speech.latest().emitFinal('  What is a B-tree, Gus?  '));
    expect(onFinalTranscript.mock.calls).toEqual([['  What is a B-tree, Gus?  ']]);
    expect(hook.result.current.interimTranscript).toBe('');
  });

  it('delivers only the segments that became final in this event', () => {
    const { hook, speech, onFinalTranscript } = setup();
    act(() => hook.result.current.start());

    act(() =>
      speech.latest().emitResults(
        [
          { transcript: 'delivered before', isFinal: true },
          { transcript: ' new words', isFinal: true },
          { transcript: ' still talking', isFinal: false },
        ],
        1
      )
    );

    expect(onFinalTranscript.mock.calls).toEqual([[' new words']]);
    expect(hook.result.current.interimTranscript).toBe(' still talking');
  });

  it('stops listening when the session ends', () => {
    const { hook, speech, onFinalTranscript, onError } = setup();
    act(() => hook.result.current.start());
    act(() => speech.latest().emitInterim('hel'));

    act(() => speech.latest().emitEnd());

    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.interimTranscript).toBe('');
    expect(hook.result.current.error).toBeNull();
    expect(onFinalTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stop() lets the recognizer finish and still delivers what was heard', () => {
    const { hook, speech, onFinalTranscript } = setup();
    act(() => hook.result.current.start());

    act(() => hook.result.current.stop());
    expect(speech.latest().stopCalls).toBe(1);
    expect(hook.result.current.isListening).toBe(true);

    act(() => speech.latest().emitFinal('last words'));
    act(() => speech.latest().emitEnd());
    expect(onFinalTranscript).toHaveBeenCalledWith('last words');
    expect(hook.result.current.isListening).toBe(false);
  });

  it('toggle() starts when idle and stops while listening', () => {
    const { hook, speech } = setup();

    act(() => hook.result.current.toggle());
    expect(hook.result.current.isListening).toBe(true);

    act(() => hook.result.current.toggle());
    expect(speech.instances).toHaveLength(1);
    expect(speech.latest().stopCalls).toBe(1);

    act(() => speech.latest().emitEnd());
    act(() => hook.result.current.toggle());
    expect(speech.instances).toHaveLength(2);
    expect(speech.latest().startCalls).toBe(1);
  });

  it.each([
    ['no-speech', 'No speech was detected. Try again, or type your question.'],
    ['not-allowed', 'Microphone access is blocked. Allow it in your browser to use voice commands.'],
    ['language-not-supported', 'Voice recognition failed. Please try typing instead.'],
  ])('reports a "%s" error and stops listening', (code, message) => {
    const { hook, speech, onError } = setup();
    act(() => hook.result.current.start());

    act(() => speech.latest().emitError(code));
    act(() => speech.latest().emitEnd());

    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.error).toEqual({ code, message });
    expect(describeSpeechRecognitionError(code)).toBe(message);
    expect(onError.mock.calls).toEqual([[{ code, message }]]);

    // The next attempt starts clean.
    act(() => hook.result.current.start());
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.isListening).toBe(true);
  });

  it('treats an aborted session as a cancel, not a failure', () => {
    const { hook, speech, onError } = setup();
    act(() => hook.result.current.start());

    act(() => speech.latest().emitError('aborted'));

    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a no-match, or an empty final transcript, as not recognized', () => {
    const { hook, speech, onFinalTranscript, onError } = setup();
    act(() => hook.result.current.start());
    act(() => speech.latest().emitNoMatch());
    expect(hook.result.current.error?.code).toBe('no-match');

    act(() => speech.latest().emitEnd());
    act(() => hook.result.current.start());
    act(() => speech.latest().emitFinal(''));

    expect(onFinalTranscript).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(([failure]) => failure.code)).toEqual(['no-match', 'no-match']);
  });

  it('marks the API unsupported when a recognizer cannot be constructed', () => {
    const { hook, onError } = setup({}, { throwOnConstruct: true });
    expect(hook.result.current.isSupported).toBe(true);

    act(() => hook.result.current.start());

    expect(hook.result.current.isSupported).toBe(false);
    expect(hook.result.current.isListening).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unsupported' }));
  });

  it('reports a refused start and stays idle', () => {
    const { hook, speech } = setup({}, { throwOnStart: true });

    act(() => hook.result.current.start());

    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.error?.code).toBe('start-failed');
    expect(speech.latest().onresult).toBeNull();
  });

  it('ignores events from a session that already ended', () => {
    const { hook, speech, onFinalTranscript } = setup();
    act(() => hook.result.current.start());
    const first = speech.latest();
    act(() => first.emitError('network'));

    act(() => hook.result.current.start());
    act(() => first.emitFinal('late result'));

    expect(onFinalTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.isListening).toBe(true);
  });

  it('aborts a running session on unmount', () => {
    const { hook, speech, onFinalTranscript } = setup();
    act(() => hook.result.current.start());
    const recognition = speech.latest();

    hook.unmount();

    expect(recognition.abortCalls).toBe(1);
    expect(recognition.onresult).toBeNull();
    recognition.emitFinal('after unmount');
    expect(onFinalTranscript).not.toHaveBeenCalled();
  });

  it('clearError() forgets the last failure', () => {
    const { hook, speech } = setup();
    act(() => hook.result.current.start());
    act(() => speech.latest().emitError('no-speech'));
    expect(hook.result.current.error).not.toBeNull();

    act(() => hook.result.current.clearError());

    expect(hook.result.current.error).toBeNull();
  });
});
