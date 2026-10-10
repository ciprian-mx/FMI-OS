import React, { useCallback, useEffect, useRef } from 'react';
import './WindowPanel.css';

/**
 * A 2D point / position on the desktop surface, in viewport pixels.
 */
export interface WindowPosition {
  x: number;
  y: number;
}

/**
 * Window dimensions in viewport pixels.
 */
export interface WindowSize {
  width: number;
  height: number;
}

/**
 * Props for {@link WindowPanel}.
 *
 * WindowPanel is the generic draggable, focusable container that hosts a
 * desktop app's content (design doc: `WindowPanel`). It implements Requirement
 * 3.2 (draggable window-like panel) and the drag/focus half of 3.4 (clicking
 * the title bar raises the window and lets the student drag it).
 *
 * The panel is deliberately **controlled**: `position`, `size`, `zIndex` and
 * `isFocused` are owned by the caller (the DesktopEnvironment panel registry).
 * The panel never stores window geometry in its own state; instead it reports
 * intended changes through callbacks (`onMove`, `onFocus`, `onClose`). This is
 * what lets many windows compose under a single registry (Requirement 3.3:
 * independent position/focus/z-index) without the panels fighting each other
 * for ownership of that state.
 */
export interface WindowPanelProps {
  /** Title shown in the title bar and used for accessible labels. */
  title: string;
  /** App identifier, surfaced on data attributes for testing/wiring. */
  appId?: string;
  /** Current top-left position of the window (controlled). */
  position: WindowPosition;
  /** Current window size (controlled). */
  size: WindowSize;
  /** Stacking order relative to other windows (controlled). */
  zIndex: number;
  /** Whether this window currently has focus (controlled). */
  isFocused: boolean;
  /** App content rendered in the window body. */
  children: React.ReactNode;
  /**
   * Called with the new top-left position while/after the student drags the
   * title bar. The caller is expected to feed the value back in via `position`
   * (controlled drag). Alias `onDrag` is accepted for callers that prefer that
   * name; both receive the same value.
   */
  onMove?: (position: WindowPosition) => void;
  /** Alias of {@link onMove}. If both are supplied, both are invoked. */
  onDrag?: (position: WindowPosition) => void;
  /**
   * Called when the window should be raised/focused: on title-bar press and on
   * any pointer-down within the window body. The caller raises `zIndex` and
   * sets `isFocused` through the registry.
   */
  onFocus?: () => void;
  /** Called when the close control is activated. */
  onClose?: () => void;
  /**
   * Optional clamp bounds (viewport size). When provided, the dragged position
   * is kept within [0, bounds - a small margin] so a window cannot be dragged
   * fully off-screen. Defaults to the current window's viewport.
   */
  dragBounds?: { width: number; height: number };
}

/**
 * Minimum number of pixels of the window that must remain on screen when
 * clamping a drag, so a dragged-away window can always be grabbed again.
 */
const MIN_VISIBLE = 48;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * WindowPanel — a draggable, focusable OS-style window container.
 *
 * Behaviour:
 *   - Dragging the title bar updates position. On title-bar pointer-down we
 *     record the offset between the pointer and the window origin, then follow
 *     pointer moves on the document, reporting the new origin via `onMove`
 *     (clamped so the window stays reachable). The move/up listeners live on
 *     `document` so a fast drag that outruns the cursor does not drop the drag.
 *   - Pressing the title bar (or clicking anywhere in the window) calls
 *     `onFocus`, so the registry can raise this window above the others
 *     (Requirement 3.4).
 *   - The close control calls `onClose`.
 *
 * Resizing is intentionally left as a clean extension point rather than
 * implemented here: the design marks it optional for this task, and a correct
 * controlled resize interaction (edge/corner handles, min-size clamping,
 * aspect handling) is a meaningful surface of its own. `size` is already a
 * controlled prop, so a future task can add handles that call a `onResize`
 * callback without reworking this component.
 */
const WindowPanel: React.FC<WindowPanelProps> = ({
  title,
  appId,
  position,
  size,
  zIndex,
  isFocused,
  children,
  onMove,
  onDrag,
  onFocus,
  onClose,
  dragBounds,
}) => {
  // Live drag state kept in refs: dragging must not trigger re-renders of this
  // controlled component (the parent re-renders it when it feeds back
  // `position`). `offset` is the pointer-to-origin delta captured at grab time
  // so the window does not "jump" to the cursor on the first move.
  const draggingRef = useRef(false);
  const offsetRef = useRef<WindowPosition>({ x: 0, y: 0 });

  // Keep the latest callbacks/props in refs so the document-level listeners
  // (registered once per drag) always read current values without needing to
  // re-subscribe on every render.
  const onMoveRef = useRef(onMove);
  const onDragRef = useRef(onDrag);
  const boundsRef = useRef(dragBounds);
  onMoveRef.current = onMove;
  onDragRef.current = onDrag;
  boundsRef.current = dragBounds;

  const reportMove = useCallback((next: WindowPosition) => {
    onMoveRef.current?.(next);
    onDragRef.current?.(next);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent | MouseEvent) => {
      if (!draggingRef.current) {
        return;
      }
      const bounds = boundsRef.current ?? {
        width: typeof window !== 'undefined' ? window.innerWidth : Number.MAX_SAFE_INTEGER,
        height: typeof window !== 'undefined' ? window.innerHeight : Number.MAX_SAFE_INTEGER,
      };

      const rawX = event.clientX - offsetRef.current.x;
      const rawY = event.clientY - offsetRef.current.y;

      // Keep at least MIN_VISIBLE px of the window on each axis reachable.
      const maxX = Math.max(0, bounds.width - MIN_VISIBLE);
      const maxY = Math.max(0, bounds.height - MIN_VISIBLE);
      const minX = Math.min(0, -(0)); // 0; window may touch the left edge.

      reportMove({
        x: clamp(rawX, minX, maxX),
        y: clamp(rawY, 0, maxY),
      });
    },
    [reportMove]
  );

  const endDrag = useCallback(() => {
    draggingRef.current = false;
  }, []);

  // Subscribe to document-level move/up for the lifetime of the component so an
  // in-flight drag survives the cursor leaving the title bar. The listeners are
  // no-ops unless `draggingRef` is set, so they are cheap when idle.
  useEffect(() => {
    document.addEventListener('mousemove', handlePointerMove);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('pointerup', endDrag);
    return () => {
      document.removeEventListener('mousemove', handlePointerMove);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('mouseup', endDrag);
      document.removeEventListener('pointerup', endDrag);
    };
  }, [handlePointerMove, endDrag]);

  const beginDrag = useCallback(
    (clientX: number, clientY: number) => {
      draggingRef.current = true;
      // Capture where inside the window the grab happened so dragging preserves
      // the grab point rather than snapping the origin to the cursor.
      offsetRef.current = {
        x: clientX - position.x,
        y: clientY - position.y,
      };
    },
    [position.x, position.y]
  );

  const handleTitleBarPointerDown = useCallback(
    (event: React.PointerEvent | React.MouseEvent) => {
      // Pressing the title bar focuses/raises the window (Requirement 3.4) and
      // starts a drag. Stop propagation so the window-level focus handler does
      // not also fire — the title bar already owns the focus for this press.
      event.stopPropagation();
      onFocus?.();
      beginDrag(event.clientX, event.clientY);
    },
    [beginDrag, onFocus]
  );

  // Clicking anywhere in the window (not just the title bar) focuses it, so a
  // student can bring a background window forward by clicking its content.
  const handleWindowPointerDown = useCallback(() => {
    onFocus?.();
  }, [onFocus]);

  return (
    <section
      className={`window-panel${isFocused ? ' window-panel--focused' : ''}`}
      data-testid={appId ? `window-panel-${appId}` : 'window-panel'}
      data-app-id={appId}
      data-focused={isFocused}
      role="dialog"
      aria-label={title}
      aria-modal={false}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex,
      }}
      onPointerDown={handleWindowPointerDown}
      onMouseDown={handleWindowPointerDown}
    >
      <header
        className="window-panel__titlebar"
        data-testid="window-panel-titlebar"
        onPointerDown={handleTitleBarPointerDown}
        onMouseDown={handleTitleBarPointerDown}
      >
        <span className="window-panel__title" title={title}>
          {title}
        </span>
        <button
          type="button"
          className="window-panel__close"
          data-testid="window-panel-close"
          aria-label={`Close ${title}`}
          // Keep the close click from also starting a drag / refocus churn.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.();
          }}
        >
          ×
        </button>
      </header>

      <div className="window-panel__body" data-testid="window-panel-body">
        {children}
      </div>
    </section>
  );
};

export default WindowPanel;
