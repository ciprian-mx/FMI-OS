import React, { useCallback, useEffect, useRef } from 'react';
import Lottie from 'lottie-react';
import bootAnimationData from './bootAnimationData';
import './BootAnimation.css';

/**
 * Props for the {@link BootAnimation} component.
 *
 * The boot sequence signals progress through two optional callbacks:
 * - `onComplete` fires once when the animation finishes playing OR when the
 *   student skips it. This is the signal the Desktop Environment waits on
 *   before rendering (Requirement 2.1).
 * - `onSkip` fires once, additionally, only when completion was triggered by an
 *   explicit skip interaction. It always fires before `onComplete` so callers
 *   can distinguish "played to the end" from "skipped".
 */
export interface BootAnimationProps {
  /** Invoked exactly once when the animation finishes or is skipped. */
  onComplete?: () => void;
  /** Invoked exactly once when the student explicitly skips the animation. */
  onSkip?: () => void;
}

/**
 * BootAnimation renders the FMI OS startup sequence as a Lottie animation.
 *
 * Requirement 2.1: after authentication, a startup sequence is shown before the
 * Desktop Environment renders. This component owns only that visual sequence and
 * the completion signal; the parent decides what to render next.
 *
 * The sequence is skippable (Requirement 2.3) via a visible "Skip" button, a key
 * press, or a click/tap anywhere on the overlay. Whether the student skips or
 * lets the animation play to the end, `onComplete` is guaranteed to fire exactly
 * once — this single-fire guarantee is what makes skippability reliably testable
 * by downstream tasks.
 */
const BootAnimation: React.FC<BootAnimationProps> = ({ onComplete, onSkip }) => {
  // Guards the one-shot completion contract: once we have signalled completion
  // (by finishing or skipping) every later trigger is ignored. Using a ref
  // keeps the guard synchronous and immune to re-render races.
  const hasCompletedRef = useRef(false);

  const finish = useCallback(
    (viaSkip: boolean) => {
      if (hasCompletedRef.current) {
        return;
      }
      hasCompletedRef.current = true;

      if (viaSkip) {
        onSkip?.();
      }
      onComplete?.();
    },
    [onComplete, onSkip]
  );

  const handleComplete = useCallback(() => finish(false), [finish]);
  const handleSkip = useCallback(() => finish(true), [finish]);

  // Any key press skips the sequence. Registered on the document so the student
  // does not need to focus a specific element first.
  useEffect(() => {
    const onKeyDown = () => handleSkip();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleSkip]);

  return (
    <div
      className="boot-animation"
      data-testid="boot-animation"
      role="dialog"
      aria-label="FMI OS starting up"
      // A click or tap anywhere on the overlay also skips.
      onClick={handleSkip}
    >
      <div className="boot-animation__stage">
        <Lottie
          animationData={bootAnimationData}
          loop={false}
          autoplay
          onComplete={handleComplete}
          aria-hidden="true"
        />
      </div>

      <button
        type="button"
        className="boot-animation__skip"
        data-testid="boot-animation-skip"
        // Stop the overlay click handler from double-firing; the button's own
        // handler already triggers the skip. (finish() is idempotent regardless.)
        onClick={(event) => {
          event.stopPropagation();
          handleSkip();
        }}
      >
        Skip
      </button>
    </div>
  );
};

export default BootAnimation;
