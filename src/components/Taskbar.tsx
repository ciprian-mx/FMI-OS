import React, { useCallback, useState } from 'react';
import './Taskbar.css';

/**
 * Props for the {@link Taskbar} component.
 *
 * These mirror the Taskbar interface in the design doc. The Taskbar is a pure
 * shell: it owns layout, the three controls, and the "Ask Gus" input text; it
 * does NOT own any of the behaviour behind the controls. Each control simply
 * invokes a callback so later tasks can wire real behaviour:
 *   - Voice capture / Web Speech API      → task 3.3 (VoiceCommandHandler)
 *   - Account Center panel                → task 3.5 (AccountCenter)
 *   - Gus chat panel + session generation → tasks 11.3 / 16.3
 *
 * Requirement 4.2 fixes the three controls: a "Start today's session" button,
 * an "Ask Gus" text input with an adjacent microphone icon, and an Account
 * Center button styled as a Start Menu control.
 */
export interface TaskbarProps {
  /**
   * Invoked when the student activates "Start today's session" (Requirement
   * 4.3). The learning-session generation itself is a separate task; this is
   * the extension point for it.
   */
  onStartSession?: () => void;
  /**
   * Invoked with the current "Ask Gus" text when the student submits the query
   * (presses Enter or clicks send) (Requirement 4.4). The Gus chat panel is a
   * separate task; this is the extension point for it.
   */
  onGusQuery?: (query: string) => void;
  /**
   * Invoked when the student clicks the microphone icon to start voice input
   * (Requirement 5.1). The Web Speech API integration is task 3.3; this only
   * signals intent to activate voice.
   */
  onVoiceActivate?: () => void;
  /**
   * Invoked when the student clicks the Account Center button (Requirement
   * 4.5). The Account Center panel is task 3.5; this only signals that it
   * should open.
   */
  onAccountCenterOpen?: () => void;
  /**
   * Whether voice input is supported in the current browser (Requirement 5.4).
   * When false the microphone icon is disabled with an explanatory tooltip and
   * `onVoiceActivate` is never fired. Defaults to true.
   */
  isVoiceSupported?: boolean;
  /**
   * Whether the microphone is actively listening (Requirement 5.5). Owned by
   * the VoiceCommandHandler task; the Taskbar only reflects it as visual state
   * on the mic icon. Defaults to false.
   */
  isListening?: boolean;
}

/**
 * Taskbar renders the persistent bottom bar of the Desktop Environment
 * (Requirement 4.1). It is designed to mount into DesktopEnvironment's
 * `taskbarSlot`, which fixes it to the bottom of the viewport so it stays
 * visible at all times while the student is authenticated.
 *
 * It renders exactly the three controls Requirement 4.2 specifies:
 *   1. "Start today's session" button
 *   2. "Ask Gus" text input with an adjacent microphone icon
 *   3. Account Center button (Start Menu–style)
 *
 * Deliberately out of scope (separate tasks): the Web Speech API voice capture
 * (3.3), the Account Center panel (3.5), and the Gus chat panel / session
 * generation (11.3, 16.3). Each control is wired only to a callback prop so
 * those tasks have clean extension points.
 */
const Taskbar: React.FC<TaskbarProps> = ({
  onStartSession,
  onGusQuery,
  onVoiceActivate,
  onAccountCenterOpen,
  isVoiceSupported = true,
  isListening = false,
}) => {
  // The Taskbar owns only the draft text of the "Ask Gus" input. The query is
  // handed off to onGusQuery on submit; the response/chat UI lives elsewhere.
  const [gusQuery, setGusQuery] = useState('');

  const submitGusQuery = useCallback(() => {
    const trimmed = gusQuery.trim();
    if (!trimmed) {
      return;
    }
    onGusQuery?.(trimmed);
    setGusQuery('');
  }, [gusQuery, onGusQuery]);

  // Requirement 4.4: submitting the "Ask Gus" input happens on Enter.
  const handleGusKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitGusQuery();
      }
    },
    [submitGusQuery]
  );

  const handleVoiceClick = useCallback(() => {
    // Requirement 5.4: when voice is unsupported the mic is inert.
    if (!isVoiceSupported) {
      return;
    }
    onVoiceActivate?.();
  }, [isVoiceSupported, onVoiceActivate]);

  return (
    <div
      className="taskbar"
      data-testid="taskbar"
      role="toolbar"
      aria-label="FMI OS taskbar"
    >
      {/* Control 1: "Start today's session" button (Requirement 4.3). */}
      <button
        type="button"
        className="taskbar__start-session"
        data-testid="taskbar-start-session"
        aria-label="Start today's session"
        onClick={() => onStartSession?.()}
      >
        Start today&apos;s session
      </button>

      {/* Control 2: "Ask Gus" input with an adjacent microphone icon. */}
      <div className="taskbar__ask-gus" data-testid="taskbar-ask-gus">
        <input
          type="text"
          className="taskbar__ask-gus-input"
          data-testid="taskbar-ask-gus-input"
          aria-label="Ask Gus"
          placeholder="Ask Gus…"
          value={gusQuery}
          onChange={(event) => setGusQuery(event.target.value)}
          onKeyDown={handleGusKeyDown}
        />
        <button
          type="button"
          className="taskbar__mic"
          data-testid="taskbar-mic"
          aria-label={
            isVoiceSupported
              ? 'Start voice input'
              : 'Voice commands are not supported in this browser'
          }
          aria-pressed={isListening}
          data-listening={isListening}
          disabled={!isVoiceSupported}
          title={
            isVoiceSupported
              ? undefined
              : 'Voice commands are not supported in this browser'
          }
          onClick={handleVoiceClick}
        >
          <span aria-hidden="true">🎤</span>
        </button>
      </div>

      {/* Control 3: Account Center button, Start Menu–style (Requirement 4.5). */}
      <button
        type="button"
        className="taskbar__account-center"
        data-testid="taskbar-account-center"
        aria-label="Open Account Center"
        onClick={() => onAccountCenterOpen?.()}
      >
        <span aria-hidden="true">👤</span>
      </button>
    </div>
  );
};

export default Taskbar;
