import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import DesktopEnvironment, {
  DEFAULT_DESKTOP_APPS,
  DesktopAppId,
  DesktopWindowControls,
  WindowState,
} from './DesktopEnvironment';
import WindowPanel from './WindowPanel';

/**
 * Feature: fmi-os, Property 4: Desktop Window Management Independence
 * **Validates: Requirements 3.3**
 *
 * *For any* set of open Desktop App windows, each window SHALL maintain
 * independent focus state, position, size, and z-index — modifying one
 * window's properties SHALL NOT affect any other window's properties.
 *
 * How the property is exercised
 * -----------------------------
 * Each run renders the real DesktopEnvironment, hosting its windows in real
 * WindowPanels wired to the registry controls, and builds an arbitrary desktop
 * through those controls: a random subset of the six apps opened in random
 * order, each moved and resized to a random geometry, then a random focus
 * sequence that shuffles focus and z-order. A final operation then targets one
 * window: move, resize, focus, close, open (another app, or an already-open
 * one), or a real title-bar drag through WindowPanel, which raises and moves
 * the window.
 *
 * Every step (setup and final) is checked against deep snapshots of the
 * registry taken just before and just after it:
 *   - every other window keeps its appId, isOpen, position, size and zIndex
 *     exactly. Its isFocused changes only when the step gives the target focus
 *     (focus is exclusive), and then it becomes false;
 *   - the target changes only in the way the step intends;
 *   - a step aimed at an app that is not open changes nothing;
 *   - z-indexes stay distinct, with at most one focused window, which is the
 *     top-most one.
 */

type Position = WindowState['position'];
type Size = WindowState['size'];

const APP_IDS: DesktopAppId[] = DEFAULT_DESKTOP_APPS.map((app) => app.id);
const APP_NAMES = new Map(DEFAULT_DESKTOP_APPS.map((app) => [app.id, app.name]));

/** Drag bounds large enough that no generated position is ever clamped. */
const DRAG_BOUNDS = { width: 4000, height: 3000 };
/** Where inside the title bar a drag grabs the window, relative to its origin. */
const GRAB_OFFSET: Position = { x: 12, y: 8 };

const positionArb: fc.Arbitrary<Position> = fc.record({
  x: fc.integer({ min: 0, max: 1800 }),
  y: fc.integer({ min: 0, max: 1000 }),
});

const sizeArb: fc.Arbitrary<Size> = fc.record({
  width: fc.integer({ min: 200, max: 1600 }),
  height: fc.integer({ min: 150, max: 1000 }),
});

/** One registry operation, aimed at a single window. */
type WindowOp =
  | { kind: 'open'; appId: DesktopAppId }
  | { kind: 'close'; appId: DesktopAppId }
  | { kind: 'focus'; appId: DesktopAppId }
  | { kind: 'move'; appId: DesktopAppId; position: Position }
  | { kind: 'resize'; appId: DesktopAppId; size: Size }
  /** Title-bar drag through WindowPanel to `position` (raises, then moves). */
  | { kind: 'drag'; appId: DesktopAppId; position: Position };

interface WindowSeed {
  appId: DesktopAppId;
  position: Position;
  size: Size;
}

interface Scenario {
  /** The arbitrary set of open windows, in opening order. */
  seeds: WindowSeed[];
  /** Focus changes applied after the layout is built, shuffling z-order. */
  focusOrder: DesktopAppId[];
  /** The operation that modifies one window. */
  op: WindowOp;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(fc.record({ appId: fc.constantFrom(...APP_IDS), position: positionArb, size: sizeArb }), {
    minLength: 1,
    maxLength: APP_IDS.length,
    selector: (seed) => seed.appId,
  })
  .chain((seeds) => {
    const openApp = fc.constantFrom(...seeds.map((seed) => seed.appId));
    const anyApp = fc.constantFrom(...APP_IDS);
    // Mostly aim at an open window; sometimes at any app, which covers
    // operations on an app that is not open (they must change nothing).
    const target = fc.oneof({ arbitrary: openApp, weight: 4 }, { arbitrary: anyApp, weight: 1 });
    const op: fc.Arbitrary<WindowOp> = fc.oneof(
      fc.record({ kind: fc.constant('move' as const), appId: target, position: positionArb }),
      fc.record({ kind: fc.constant('resize' as const), appId: target, size: sizeArb }),
      fc.record({ kind: fc.constant('focus' as const), appId: target }),
      fc.record({ kind: fc.constant('close' as const), appId: target }),
      // Opens another app, or refocuses one that is already open.
      fc.record({ kind: fc.constant('open' as const), appId: anyApp }),
      // Dragging needs a rendered window, so it always targets an open one.
      fc.record({ kind: fc.constant('drag' as const), appId: openApp, position: positionArb })
    );
    return fc.record({
      seeds: fc.constant(seeds),
      focusOrder: fc.array(openApp, { maxLength: 6 }),
      op,
    });
  });

interface DesktopHarness {
  /** Windows as the window layer last rendered them. */
  windows: () => WindowState[];
  /** Registry controls from the latest render. */
  controls: () => DesktopWindowControls;
}

/**
 * Renders DesktopEnvironment with each open window hosted in a WindowPanel
 * wired to the registry, the way the desktop hosts app windows.
 */
function renderDesktop(onWindowsChange?: (windows: WindowState[]) => void): DesktopHarness {
  let windows: WindowState[] = [];
  let controls: DesktopWindowControls | null = null;

  render(
    <DesktopEnvironment
      onWindowsChange={onWindowsChange}
      renderWindows={(currentWindows, currentControls) => {
        // Re-captured on every render: open/focus close over the registry's
        // next z-index, so only the latest controls are current.
        windows = currentWindows;
        controls = currentControls;
        return currentWindows.map((win) => (
          <WindowPanel
            key={win.appId}
            title={APP_NAMES.get(win.appId) ?? win.appId}
            appId={win.appId}
            position={win.position}
            size={win.size}
            zIndex={win.zIndex}
            isFocused={win.isFocused}
            dragBounds={DRAG_BOUNDS}
            onMove={(position) => currentControls.moveWindow(win.appId, position)}
            onFocus={() => currentControls.focusWindow(win.appId)}
            onClose={() => currentControls.closeWindow(win.appId)}
          >
            <p>{win.appId} window</p>
          </WindowPanel>
        ));
      }}
    />
  );

  return {
    windows: () => windows,
    controls: () => {
      if (!controls) {
        throw new Error('window controls were not captured');
      }
      return controls;
    },
  };
}

type Snapshot = Map<DesktopAppId, WindowState>;

/** Deep copy keyed by app, so an in-place mutation could not go unnoticed. */
function snapshot(windows: readonly WindowState[]): Snapshot {
  return new Map(
    windows.map((win) => [win.appId, { ...win, position: { ...win.position }, size: { ...win.size } }])
  );
}

/** Press a window's title bar, drag it so its origin lands on `to`, release. */
function dragTitleBar(appId: DesktopAppId, from: Position, to: Position): void {
  const titleBar = within(screen.getByTestId(`window-panel-${appId}`)).getByTestId(
    'window-panel-titlebar'
  );
  fireEvent.mouseDown(titleBar, { clientX: from.x + GRAB_OFFSET.x, clientY: from.y + GRAB_OFFSET.y });
  fireEvent.mouseMove(document, { clientX: to.x + GRAB_OFFSET.x, clientY: to.y + GRAB_OFFSET.y });
  fireEvent.mouseUp(document, { clientX: to.x + GRAB_OFFSET.x, clientY: to.y + GRAB_OFFSET.y });
}

function applyStep(desktop: DesktopHarness, step: WindowOp, before: Snapshot): void {
  if (step.kind === 'drag') {
    const from = before.get(step.appId)?.position;
    if (!from) {
      throw new Error(`cannot drag ${step.appId}: it is not open`);
    }
    dragTitleBar(step.appId, from, step.position);
    return;
  }

  const controls = desktop.controls();
  act(() => {
    switch (step.kind) {
      case 'open':
        controls.openWindow(step.appId);
        break;
      case 'close':
        controls.closeWindow(step.appId);
        break;
      case 'focus':
        controls.focusWindow(step.appId);
        break;
      case 'move':
        controls.moveWindow(step.appId, step.position);
        break;
      case 'resize':
        controls.resizeWindow(step.appId, step.size);
        break;
    }
  });
}

/** Property 4 across one step: only the targeted window may change. */
function expectOnlyTargetChanged(before: Snapshot, after: Snapshot, op: WindowOp): void {
  const prevTarget = before.get(op.appId);
  const nextTarget = after.get(op.appId);

  // Modifying a window that is not open must change nothing at all.
  if (!prevTarget && op.kind !== 'open') {
    expect(after).toEqual(before);
    return;
  }

  // Focus is exclusive, so giving the target focus is the only way a step may
  // touch another window: that window loses focus, and nothing else changes.
  const focusesTarget = op.kind === 'focus' || op.kind === 'open' || op.kind === 'drag';

  const otherIds = (snap: Snapshot) => [...snap.keys()].filter((id) => id !== op.appId).sort();
  expect(otherIds(after)).toEqual(otherIds(before));
  for (const [appId, prev] of before) {
    if (appId !== op.appId) {
      expect(after.get(appId)).toEqual(focusesTarget ? { ...prev, isFocused: false } : prev);
    }
  }

  // The target itself changes only in the way the step intends.
  switch (op.kind) {
    case 'move':
      expect(nextTarget).toEqual({ ...prevTarget, position: op.position });
      break;
    case 'resize':
      expect(nextTarget).toEqual({ ...prevTarget, size: op.size });
      break;
    case 'close':
      expect(nextTarget).toBeUndefined();
      break;
    case 'focus':
    case 'open':
    case 'drag':
      expect(nextTarget).toMatchObject({ appId: op.appId, isOpen: true, isFocused: true });
      for (const [appId, other] of after) {
        if (appId !== op.appId) {
          expect(nextTarget?.zIndex).toBeGreaterThan(other.zIndex);
        }
      }
      if (prevTarget) {
        // Raising keeps the window's geometry; a drag also moves it.
        expect(nextTarget?.size).toEqual(prevTarget.size);
        expect(nextTarget?.position).toEqual(op.kind === 'drag' ? op.position : prevTarget.position);
      }
      break;
  }
}

/** Distinct z-indexes, and at most one focused window, which is top-most. */
function expectZOrderInvariants(windows: readonly WindowState[]): void {
  expect(new Set(windows.map((win) => win.appId)).size).toBe(windows.length);
  const zIndexes = windows.map((win) => win.zIndex);
  expect(new Set(zIndexes).size).toBe(zIndexes.length);
  const focused = windows.filter((win) => win.isFocused);
  expect(focused.length).toBeLessThanOrEqual(1);
  if (focused.length === 1) {
    expect(focused[0].zIndex).toBe(Math.max(...zIndexes));
  }
}

/** Apply one step and check Property 4 and the z-order invariants across it. */
function checkStep(desktop: DesktopHarness, step: WindowOp): void {
  const before = snapshot(desktop.windows());
  applyStep(desktop, step, before);
  expectOnlyTargetChanged(before, snapshot(desktop.windows()), step);
  expectZOrderInvariants(desktop.windows());
}

/** Steps that build the scenario's layout: open, place, then shuffle focus. */
function setupSteps({ seeds, focusOrder }: Scenario): WindowOp[] {
  return [
    ...seeds.map((seed): WindowOp => ({ kind: 'open', appId: seed.appId })),
    ...seeds.flatMap((seed): WindowOp[] => [
      { kind: 'move', appId: seed.appId, position: seed.position },
      { kind: 'resize', appId: seed.appId, size: seed.size },
    ]),
    ...focusOrder.map((appId): WindowOp => ({ kind: 'focus', appId })),
  ];
}

describe('Feature: fmi-os, Property 4: Desktop Window Management Independence', () => {
  afterEach(() => {
    cleanup();
  });

  it('modifying one window never changes any other window', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const desktop = renderDesktop();
        try {
          setupSteps(scenario).forEach((step) => checkStep(desktop, step));

          // The final operation runs against the generated layout.
          const layout = snapshot(desktop.windows());
          expect([...layout.keys()].sort()).toEqual(scenario.seeds.map((seed) => seed.appId).sort());
          for (const seed of scenario.seeds) {
            expect(layout.get(seed.appId)).toMatchObject({ position: seed.position, size: seed.size });
          }

          checkStep(desktop, scenario.op);
        } finally {
          cleanup();
        }
      }),
      { numRuns: 150 }
    );
  }, 60_000);
});

describe('DesktopEnvironment moveWindow / resizeWindow controls', () => {
  afterEach(() => {
    cleanup();
  });

  it('moves and resizes only the targeted window and reports the change', () => {
    const onWindowsChange = jest.fn<void, [WindowState[]]>();
    const desktop = renderDesktop(onWindowsChange);
    act(() => desktop.controls().openWindow('materials'));
    act(() => desktop.controls().openWindow('calendar'));
    const before = snapshot(desktop.windows());

    act(() => desktop.controls().moveWindow('calendar', { x: 300, y: 200 }));
    act(() => desktop.controls().resizeWindow('calendar', { width: 640, height: 400 }));

    const after = snapshot(desktop.windows());
    expect(after.get('calendar')).toEqual({
      ...before.get('calendar'),
      position: { x: 300, y: 200 },
      size: { width: 640, height: 400 },
    });
    expect(after.get('materials')).toEqual(before.get('materials'));
    expect(onWindowsChange.mock.calls.at(-1)?.[0].find((win) => win.appId === 'calendar')).toMatchObject({
      position: { x: 300, y: 200 },
      size: { width: 640, height: 400 },
    });
    expect(screen.getByTestId('window-panel-calendar')).toHaveStyle({
      left: '300px',
      top: '200px',
      width: '640px',
      height: '400px',
    });
  });

  it('ignores apps that are not open and unchanged geometry', () => {
    const onWindowsChange = jest.fn<void, [WindowState[]]>();
    const desktop = renderDesktop(onWindowsChange);
    act(() => desktop.controls().openWindow('stats'));
    const before = snapshot(desktop.windows());
    const stats = before.get('stats');
    if (!stats) {
      throw new Error('stats window did not open');
    }
    onWindowsChange.mockClear();

    act(() => desktop.controls().moveWindow('roadmap', { x: 10, y: 10 }));
    act(() => desktop.controls().resizeWindow('roadmap', { width: 300, height: 300 }));
    act(() => desktop.controls().moveWindow('stats', { ...stats.position }));
    act(() => desktop.controls().resizeWindow('stats', { ...stats.size }));

    expect(snapshot(desktop.windows())).toEqual(before);
    expect(onWindowsChange).not.toHaveBeenCalled();
  });
});
