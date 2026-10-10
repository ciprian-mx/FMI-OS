import React, { useCallback } from 'react';
import {
  type SpeechRecognitionConstructorLike,
  type SpeechRecognitionFailure,
  useSpeechRecognition,
} from './useSpeechRecognition';

/**
 * VoiceCommandHandler (task 3.3, Requirements 5.1-5.5).
 *
 * Turns the microphone into voice commands. Activating it (the Taskbar mic
 * click) starts the Web Speech API listening (5.1); the final transcription is
 * then routed:
 *   - the spoken command "Start today's session" calls `onSessionStart`, as if
 *     the student had clicked that button (5.3);
 *   - anything else goes to `onTranscript` verbatim, to populate the "Ask Gus"
 *     input (5.2).
 *
 * It renders nothing itself. Its render prop receives the voice state the mic
 * needs: `isListening` for the animated icon (5.5), `isSupported` to disable it
 * with a tooltip when the API is unavailable (5.4), and `activate` for its
 * click. VoiceTaskbar wires all of this into the Taskbar.
 *
 * The design sketches `isListening` and `isSupported` as props; they are
 * derived from the browser at runtime, so the handler owns them and passes
 * them down instead.
 */

/** The spoken command that starts the day's learning session (Requirement 5.3). */
export const SESSION_START_PHRASE = "Start today's session";

/**
 * Spoken forms of the session-start command: the phrase itself, plus the
 * shorter "Start session" the design's voice sketch also accepts.
 */
export const SESSION_START_PHRASES: readonly string[] = [SESSION_START_PHRASE, 'Start session'];

/**
 * A transcript reduced to the words it says, for comparing commands only:
 * lowercase, apostrophes dropped ("today's" and "today’s" become "todays"),
 * and any other run of punctuation or spacing turned into a single space. This
 * never feeds the "Ask Gus" input, which receives transcripts unchanged.
 */
export function normalizeVoicePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2018\u2019\u02BC\u0060\u00B4]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

const NORMALIZED_SESSION_START_PHRASES = new Set(SESSION_START_PHRASES.map(normalizeVoicePhrase));

/**
 * Whether a transcript is the session-start command. The whole utterance must
 * be the command (ignoring case, punctuation and apostrophes), so a question
 * that merely mentions it, like "How long is today's session?", still goes to
 * Gus.
 */
export function isSessionStartPhrase(transcript: string): boolean {
  return NORMALIZED_SESSION_START_PHRASES.has(normalizeVoicePhrase(transcript));
}

/** What the render prop receives. */
export interface VoiceCommandState {
  /** Whether the Web Speech API is available; disable the mic when false (5.4). */
  isSupported: boolean;
  /** Whether the microphone is listening; animate the mic while true (5.5). */
  isListening: boolean;
  /** The recognizer's current non-final guess while listening; '' otherwise. */
  interimTranscript: string;
  /** Why the last voice command failed, until the next activation. */
  error: SpeechRecognitionFailure | null;
  /** The mic click: start listening, or stop if already listening (5.1). */
  activate: () => void;
  /** Stop listening; what was already heard is still delivered. */
  stop: () => void;
  /** Forget the last failure, e.g. once the student starts typing. */
  clearError: () => void;
}

export interface VoiceCommandHandlerProps {
  /** Receives each spoken non-command transcription, exactly as recognized (5.2). */
  onTranscript: (text: string) => void;
  /** Called when the student says "Start today's session" (5.3). */
  onSessionStart: () => void;
  /** Called when a voice command fails (no speech, microphone blocked, ...). */
  onError?: (failure: SpeechRecognitionFailure) => void;
  /** Recognition language. Defaults to "en-US". */
  lang?: string;
  /**
   * Looks up the SpeechRecognition constructor. Defaults to
   * `window.SpeechRecognition || window.webkitSpeechRecognition`; tests inject
   * a fake. Returning undefined means the API is unavailable.
   */
  getRecognitionConstructor?: () => SpeechRecognitionConstructorLike | undefined;
  /** Renders the mic (and anything else) from the current voice state. */
  children: (voice: VoiceCommandState) => React.ReactNode;
}

const VoiceCommandHandler: React.FC<VoiceCommandHandlerProps> = ({
  onTranscript,
  onSessionStart,
  onError,
  lang,
  getRecognitionConstructor,
  children,
}) => {
  const routeTranscript = useCallback(
    (transcript: string) => {
      if (isSessionStartPhrase(transcript)) {
        onSessionStart();
      } else {
        onTranscript(transcript);
      }
    },
    [onSessionStart, onTranscript]
  );

  const { isSupported, isListening, interimTranscript, error, toggle, stop, clearError } =
    useSpeechRecognition({
      onFinalTranscript: routeTranscript,
      onError,
      lang,
      getRecognitionConstructor,
    });

  return (
    <>
      {children({
        isSupported,
        isListening,
        interimTranscript,
        error,
        activate: toggle,
        stop,
        clearError,
      })}
    </>
  );
};

export default VoiceCommandHandler;
