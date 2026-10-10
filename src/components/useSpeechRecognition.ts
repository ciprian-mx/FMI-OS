/**
 * useSpeechRecognition (task 3.3, Requirements 5.1, 5.2, 5.4, 5.5).
 *
 * A React binding over the browser's Web Speech API: `SpeechRecognition`, or
 * the `webkitSpeechRecognition` that Chrome, Edge and Safari ship. Each
 * `start()` runs one single-utterance listening session, and the hook reports:
 *
 *   - `isSupported`: whether the API is available (Requirement 5.4), so the
 *     microphone can be disabled up front instead of failing on click;
 *   - `isListening`: from a successful `start()` until the session ends
 *     (Requirement 5.5, drives the animated mic icon);
 *   - each final transcript through `onFinalTranscript`, exactly as the
 *     recognizer produced it (Requirement 5.2). Interim guesses are only
 *     exposed as `interimTranscript`; they are never delivered;
 *   - failures (no speech, microphone blocked, ...) as `error` and `onError`.
 *
 * The constructor lookup is injectable (`getRecognitionConstructor`): jsdom has
 * no Web Speech API, so tests supply a fake recognizer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Web Speech API surface
// ---------------------------------------------------------------------------
// TypeScript's DOM lib does not declare SpeechRecognition (browsers ship it
// prefixed), so these structural types cover the part this app uses. Real
// recognizers satisfy them, and so does the test fake.

/** One recognition hypothesis. */
export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

/** One recognized segment: its hypotheses, best first, and whether it is final. */
export interface SpeechRecognitionResultLike extends ArrayLike<SpeechRecognitionAlternativeLike> {
  readonly isFinal: boolean;
}

/**
 * A `result` (or `nomatch`) event: every segment of the session so far, the
 * first one that changed in this event at `resultIndex`.
 */
export interface SpeechRecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

/** An `error` event; `error` is the Web Speech API error code. */
export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

/** A recognizer: its settings, event handlers and session controls. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onnomatch: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

/** Where a browser exposes the recognizer constructor. */
export interface SpeechRecognitionHost {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
}

/**
 * The browser's recognizer constructor: `SpeechRecognition`, else
 * `webkitSpeechRecognition`, else undefined when the Web Speech API is
 * unavailable (as in jsdom, Firefox by default, or older browsers).
 */
export function getSpeechRecognitionConstructor(
  host: SpeechRecognitionHost | undefined = typeof window === 'undefined'
    ? undefined
    : (window as unknown as SpeechRecognitionHost)
): SpeechRecognitionConstructorLike | undefined {
  const candidate = [host?.SpeechRecognition, host?.webkitSpeechRecognition].find(
    (value) => typeof value === 'function'
  );
  return candidate as SpeechRecognitionConstructorLike | undefined;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Why a listening session failed, and what to tell the student. */
export interface SpeechRecognitionFailure {
  /**
   * A Web Speech API error code ("no-speech", "not-allowed", "audio-capture",
   * "network", ...), or one of this hook's own: "no-match" (speech was heard
   * but not recognized), "unsupported" (no usable recognizer) and
   * "start-failed" (the browser refused to start listening).
   */
  code: string;
  /** Student-facing explanation, for a status line or toast. */
  message: string;
}

/** The design's message for a recognition failure. */
const GENERIC_FAILURE_MESSAGE = 'Voice recognition failed. Please try typing instead.';
const BLOCKED_MESSAGE =
  'Microphone access is blocked. Allow it in your browser to use voice commands.';

const FAILURE_MESSAGES = new Map<string, string>([
  ['no-speech', 'No speech was detected. Try again, or type your question.'],
  ['no-match', "Sorry, that wasn't recognized. Try again, or type your question."],
  ['audio-capture', 'No microphone was found. Check your microphone, or type your question.'],
  ['not-allowed', BLOCKED_MESSAGE],
  ['service-not-allowed', BLOCKED_MESSAGE],
  ['network', 'Voice recognition needs a network connection. Please try typing instead.'],
  ['unsupported', 'Voice commands are not supported in this browser.'],
]);

/** The student-facing message for a failure code; generic for unknown codes. */
export function describeSpeechRecognitionError(code: string): string {
  return FAILURE_MESSAGES.get(code) ?? GENERIC_FAILURE_MESSAGE;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Recognition language when none is given: the app's UI and commands are English. */
export const DEFAULT_SPEECH_LANG = 'en-US';

export interface UseSpeechRecognitionOptions {
  /**
   * Called with each final transcript exactly as the recognizer produced it:
   * no trimming, casing or punctuation changes. An empty final transcript is
   * reported as a "no-match" failure instead, since nothing was recognized.
   */
  onFinalTranscript?: (transcript: string) => void;
  /** Called when a listening session fails. A cancelled ("aborted") session is not a failure. */
  onError?: (failure: SpeechRecognitionFailure) => void;
  /** BCP 47 language to recognize. Defaults to {@link DEFAULT_SPEECH_LANG}. */
  lang?: string;
  /**
   * Looks up the recognizer constructor; returning undefined means the Web
   * Speech API is unavailable. Defaults to {@link getSpeechRecognitionConstructor}.
   * Injectable so tests can supply a fake.
   */
  getRecognitionConstructor?: () => SpeechRecognitionConstructorLike | undefined;
}

export interface UseSpeechRecognitionResult {
  /** Whether a usable recognizer is available (Requirement 5.4). */
  isSupported: boolean;
  /** True from a successful `start()` until the session ends (Requirement 5.5). */
  isListening: boolean;
  /** The recognizer's current non-final guess while listening; '' otherwise. */
  interimTranscript: string;
  /** Why the last session failed, until the next `start()` or `clearError()`. */
  error: SpeechRecognitionFailure | null;
  /** Starts a listening session. Does nothing while one is running. */
  start: () => void;
  /** Asks the running session to stop; what was already heard is still delivered. */
  stop: () => void;
  /** `start()` when idle, `stop()` while listening: what a mic toggle does. */
  toggle: () => void;
  /** Forgets the last failure. */
  clearError: () => void;
}

/** Stops a recognizer from calling back into the hook. */
function detach(recognition: SpeechRecognitionLike): void {
  recognition.onresult = null;
  recognition.onnomatch = null;
  recognition.onerror = null;
  recognition.onend = null;
}

/** A new recognizer, or null when constructing one throws. */
function construct(Recognition: SpeechRecognitionConstructorLike): SpeechRecognitionLike | null {
  try {
    return new Recognition();
  } catch {
    return null;
  }
}

/**
 * The text that became final in a result event (null when none did) and the
 * recognizer's current interim guess. Final segments before `resultIndex` were
 * delivered by an earlier event. Transcripts are concatenated as given: never
 * trimmed, re-spaced or otherwise changed.
 */
function readResults(event: SpeechRecognitionResultEventLike): {
  finalTranscript: string | null;
  interimTranscript: string;
} {
  const { results } = event;
  const firstChanged = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
  let finalTranscript: string | null = null;
  let interimTranscript = '';
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const transcript = result.length > 0 ? result[0].transcript : '';
    if (!result.isFinal) {
      interimTranscript += transcript;
    } else if (index >= firstChanged) {
      finalTranscript = (finalTranscript ?? '') + transcript;
    }
  }
  return { finalTranscript, interimTranscript };
}

/**
 * Listens for one spoken utterance per `start()` through the Web Speech API.
 *
 * ```tsx
 * const speech = useSpeechRecognition({ onFinalTranscript: setDraft });
 * <button disabled={!speech.isSupported} aria-pressed={speech.isListening}
 *   onClick={speech.toggle}>🎤</button>
 * ```
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {}
): UseSpeechRecognitionResult {
  const {
    onFinalTranscript,
    onError,
    lang = DEFAULT_SPEECH_LANG,
    getRecognitionConstructor = getSpeechRecognitionConstructor,
  } = options;

  // Latest options, read by start() and by the recognizer's event handlers,
  // which are bound once per session.
  const optionsRef = useRef({ onFinalTranscript, onError, lang, getRecognitionConstructor });
  optionsRef.current = { onFinalTranscript, onError, lang, getRecognitionConstructor };

  /** The recognizer running the current session; null when idle. */
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<SpeechRecognitionFailure | null>(null);
  // Set when constructing a recognizer threw: the API exists but is unusable.
  const [isBroken, setIsBroken] = useState(false);

  const isSupported = !isBroken && getRecognitionConstructor() !== undefined;

  const fail = useCallback((code: string) => {
    const failure: SpeechRecognitionFailure = {
      code,
      message: describeSpeechRecognitionError(code),
    };
    setError(failure);
    optionsRef.current.onError?.(failure);
  }, []);

  /**
   * Ends the session if `recognition` is still running it. Returns false for a
   * recognizer whose session already ended, so its late events are ignored.
   */
  const endSession = useCallback((recognition: SpeechRecognitionLike): boolean => {
    if (recognitionRef.current !== recognition) {
      return false;
    }
    recognitionRef.current = null;
    detach(recognition);
    setIsListening(false);
    setInterimTranscript('');
    return true;
  }, []);

  const start = useCallback(() => {
    if (recognitionRef.current) {
      return;
    }
    const Recognition = optionsRef.current.getRecognitionConstructor();
    if (!Recognition) {
      fail('unsupported');
      return;
    }
    const recognition = construct(Recognition);
    if (!recognition) {
      setIsBroken(true);
      fail('unsupported');
      return;
    }

    // One utterance per activation, with interim guesses for live feedback.
    recognition.lang = optionsRef.current.lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      const { finalTranscript, interimTranscript: interim } = readResults(event);
      setInterimTranscript(interim);
      if (finalTranscript === null) {
        return;
      }
      if (finalTranscript === '') {
        fail('no-match');
        return;
      }
      optionsRef.current.onFinalTranscript?.(finalTranscript);
    };
    recognition.onnomatch = () => {
      if (recognitionRef.current === recognition) {
        fail('no-match');
      }
    };
    // An error ends the session (the browser follows it with `end`). "aborted"
    // is a cancel, e.g. the browser handing the microphone to another
    // recognizer, so it is not reported as a failure.
    recognition.onerror = (event) => {
      if (endSession(recognition) && event.error !== 'aborted') {
        fail(event.error);
      }
    };
    recognition.onend = () => {
      endSession(recognition);
    };

    recognitionRef.current = recognition;
    setError(null);
    setInterimTranscript('');
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      detach(recognition);
      fail('start-failed');
      return;
    }
    // Unless the session already ended inside start().
    if (recognitionRef.current === recognition) {
      setIsListening(true);
    }
  }, [endSession, fail]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) {
      stop();
    } else {
      start();
    }
  }, [start, stop]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // On unmount, silence and abort a running session so no transcript or state
  // update arrives after the component is gone.
  const abortSession = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }
    recognitionRef.current = null;
    detach(recognition);
    recognition.abort();
  }, []);
  useEffect(() => abortSession, [abortSession]);

  return {
    isSupported,
    isListening,
    interimTranscript,
    error,
    start,
    stop,
    toggle,
    clearError,
  };
}

export default useSpeechRecognition;
