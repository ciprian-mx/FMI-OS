import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WindowPanel, { WindowPanelProps } from './WindowPanel';

/**
 * Render helper with sensible controlled defaults, so each test overrides only
 * the props it cares about. WindowPanel is controlled, so geometry props stay
 * fixed unless a test feeds back a new value.
 */
const renderPanel = (overrides: Partial<WindowPanelProps> = {}) => {
  const props: WindowPanelProps = {
    title: 'Materials',
    appId: 'materials',
    position: { x: 100, y: 80 },
    size: { width: 400, height: 300 },
    zIndex: 1,
    isFocused: false,
    children: <div data-testid="app-content">app content</div>,
    ...overrides,
  };
  const utils = render(<WindowPanel {...props} />);
  return { props, ...utils };
};

describe('WindowPanel', () => {
  it('renders the title and the hosted app content', () => {
    renderPanel();

    expect(screen.getByRole('dialog', { name: 'Materials' })).toBeInTheDocument();
    expect(screen.getByTestId('window-panel-titlebar')).toHaveTextContent('Materials');
    expect(screen.getByTestId('app-content')).toHaveTextContent('app content');
  });

  it('positions and sizes itself from the controlled props', () => {
    renderPanel({ position: { x: 120, y: 64 }, size: { width: 500, height: 360 }, zIndex: 7 });

    const panel = screen.getByTestId('window-panel-materials');
    expect(panel).toHaveStyle({ left: '120px', top: '64px' });
    expect(panel).toHaveStyle({ width: '500px', height: '360px' });
    expect(panel).toHaveStyle({ zIndex: '7' });
  });

  it('marks the focused window via class and data attribute', () => {
    const { rerender } = renderPanel({ isFocused: false });
    const panel = screen.getByTestId('window-panel-materials');
    expect(panel).toHaveAttribute('data-focused', 'false');
    expect(panel.className).not.toContain('window-panel--focused');

    rerender(
      <WindowPanel
        title="Materials"
        appId="materials"
        position={{ x: 100, y: 80 }}
        size={{ width: 400, height: 300 }}
        zIndex={1}
        isFocused
      >
        <div>content</div>
      </WindowPanel>
    );
    expect(screen.getByTestId('window-panel-materials')).toHaveAttribute('data-focused', 'true');
    expect(screen.getByTestId('window-panel-materials').className).toContain(
      'window-panel--focused'
    );
  });

  it('fires onClose when the close control is activated', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderPanel({ onClose });

    await user.click(screen.getByTestId('window-panel-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onFocus when the title bar is pressed', () => {
    const onFocus = jest.fn();
    renderPanel({ onFocus });

    fireEvent.mouseDown(screen.getByTestId('window-panel-titlebar'), { clientX: 110, clientY: 90 });

    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('fires onFocus when the window body is clicked (raise background window)', () => {
    const onFocus = jest.fn();
    renderPanel({ onFocus });

    fireEvent.mouseDown(screen.getByTestId('app-content'));

    expect(onFocus).toHaveBeenCalled();
  });

  it('reports a new position via onMove when the title bar is dragged', () => {
    const onMove = jest.fn();
    // Window origin at (100, 80). Grab at (120, 100) → offset (20, 20).
    renderPanel({ position: { x: 100, y: 80 }, onMove, dragBounds: { width: 2000, height: 2000 } });

    const titlebar = screen.getByTestId('window-panel-titlebar');
    fireEvent.mouseDown(titlebar, { clientX: 120, clientY: 100 });
    // Move the pointer by (+60, +40) to (180, 140); origin should follow to
    // (180 - 20, 140 - 20) = (160, 120).
    fireEvent.mouseMove(document, { clientX: 180, clientY: 140 });

    expect(onMove).toHaveBeenCalled();
    expect(onMove).toHaveBeenLastCalledWith({ x: 160, y: 120 });
  });

  it('does not report movement before a drag has started', () => {
    const onMove = jest.fn();
    renderPanel({ onMove });

    // A bare pointer move with no preceding title-bar press must be ignored.
    fireEvent.mouseMove(document, { clientX: 400, clientY: 400 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('also invokes the onDrag alias with the same position', () => {
    const onDrag = jest.fn();
    renderPanel({ position: { x: 100, y: 80 }, onDrag, dragBounds: { width: 2000, height: 2000 } });

    fireEvent.mouseDown(screen.getByTestId('window-panel-titlebar'), { clientX: 100, clientY: 80 });
    fireEvent.mouseMove(document, { clientX: 150, clientY: 110 });

    expect(onDrag).toHaveBeenLastCalledWith({ x: 150, y: 110 });
  });

  it('stops reporting movement after the drag ends', () => {
    const onMove = jest.fn();
    renderPanel({ position: { x: 100, y: 80 }, onMove, dragBounds: { width: 2000, height: 2000 } });

    const titlebar = screen.getByTestId('window-panel-titlebar');
    fireEvent.mouseDown(titlebar, { clientX: 100, clientY: 80 });
    fireEvent.mouseMove(document, { clientX: 150, clientY: 120 });
    fireEvent.mouseUp(document, { clientX: 150, clientY: 120 });

    onMove.mockClear();
    fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('clamps the dragged position so the window stays reachable on screen', () => {
    const onMove = jest.fn();
    renderPanel({ position: { x: 100, y: 80 }, onMove, dragBounds: { width: 800, height: 600 } });

    fireEvent.mouseDown(screen.getByTestId('window-panel-titlebar'), { clientX: 100, clientY: 80 });
    // Drag far past the bottom-right beyond the bounds; it must clamp.
    fireEvent.mouseMove(document, { clientX: 5000, clientY: 5000 });

    const last = onMove.mock.calls.at(-1)?.[0];
    expect(last.x).toBeLessThanOrEqual(800);
    expect(last.y).toBeLessThanOrEqual(600);
    // Never off the top-left either.
    expect(last.x).toBeGreaterThanOrEqual(0);
    expect(last.y).toBeGreaterThanOrEqual(0);
  });

  it('does not fire onClose when dragging the title bar', () => {
    const onClose = jest.fn();
    renderPanel({ onClose });

    const titlebar = screen.getByTestId('window-panel-titlebar');
    fireEvent.mouseDown(titlebar, { clientX: 110, clientY: 90 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 140 });
    fireEvent.mouseUp(document, { clientX: 160, clientY: 140 });

    expect(onClose).not.toHaveBeenCalled();
  });
});
