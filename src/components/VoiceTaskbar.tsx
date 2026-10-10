import React, { useCallback, useRef, useState } from 'react';
import Taskbar, { type TaskbarProps } from './Taskbar';
import VoiceCommandHandler from './VoiceCommandHandler';
import type {
  SpeechRecognitionConstructorLike,
  SpeechRecognitionFailure,
} from './useSpeechRecognition';
import './VoiceTaskbar.css';

/** "Ask Gus" placeholder while listening, until the first words are heard. */
export const LISTENING_PLACEHOLDER = 'Listening… ask Gus, or say "Start today\'s session"';

export interface VoiceTaskbarProps
  extends Pick<TaskbarProps, 'onStartSession' | 'onGusQuery' | 'onAccountCenterOpen'> {
  /** Called when a voice command fails, e.g. to show a toast. */
  onVoiceError?: (failure: SpeechRecognitionFailure) => void;
  /** Recognition language. Defaults to "en-US". */
  voiceLang?: string;
  /**
   * Looks up the SpeechRecognition constructor. Defaults to the browser's
   * (`SpeechRecognition` or `webkitSpeechRecognition`); tests inject a fake.
   */
  getRecognitionConstructor?: () => SpeechRecognitionConstructorLike | undefined;
}

/**
 * The Taskbar with voice commands wired in (task 3.3, Requirements 5.1-5.5).
 * This is the Taskbar to mount in the desktop's `taskbarSlot`.
 *
 *   - Clicking the mic starts listening; clicking it again stops (5.1).
 *   - A spoken question replaces the "Ask Gus" text with the exact
 *     transcription, and focus moves to the input so Enter sends it (5.2).
 *     Nothing is sent automatically: the student reviews it first.
 *   - Saying "Start today's session" calls `onStartSession`, like the button
 *     (5.3), and leaves the input alone.
 *   - Without the Web Speech API the mic is disabled with a "not supported"
 *     tooltip; typing still works (5.4).
 *   - While listening the mic pulses and the input's placeholder prompts for
 *     speech, then shows the words as they are recognized (5.5).
 *   - A failure is shown as the placeholder and announced to screen readers.
 */
const VoiceTaskbar: React.FC<VoiceTaskbarProps> = ({
  onStartSession,
  onGusQuery,
  onAccountCenterOpen,
  onVoiceError,
  voiceLang,
  getRecognitionConstructor,
}) => {
  // The "Ask Gus" text lives here, not in the Taskbar, so a transcription can
  // be put into it.
  const [gusQuery, setGusQuery] = useState('');
  const gusInputRef = useRef<HTMLInputElement>(null);

  const handleTranscript = useCallback((transcript: string) => {
    // Verbatim: the Taskbar trims only when the query is submitted.
    setGusQuery(transcript);
    // Leave focus on the input, not the mic, so Enter sends the question
    // instead of listening again.
    gusInputRef.current?.focus();
  }, []);

  const handleSessionStart = useCallback(() => {
    onStartSession?.();
  }, [onStartSession]);

  return (
    <VoiceCommandHandler
      onTranscript={handleTranscript}
      onSessionStart={handleSessionStart}
      onError={onVoiceError}
      lang={voiceLang}
      getRecognitionConstructor={getRecognitionConstructor}
    >
      {({ isSupported, isListening, interimTranscript, error, activate, clearError }) => (
        <>
          <Taskbar
            onStartSession={onStartSession}
            onGusQuery={onGusQuery}
            onAccountCenterOpen={onAccountCenterOpen}
            gusQuery={gusQuery}
            onGusQueryChange={(value) => {
              setGusQuery(value);
              // A failure message is stale once the student moves on.
              clearError();
            }}
            gusInputRef={gusInputRef}
            gusPlaceholder={
              isListening ? interimTranscript || LISTENING_PLACEHOLDER : error?.message
            }
            onVoiceActivate={activate}
            isVoiceSupported={isSupported}
            isListening={isListening}
          />
          {/*
           * Failures only: announcing "listening" here would be read aloud
           * while the microphone is open, and could be transcribed.
           */}
          <p className="voice-taskbar__status" role="status" data-testid="voice-taskbar-status">
            {error?.message ?? ''}
          </p>
        </>
      )}
    </VoiceCommandHandler>
  );
};

export default VoiceTaskbar;
