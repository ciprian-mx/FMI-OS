import type { ReactElement, ReactNode } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import DesktopEnvironment, {
  DEFAULT_DESKTOP_APPS,
  DesktopAppId,
  DesktopWindowControls,
  WindowState,
} from './DesktopEnvironment';
import Taskbar from './Taskbar';
import WindowPanel from './WindowPanel';

/**
 * Feature: fmi-os, Property 7: Taskbar Persistent Visibility
 * **Validates: Requirements 4.1**
 *
 * *For any* authenticated UI state (any open panels, any route, any scroll
 * position, any desktop configuration), the Taskbar SHALL be visible at the
 * bottom of the viewport and all three controls ("Start today's session"
 * button, "Ask Gus" input with microphone, Account Center icon) SHALL be
 * present and actionable.
 *
 * How the property is exercised
 * -----------------------------
 * Each run renders the real DesktopEnvironment with the real Taskbar in its
 * `taskbarSlot` and every open window hosted in a real WindowPanel. The run
 * starts at an arbitrary route with arbitrary voice support and listening
 * state, then applies an arbitrary sequence of steps: open, close, focus, move
 * and resize over the six apps, navigation to another route, scrolling, and the
 * microphone starting or stopping listening.
 *
 *   - Visible at all times: after the first render and after every step there
 *     is exactly one Taskbar, mounted in the desktop's bottom taskbar slot, and
 *     each control is visible and enabled (the mic only with voice support).
 *   - Actionable: in the final state a user activates every control, and each
 *     fires its own callback exactly once: Start, "Ask Gus" + Enter (with the
 *     trimmed query), the microphone, and Account Center.
 *   - Microphone without voice support: by design it is then disabled with a
 *     "not supported" tooltip (Requirement 5.4, graceful degradation). For it,
 *     actionable means present and visible with that tooltip, inert when
 *     clicked, while the typed "Ask Gus" path keeps working.
 *
 * Limits of jsdom: there is no layout or painting and CSS is stubbed
 * (identity-obj-proxy), so this cannot measure that the bar sits on the bottom
 * edge or that no window paints over it. It checks what the DOM can show: the
 * bar lives in the desktop's bottom-anchored slot and is visible and enabled as
 * jest-dom computes it. Scrolling cannot move anything here either; the scroll
 * step checks that scroll events never hide or disable the bar.
 */

type Position = WindowState['position'];
type Size = WindowState['size'];

interface VoiceState {
  isVoiceSupported: boolean;
  isListening: boolean;
}

/** One change to the authenticated UI state. */
type DesktopOp =
  | { kind: 'open'; appId: DesktopAppId }
  | { kind: 'close'; appId: DesktopAppId }
  | { kind: 'focus'; appId: DesktopAppId }
  | { kind: 'move'; appId: DesktopAppId; position: Position }
  | { kind: 'resize'; appId: DesktopAppId; size: Size }
  | { kind: 'navigate'; route: string }
  | { kind: 'scroll'; top: number }
  | { kind: 'listen'; isListening: boolean };

interface Scenario {
  /** Route the desktop is rendered at. */
  route: string;
  /** Initial Taskbar voice props. */
  voice: VoiceState;
  /** Steps applied after the first render. */
  ops: DesktopOp[];
}

const APP_IDS: DesktopAppId[] = DEFAULT_DESKTOP_APPS.map((app) => app.id);
const APP_NAMES = new Map(DEFAULT_DESKTOP_APPS.map((app) => [app.id, app.name]));
/** Matches a window's root element, not its title bar, body or close button. */
const WINDOW_PANEL_TESTID = new RegExp(`^window-panel-(${APP_IDS.join('|')})$`);

/** Typed into "Ask Gus" with padding; the Taskbar must submit it trimmed. */
const GUS_QUERY = 'What is a red-black tree?';

const appIdArb: fc.Arbitrary<DesktopAppId> = fc.constantFrom(...APP_IDS);

/** Anywhere in a 1080p viewport, including the bottom strip the Taskbar uses. */
const positionArb: fc.Arbitrary<Position> = fc.record({
  x: fc.integer({ min: 0, max: 1920 }),
  y: fc.integer({ min: 0, max: 1080 }),
});

/** From a small window up to one covering the whole viewport. */
const sizeArb: fc.Arbitrary<Size> = fc.record({
  width: fc.integer({ min: 240, max: 1920 }),
  height: fc.integer({ min: 120, max: 1080 }),
});

/**
 * A same-origin route: an absolute path with an optional query and fragment.
 * Empty segments are left out because a leading "//" would make the path a
 * cross-origin URL, which `history.pushState` rejects.
 */
const routeArb: fc.Arbitrary<string> = fc
  .record({
    segments: fc.array(
      fc.webSegment().filter((segment) => segment !== ''),
      { maxLength: 4 }
    ),
    query: fc.option(fc.webQueryParameters(), { nil: undefined }),
    fragment: fc.option(fc.webFragments(), { nil: undefined }),
  })
  .map(({ segments, query, fragment }) => {
    const search = query === undefined ? '' : `?${query}`;
    const hash = fragment === undefined ? '' : `#${fragment}`;
    return `/${segments.join('/')}${search}${hash}`;
  });

const voiceArb: fc.Arbitrary<VoiceState> = fc.record({
  isVoiceSupported: fc.boolean(),
  isListening: fc.boolean(),
});

// Opening carries the most weight so runs regularly build up several windows.
const desktopOpArb: fc.Arbitrary<DesktopOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('open' as const), appId: appIdArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('close' as const), appId: appIdArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('focus' as const), appId: appIdArb }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('move' as const), appId: appIdArb, position: positionArb }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('resize' as const), appId: appIdArb, size: sizeArb }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('navigate' as const), route: routeArb }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('scroll' as const), top: fc.integer({ min: 0, max: 5000 }) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('listen' as const), isListening: fc.boolean() }) }
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  route: routeArb,
  voice: voiceArb,
  ops: fc.array(desktopOpArb, { maxLength: 20 }),
});

interface TaskbarCallbacks {
  onStartSession: jest.Mock<void, []>;
  onGusQuery: jest.Mock<void, [string]>;
  onVoiceActivate: jest.Mock<void, []>;
  onAccountCenterOpen: jest.Mock<void, []>;
}

interface DesktopHarness {
  /** Window registry controls from the latest render. */
  controls: () => DesktopWindowControls;
  /** Open windows as the window layer last rendered them. */
  windows: () => WindowState[];
  /** The voice props the Taskbar currently has. */
  voice: () => VoiceState;
  /** Re-render with the mic listening or not; the desktop keeps its state. */
  setListening: (isListening: boolean) => void;
}

/**
 * Renders the desktop the way the app composes it: the Taskbar in the
 * persistent `taskbarSlot`, and each open window in a WindowPanel wired to the
 * registry.
 */
function renderDesktopWithTaskbar(
  initialVoice: VoiceState,
  callbacks: TaskbarCallbacks
): DesktopHarness {
  let voice = initialVoice;
  let windows: WindowState[] = [];
  let controls: DesktopWindowControls | null = null;

  const renderWindows = (
    currentWindows: WindowState[],
    currentControls: DesktopWindowControls
  ): ReactNode => {
    // Re-captured on every render: openWindow/focusWindow close over the
    // registry's next z-index, so only the latest controls are current.
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
        onMove={(position) => currentControls.moveWindow(win.appId, position)}
        onFocus={() => currentControls.focusWindow(win.appId)}
        onClose={() => currentControls.closeWindow(win.appId)}
      >
        <p>{APP_NAMES.get(win.appId)} content</p>
      </WindowPanel>
    ));
  };

  const ui = (): ReactElement => (
    <DesktopEnvironment
      renderWindows={renderWindows}
      taskbarSlot={
        <Taskbar
          {...callbacks}
          isVoiceSupported={voice.isVoiceSupported}
          isListening={voice.isListening}
        />
      }
    />
  );

  const { rerender } = render(ui());

  return {
    controls: () => {
      if (!controls) {
        throw new Error('window controls were not captured');
      }
      return controls;
    },
    windows: () => windows,
    voice: () => voice,
    setListening: (isListening) => {
      voice = { ...voice, isListening };
      rerender(ui());
    },
  };
}

/** Apply one step, with registry controls read fresh from the latest render. */
function applyOp(desktop: DesktopHarness, op: DesktopOp): void {
  if (op.kind === 'listen') {
    // `rerender` is already wrapped in act().
    desktop.setListening(op.isListening);
    return;
  }

  const controls = desktop.controls();
  act(() => {
    switch (op.kind) {
      case 'open':
        controls.openWindow(op.appId);
        break;
      case 'close':
        controls.closeWindow(op.appId);
        break;
      case 'focus':
        controls.focusWindow(op.appId);
        break;
      case 'move':
        controls.moveWindow(op.appId, op.position);
        break;
      case 'resize':
        controls.resizeWindow(op.appId, op.size);
        break;
      case 'navigate':
        window.history.pushState(null, '', op.route);
        // Tell route listeners, as a back/forward navigation would.
        window.dispatchEvent(new PopStateEvent('popstate'));
        break;
      case 'scroll':
        // The page and the content of every open window.
        for (const el of [document.documentElement, ...screen.queryAllByTestId('window-panel-body')]) {
          el.scrollTop = op.top;
          el.dispatchEvent(new Event('scroll'));
        }
        window.dispatchEvent(new Event('scroll'));
        break;
    }
  });
}

interface TaskbarElements {
  startSession: HTMLElement;
  askGusInput: HTMLElement;
  mic: HTMLElement;
  accountCenter: HTMLElement;
}

/**
 * Persistent visibility: exactly one Taskbar, in the desktop's bottom taskbar
 * slot, with all three controls visible and enabled for the current voice props.
 */
function expectTaskbarPresent(voice: VoiceState): TaskbarElements {
  expect(screen.getAllByTestId('taskbar')).toHaveLength(1);
  const taskbar = within(screen.getByTestId('desktop-taskbar-slot')).getByTestId('taskbar');
  expect(taskbar).toHaveAttribute('role', 'toolbar');

  const askGus = within(taskbar).getByTestId('taskbar-ask-gus');
  const elements: TaskbarElements = {
    startSession: within(taskbar).getByTestId('taskbar-start-session'),
    askGusInput: within(askGus).getByTestId('taskbar-ask-gus-input'),
    // The mic belongs to the "Ask Gus" control, next to its input.
    mic: within(askGus).getByTestId('taskbar-mic'),
    accountCenter: within(taskbar).getByTestId('taskbar-account-center'),
  };

  // toBeVisible also checks every ancestor, so this covers the bar and its slot.
  Object.values(elements).forEach((element) => expect(element).toBeVisible());
  expect(elements.startSession).toBeEnabled();
  expect(elements.askGusInput).toBeEnabled();
  expect(elements.askGusInput).not.toHaveAttribute('readonly');
  expect(elements.accountCenter).toBeEnabled();

  if (voice.isVoiceSupported) {
    expect(elements.mic).toBeEnabled();
  } else {
    // Graceful degradation (Requirement 5.4): disabled, with a tooltip saying why.
    expect(elements.mic).toBeDisabled();
    expect(elements.mic).toHaveAttribute('title', expect.stringMatching(/not supported/i));
  }
  expect(elements.mic).toHaveAttribute('aria-pressed', String(voice.isListening));

  return elements;
}

/** The generated windows are really on screen, and the Taskbar is intact. */
function expectDesktopState(desktop: DesktopHarness): void {
  expect(screen.queryAllByTestId(WINDOW_PANEL_TESTID)).toHaveLength(desktop.windows().length);
  expectTaskbarPresent(desktop.voice());
}

/** Use every control as a student would; each must fire only its own callback. */
async function expectTaskbarActionable(
  voice: VoiceState,
  callbacks: TaskbarCallbacks
): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const { startSession, askGusInput, mic, accountCenter } = expectTaskbarPresent(voice);
  const expectCalls = (calls: { start: number; gus: number; mic: number; account: number }) => {
    expect(callbacks.onStartSession).toHaveBeenCalledTimes(calls.start);
    expect(callbacks.onGusQuery).toHaveBeenCalledTimes(calls.gus);
    expect(callbacks.onVoiceActivate).toHaveBeenCalledTimes(calls.mic);
    expect(callbacks.onAccountCenterOpen).toHaveBeenCalledTimes(calls.account);
  };

  // No desktop step triggered a Taskbar action on its own.
  expectCalls({ start: 0, gus: 0, mic: 0, account: 0 });

  await user.click(startSession);
  expectCalls({ start: 1, gus: 0, mic: 0, account: 0 });

  await user.type(askGusInput, `  ${GUS_QUERY}  {Enter}`);
  expectCalls({ start: 1, gus: 1, mic: 0, account: 0 });
  expect(callbacks.onGusQuery).toHaveBeenCalledWith(GUS_QUERY);
  expect(askGusInput).toHaveValue('');

  // Without voice support the disabled mic stays inert.
  await user.click(mic);
  const micCalls = voice.isVoiceSupported ? 1 : 0;
  expectCalls({ start: 1, gus: 1, mic: micCalls, account: 0 });

  await user.click(accountCenter);
  expectCalls({ start: 1, gus: 1, mic: micCalls, account: 1 });

  // Using the controls does not take the Taskbar away either.
  expectTaskbarPresent(voice);
}

/** Undo the route and scroll offset a run leaves on the shared jsdom page. */
function resetPageState(): void {
  window.history.replaceState(null, '', '/');
  document.documentElement.scrollTop = 0;
}

describe('Feature: fmi-os, Property 7: Taskbar Persistent Visibility', () => {
  afterEach(() => {
    cleanup();
    resetPageState();
  });

  it('keeps the Taskbar visible, with all three controls actionable, in any desktop state', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ route, voice, ops }) => {
        window.history.replaceState(null, '', route);
        const callbacks: TaskbarCallbacks = {
          onStartSession: jest.fn<void, []>(),
          onGusQuery: jest.fn<void, [string]>(),
          onVoiceActivate: jest.fn<void, []>(),
          onAccountCenterOpen: jest.fn<void, []>(),
        };
        const desktop = renderDesktopWithTaskbar(voice, callbacks);

        try {
          expectDesktopState(desktop);
          for (const op of ops) {
            applyOp(desktop, op);
            expectDesktopState(desktop);
          }
          await expectTaskbarActionable(desktop.voice(), callbacks);
        } finally {
          cleanup();
          resetPageState();
        }
      }),
      { numRuns: 150 }
    );
  }, 180_000);
});
