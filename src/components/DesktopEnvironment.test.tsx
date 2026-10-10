import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DesktopEnvironment, {
  DEFAULT_DESKTOP_APPS,
  DesktopAppId,
  WindowState,
} from './DesktopEnvironment';

describe('DesktopEnvironment', () => {
  it('renders the full-viewport desktop surface and taskbar slot', () => {
    render(<DesktopEnvironment />);
    expect(screen.getByTestId('desktop-environment')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-surface')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-taskbar-slot')).toBeInTheDocument();
  });

  it('renders exactly the six FMI OS app icons (Requirement 3.1)', () => {
    render(<DesktopEnvironment />);

    const expected: Array<[DesktopAppId, string]> = [
      ['materials', 'Materials'],
      ['examinations', 'Future Examinations'],
      ['calendar', 'Calendar'],
      ['timetable', 'Timetable'],
      ['stats', 'Stats'],
      ['roadmap', 'Roadmap'],
    ];

    expect(DEFAULT_DESKTOP_APPS).toHaveLength(6);
    for (const [id, name] of expected) {
      const icon = screen.getByTestId(`desktop-icon-${id}`);
      expect(icon).toBeInTheDocument();
      expect(within(icon).getByText(name)).toBeInTheDocument();
    }

    expect(screen.getAllByRole('listitem')).toHaveLength(6);
  });

  it('renders the Taskbar slot content when provided', () => {
    render(<DesktopEnvironment taskbarSlot={<div data-testid="my-taskbar">bar</div>} />);
    expect(screen.getByTestId('my-taskbar')).toBeInTheDocument();
  });

  it('opening an app adds a window to the open-window state', async () => {
    const user = userEvent.setup();
    const onWindowsChange = jest.fn<void, [WindowState[]]>();
    render(<DesktopEnvironment onWindowsChange={onWindowsChange} />);

    // No windows open initially.
    expect(screen.queryByTestId('window-materials')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('desktop-icon-materials'));

    expect(screen.getByTestId('window-materials')).toBeInTheDocument();
    const latest = onWindowsChange.mock.calls.at(-1)?.[0] ?? [];
    expect(latest.map((w) => w.appId)).toEqual(['materials']);
    expect(latest[0].isOpen).toBe(true);
    expect(latest[0].isFocused).toBe(true);
  });

  it('supports multiple simultaneously open windows', async () => {
    const user = userEvent.setup();
    render(<DesktopEnvironment />);

    await user.click(screen.getByTestId('desktop-icon-materials'));
    await user.click(screen.getByTestId('desktop-icon-calendar'));

    expect(screen.getByTestId('window-materials')).toBeInTheDocument();
    expect(screen.getByTestId('window-calendar')).toBeInTheDocument();
  });

  it('closing a window removes it from the open-window state', async () => {
    const user = userEvent.setup();
    const onWindowsChange = jest.fn<void, [WindowState[]]>();
    render(<DesktopEnvironment onWindowsChange={onWindowsChange} />);

    await user.click(screen.getByTestId('desktop-icon-stats'));
    expect(screen.getByTestId('window-stats')).toBeInTheDocument();

    await user.click(screen.getByTestId('window-close-stats'));

    expect(screen.queryByTestId('window-stats')).not.toBeInTheDocument();
    const latest = onWindowsChange.mock.calls.at(-1)?.[0] ?? [];
    expect(latest.map((w) => w.appId)).not.toContain('stats');
  });

  it('opening an already-open app focuses it instead of duplicating it', async () => {
    const user = userEvent.setup();
    const onWindowsChange = jest.fn<void, [WindowState[]]>();
    render(<DesktopEnvironment onWindowsChange={onWindowsChange} />);

    await user.click(screen.getByTestId('desktop-icon-roadmap'));
    await user.click(screen.getByTestId('desktop-icon-calendar'));
    // Re-open roadmap: should focus the existing window, not create a second.
    await user.click(screen.getByTestId('desktop-icon-roadmap'));

    expect(screen.getAllByTestId('window-roadmap')).toHaveLength(1);

    const latest = onWindowsChange.mock.calls.at(-1)?.[0] ?? [];
    expect(latest.map((w) => w.appId).sort()).toEqual(['calendar', 'roadmap']);

    const roadmap = latest.find((w) => w.appId === 'roadmap');
    const calendar = latest.find((w) => w.appId === 'calendar');
    expect(roadmap?.isFocused).toBe(true);
    expect(calendar?.isFocused).toBe(false);
    // Refocused window is raised above the other.
    expect((roadmap?.zIndex ?? 0) > (calendar?.zIndex ?? 0)).toBe(true);
  });

  it('exposes open/close/focus controls to the window render prop', async () => {
    const user = userEvent.setup();
    render(
      <DesktopEnvironment
        renderWindows={(windows, controls) => (
          <div>
            {windows.map((w) => (
              <div key={w.appId} data-testid={`custom-window-${w.appId}`}>
                <button
                  type="button"
                  data-testid={`custom-focus-${w.appId}`}
                  onClick={() => controls.focusWindow(w.appId)}
                >
                  focus
                </button>
                <button
                  type="button"
                  data-testid={`custom-close-${w.appId}`}
                  onClick={() => controls.closeWindow(w.appId)}
                >
                  close
                </button>
              </div>
            ))}
          </div>
        )}
      />
    );

    await user.click(screen.getByTestId('desktop-icon-timetable'));
    expect(screen.getByTestId('custom-window-timetable')).toBeInTheDocument();

    // The default placeholder layer is replaced by the render prop.
    expect(screen.queryByTestId('window-timetable')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('custom-close-timetable'));
    expect(screen.queryByTestId('custom-window-timetable')).not.toBeInTheDocument();
  });

  it('renders a custom app set when provided', () => {
    render(
      <DesktopEnvironment
        apps={[{ id: 'materials', name: 'Only Materials', glyph: '📚' }]}
      />
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByTestId('desktop-icon-materials')).toBeInTheDocument();
  });
});
