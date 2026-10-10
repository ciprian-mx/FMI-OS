import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BootAnimation from './BootAnimation';

/**
 * Mock lottie-react so the test exercises BootAnimation's own logic (skip
 * handling, one-shot completion) without booting the real lottie-web rendering
 * engine, which does not run meaningfully under jsdom. The mock exposes a
 * button that fires the component's `onComplete` prop, standing in for the
 * animation reaching its final frame.
 */
jest.mock('lottie-react', () => ({
  __esModule: true,
  default: ({ onComplete }: { onComplete?: () => void }) => (
    <button type="button" data-testid="lottie-complete" onClick={() => onComplete?.()}>
      lottie
    </button>
  ),
}));

describe('BootAnimation', () => {
  it('renders the boot overlay with a skip control', () => {
    render(<BootAnimation />);
    expect(screen.getByTestId('boot-animation')).toBeInTheDocument();
    expect(screen.getByTestId('boot-animation-skip')).toBeInTheDocument();
  });

  it('calls onComplete (not onSkip) when the animation finishes on its own', () => {
    const onComplete = jest.fn();
    const onSkip = jest.fn();
    render(<BootAnimation onComplete={onComplete} onSkip={onSkip} />);

    // Simulate the Lottie animation reaching its final frame.
    screen.getByTestId('lottie-complete').click();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('calls onSkip then onComplete when the skip button is clicked', async () => {
    const user = userEvent.setup();
    const onComplete = jest.fn();
    const onSkip = jest.fn();
    render(<BootAnimation onComplete={onComplete} onSkip={onSkip} />);

    await user.click(screen.getByTestId('boot-animation-skip'));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('skips when any key is pressed', async () => {
    const user = userEvent.setup();
    const onComplete = jest.fn();
    render(<BootAnimation onComplete={onComplete} />);

    await user.keyboard('{Enter}');

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('skips when the overlay is clicked', async () => {
    const user = userEvent.setup();
    const onComplete = jest.fn();
    render(<BootAnimation onComplete={onComplete} />);

    await user.click(screen.getByTestId('boot-animation'));

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('signals completion at most once even across multiple triggers', async () => {
    const user = userEvent.setup();
    const onComplete = jest.fn();
    const onSkip = jest.fn();
    render(<BootAnimation onComplete={onComplete} onSkip={onSkip} />);

    // Skip, then try to trigger completion and skip again.
    await user.click(screen.getByTestId('boot-animation-skip'));
    screen.getByTestId('lottie-complete').click();
    await user.keyboard('{a}');

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
