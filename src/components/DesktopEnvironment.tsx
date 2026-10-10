import React, { useCallback, useMemo, useState } from 'react';
import './DesktopEnvironment.css';

/**
 * Identifiers for the six FMI OS desktop applications.
 *
 * Requirement 3.1 fixes this set at exactly six apps. Keeping it as a string
 * union (rather than a loose `string`) lets later tasks — the WindowPanel
 * registry (2.4) and icon wiring (16.1) — switch exhaustively over app ids.
 */
export type DesktopAppId =
  | 'materials'
  | 'examinations'
  | 'calendar'
  | 'timetable'
  | 'stats'
  | 'roadmap';

/**
 * Static descriptor for a desktop app icon. The concrete window component that
 * each app opens is deliberately NOT part of this task — task 16.1 wires icons
 * to real {@link WindowPanel} app windows. Here an app is just something that
 * can be shown on the desktop and opened.
 */
export interface DesktopApp {
  id: DesktopAppId;
  /** Human-readable label rendered under the icon. */
  name: string;
  /** Short glyph/emoji placeholder standing in for a real icon asset. */
  glyph: string;
}

/**
 * Runtime state for a single open window, tracked by the panel registry.
 *
 * The registry owns open/closed membership, focus, z-order, position and size.
 * Position and size are seeded with defaults on open and updated through the
 * `moveWindow` / `resizeWindow` controls (fed by WindowPanel's drag callbacks);
 * the interaction itself (dragging, future resize handles) lives in WindowPanel.
 */
export interface WindowState {
  appId: DesktopAppId;
  isOpen: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  isFocused: boolean;
}

/**
 * Handlers exposed to descendants (icons today, Taskbar/WindowPanel later) so
 * they can drive the window registry without owning it. Task 2.4 and 16.1
 * consume these as the extension points for opening real app windows.
 */
export interface DesktopWindowControls {
  /** Open an app window (or focus it if already open). */
  openWindow: (appId: DesktopAppId) => void;
  /** Close an app window and drop it from the registry. */
  closeWindow: (appId: DesktopAppId) => void;
  /** Raise an app window above all others and mark it focused. */
  focusWindow: (appId: DesktopAppId) => void;
  /**
   * Move an open window to a new top-left position (e.g. from WindowPanel's
   * `onMove`). Only that window's `position` changes: its size, focus and
   * z-index, and every other window, are left untouched (Requirement 3.3).
   * No-op if the app is not open.
   */
  moveWindow: (appId: DesktopAppId, position: WindowState['position']) => void;
  /**
   * Resize an open window. Only that window's `size` changes; everything else
   * is left untouched (Requirement 3.3). No-op if the app is not open.
   */
  resizeWindow: (appId: DesktopAppId, size: WindowState['size']) => void;
}

export interface DesktopEnvironmentProps {
  /**
   * Apps to render as desktop icons. Defaults to the six FMI OS apps
   * (Requirement 3.1). Overridable to keep the component testable in isolation.
   */
  apps?: DesktopApp[];
  /**
   * Render prop for the window layer. Receives the current open windows (in
   * z-order) and the registry controls so the WindowPanel task (2.4) can mount
   * real draggable windows here. Until then the layer renders lightweight
   * placeholders so open/close/focus is observable.
   */
  renderWindows?: (
    windows: WindowState[],
    controls: DesktopWindowControls
  ) => React.ReactNode;
  /**
   * Slot for the persistent Taskbar (task 3.1). Rendered fixed at the bottom of
   * the desktop. Left empty here — this task only provides the mounting point.
   */
  taskbarSlot?: React.ReactNode;
  /**
   * Notified whenever the set, order, focus, position or size of open windows
   * changes.
   */
  onWindowsChange?: (windows: WindowState[]) => void;
}

/**
 * The six FMI OS desktop apps, in the order Requirement 3.1 lists them.
 */
export const DEFAULT_DESKTOP_APPS: DesktopApp[] = [
  { id: 'materials', name: 'Materials', glyph: '📚' },
  { id: 'examinations', name: 'Future Examinations', glyph: '📝' },
  { id: 'calendar', name: 'Calendar', glyph: '📅' },
  { id: 'timetable', name: 'Timetable', glyph: '🗓️' },
  { id: 'stats', name: 'Stats', glyph: '📊' },
  { id: 'roadmap', name: 'Roadmap', glyph: '🧭' },
];

const DEFAULT_WINDOW_SIZE = { width: 720, height: 480 };
const CASCADE_OFFSET = 32;

/**
 * Seed state for a freshly opened window. Position cascades slightly per open
 * window so stacked windows are not perfectly coincident; the WindowPanel task
 * (2.4) takes over real positioning from here.
 */
const makeWindowState = (appId: DesktopAppId, openCount: number, zIndex: number): WindowState => ({
  appId,
  isOpen: true,
  position: {
    x: 80 + openCount * CASCADE_OFFSET,
    y: 60 + openCount * CASCADE_OFFSET,
  },
  size: { ...DEFAULT_WINDOW_SIZE },
  zIndex,
  isFocused: true,
});

/**
 * DesktopEnvironment is the OS-style desktop shell rendered after the boot
 * sequence completes (Requirement 2.1 → 3.1).
 *
 * This task provides three things and no more:
 *   1. A full-viewport desktop surface that renders the six app icons.
 *   2. A window layer (via `renderWindows`) where draggable WindowPanel windows
 *      (task 2.4) will mount.
 *   3. Open-window state management: a registry tracking which apps are open,
 *      plus open/close/focus controls with correct z-ordering and focus, and
 *      move/resize controls that update one window's geometry in isolation.
 *
 * Deliberately out of scope (separate tasks): the WindowPanel container and its
 * dragging/resizing (2.4), the Taskbar controls (3.1), and wiring each icon to
 * a concrete app window (16.1). Those get clean extension points — the render
 * prop, the taskbar slot, and the exposed controls — but are not built here.
 */
const DesktopEnvironment: React.FC<DesktopEnvironmentProps> = ({
  apps = DEFAULT_DESKTOP_APPS,
  renderWindows,
  taskbarSlot,
  onWindowsChange,
}) => {
  // The panel registry. Keyed by appId since an app has at most one window.
  const [windows, setWindows] = useState<Record<string, WindowState>>({});
  // Monotonic counter handing out the next z-index so focus always wins.
  const [nextZIndex, setNextZIndex] = useState(1);

  // Windows sorted by z-index (back to front) — the order the window layer and
  // tests consume.
  const orderedWindows = useMemo(
    () => Object.values(windows).sort((a, b) => a.zIndex - b.zIndex),
    [windows]
  );

  const notify = useCallback(
    (next: Record<string, WindowState>) => {
      onWindowsChange?.(Object.values(next).sort((a, b) => a.zIndex - b.zIndex));
    },
    [onWindowsChange]
  );

  const focusWindow = useCallback(
    (appId: DesktopAppId) => {
      setWindows((prev) => {
        const existing = prev[appId];
        if (!existing) {
          return prev;
        }
        const z = nextZIndex;
        const next: Record<string, WindowState> = {};
        // Raise the target and defocus everything else.
        for (const [id, win] of Object.entries(prev)) {
          next[id] =
            id === appId
              ? { ...win, zIndex: z, isFocused: true }
              : win.isFocused
                ? { ...win, isFocused: false }
                : win;
        }
        notify(next);
        return next;
      });
      setNextZIndex((z) => z + 1);
    },
    [nextZIndex, notify]
  );

  const openWindow = useCallback(
    (appId: DesktopAppId) => {
      setWindows((prev) => {
        // Opening an already-open app just focuses it (Requirement 3.3: focus
        // handling), it does not create a duplicate window.
        if (prev[appId]) {
          const z = nextZIndex;
          const next: Record<string, WindowState> = {};
          for (const [id, win] of Object.entries(prev)) {
            next[id] =
              id === appId
                ? { ...win, zIndex: z, isFocused: true }
                : win.isFocused
                  ? { ...win, isFocused: false }
                  : win;
          }
          notify(next);
          return next;
        }

        const z = nextZIndex;
        const openCount = Object.keys(prev).length;
        const next: Record<string, WindowState> = {};
        for (const [id, win] of Object.entries(prev)) {
          next[id] = win.isFocused ? { ...win, isFocused: false } : win;
        }
        next[appId] = makeWindowState(appId, openCount, z);
        notify(next);
        return next;
      });
      setNextZIndex((z) => z + 1);
    },
    [nextZIndex, notify]
  );

  const closeWindow = useCallback(
    (appId: DesktopAppId) => {
      setWindows((prev) => {
        if (!prev[appId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[appId];
        notify(next);
        return next;
      });
    },
    [notify]
  );

  // Geometry updates replace only the target window's entry, so every other
  // window keeps its exact state (Requirement 3.3). Focus and z-order are not
  // touched here: raising a window is `focusWindow`'s job (WindowPanel calls it
  // on title-bar press before reporting drag moves). The incoming value is
  // copied so the registry never shares a position/size object with a caller.
  const moveWindow = useCallback(
    (appId: DesktopAppId, position: WindowState['position']) => {
      setWindows((prev) => {
        const existing = prev[appId];
        if (
          !existing ||
          (existing.position.x === position.x && existing.position.y === position.y)
        ) {
          return prev;
        }
        const next: Record<string, WindowState> = {
          ...prev,
          [appId]: { ...existing, position: { x: position.x, y: position.y } },
        };
        notify(next);
        return next;
      });
    },
    [notify]
  );

  const resizeWindow = useCallback(
    (appId: DesktopAppId, size: WindowState['size']) => {
      setWindows((prev) => {
        const existing = prev[appId];
        if (
          !existing ||
          (existing.size.width === size.width && existing.size.height === size.height)
        ) {
          return prev;
        }
        const next: Record<string, WindowState> = {
          ...prev,
          [appId]: { ...existing, size: { width: size.width, height: size.height } },
        };
        notify(next);
        return next;
      });
    },
    [notify]
  );

  const controls = useMemo<DesktopWindowControls>(
    () => ({ openWindow, closeWindow, focusWindow, moveWindow, resizeWindow }),
    [openWindow, closeWindow, focusWindow, moveWindow, resizeWindow]
  );

  return (
    <div className="desktop-environment" data-testid="desktop-environment">
      <div
        className="desktop-environment__surface"
        data-testid="desktop-surface"
        role="list"
        aria-label="Desktop apps"
      >
        {apps.map((app) => (
          <button
            key={app.id}
            type="button"
            className="desktop-icon"
            role="listitem"
            data-testid={`desktop-icon-${app.id}`}
            data-app-id={app.id}
            aria-label={`Open ${app.name}`}
            // A single activation opens the app here. Double-click handling and
            // wiring to concrete app windows is task 16.1; this is the clean
            // open hook that task builds on.
            onClick={() => openWindow(app.id)}
          >
            <span className="desktop-icon__glyph" aria-hidden="true">
              {app.glyph}
            </span>
            <span className="desktop-icon__label">{app.name}</span>
          </button>
        ))}
      </div>

      <div className="desktop-environment__windows" data-testid="desktop-window-layer">
        {renderWindows
          ? renderWindows(orderedWindows, controls)
          : orderedWindows.map((win) => (
              // Placeholder window. The real draggable WindowPanel (task 2.4)
              // replaces this via the `renderWindows` prop; it exists now only
              // so open/close/focus is observable and testable.
              <div
                key={win.appId}
                className="desktop-window-placeholder"
                data-testid={`window-${win.appId}`}
                data-focused={win.isFocused}
                style={{ zIndex: win.zIndex }}
              >
                <div className="desktop-window-placeholder__bar">
                  <span>{win.appId}</span>
                  <button
                    type="button"
                    aria-label={`Close ${win.appId}`}
                    data-testid={`window-close-${win.appId}`}
                    onClick={() => closeWindow(win.appId)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
      </div>

      <div className="desktop-environment__taskbar" data-testid="desktop-taskbar-slot">
        {taskbarSlot}
      </div>
    </div>
  );
};

export default DesktopEnvironment;
