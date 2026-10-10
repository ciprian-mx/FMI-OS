import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import fc from 'fast-check';
import BootAnimation from './BootAnimation';

/**
 * Feature: fmi-os
 * Property 3: Boot Animation Skippability
 * Validates: Requirements 2.3
 *
 * No matter what sequence of user interactions (skip button click, overlay
 * click, key press) or natural animation completion a student produces, the
 * Boot Animation reliably signals completion exactly once and a skip
 * affordance is always reachable before the first terminating interaction.
 *
 * Mirrors the mock from BootAnimation.test.tsx: lottie-react is replaced with a
 * button that fires BootAnimation's `onComplete` prop, standing in for the
 * animation reaching its final frame — the real lottie-web engine does not run
 * meaningfully under jsdom.
 */
jest.mock('lottie-react', () => ({
  __esModule: true,
  default: ({ onComplete }: { onComplete?: () => void }) => (
    <button type="button" data-testid="lottie-complete" onClick={() => onComplete?.()}>
      lottie
    </button>
  ),
}));

/** The distinct ways a student (or the animation itself) can terminate the boot sequence. */
type Interaction = 'skip-button' | 'overlay-click' | 'keypress' | 'lottie-complete';

const interactionArb: fc.Arbitrary<Interaction> = fc.constantFrom(
  'skip-button',
  'overlay-click',
  'keypress',
  'lottie-complete'
);

/** Dispatch a single interaction against the currently rendered BootAnimation. */
function dispatch(interaction: Interaction): void {
  switch (interaction) {
    case 'skip-button':
      fireEvent.click(screen.getByTestId('boot-animation-skip'));
      break;
    case 'overlay-click':
      fireEvent.click(screen.getByTestId('boot-animation'));
      break;
    case 'keypress':
      fireEvent.keyDown(document, { key: 'a' });
      break;
    case 'lottie-complete':
      fireEvent.click(screen.getByTestId('lottie-complete'));
      break;
  }
}

describe('BootAnimation — Property 3: Boot Animation Skippability', () => {
  afterEach(() => {
    cleanup();
  });

  it('always signals completion exactly once regardless of the interaction sequence', () => {
    fc.assert(
      fc.property(
        // At least one terminating trigger; arbitrary order and length.
        fc.array(interactionArb, { minLength: 1, maxLength: 12 }),
        (interactions) => {
          const onComplete = jest.fn();
          const onSkip = jest.fn();

          render(<BootAnimation onComplete={onComplete} onSkip={onSkip} />);

          try {
            // A skip affordance is always reachable before any interaction.
            expect(screen.getByTestId('boot-animation-skip')).toBeInTheDocument();
            expect(screen.getByTestId('boot-animation')).toBeInTheDocument();

            interactions.forEach(dispatch);

            // Skippability contract: completion fires exactly once, never more,
            // no matter the sequence/timing of interactions.
            expect(onComplete).toHaveBeenCalledTimes(1);

            // Completion is latched by the FIRST trigger. An explicit skip
            // (button/overlay/key) fires onSkip exactly once before onComplete;
            // a natural completion fires it zero times. Later triggers are no-ops.
            if (interactions[0] === 'lottie-complete') {
              expect(onSkip).toHaveBeenCalledTimes(0);
            } else {
              expect(onSkip).toHaveBeenCalledTimes(1);
            }
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  it('always exposes a reachable skip affordance on initial render', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const onComplete = jest.fn();
        render(<BootAnimation onComplete={onComplete} />);
        try {
          const skip = screen.getByTestId('boot-animation-skip');
          expect(skip).toBeInTheDocument();
          expect(skip).toBeEnabled();
          // Overlay itself is clickable as an alternative skip affordance.
          expect(screen.getByTestId('boot-animation')).toBeInTheDocument();
          expect(onComplete).not.toHaveBeenCalled();
        } finally {
          cleanup();
        }
      }),
      { numRuns: 150 }
    );
  });
});
