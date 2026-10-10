import { readFileSync } from 'fs';
import { join } from 'path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import DesktopEnvironment, { DEFAULT_DESKTOP_APPS, DesktopAppId } from './DesktopEnvironment';
import Taskbar from './Taskbar';

/**
 * Feature: fmi-os, Property 6: Responsive Layout Invariant
 * **Validates: Requirements 3.6**
 *
 * *For any* viewport width W where W ≥ 1024px, the Desktop Environment SHALL
 * render without horizontal overflow, all desktop app icons SHALL remain
 * visible and clickable, and the Taskbar SHALL remain visible and fully usable.
 *
 * How the property is exercised
 * -----------------------------
 * Each run sets the viewport to a generated width W in [1024, 3840] and renders
 * the DesktopEnvironment with the real Taskbar mounted in its taskbar slot.
 *
 * jsdom has no layout engine (measured geometry such as getBoundingClientRect
 * or scrollWidth is always 0), and Jest stubs CSS imports. So the components'
 * real stylesheets are mounted into the document, and computed styles follow
 * their rules. On that basis, at every W:
 *   - No horizontal overflow: the shell is pinned to the viewport, exactly W
 *     wide, and clips horizontal overflow, so the page can never scroll
 *     sideways. No element in the desktop declares a width, min-width or offset
 *     (resolved at W) that reaches past either edge of the viewport, where it
 *     would be clipped. This holds before and after every app window is open.
 *   - Icons: all six are visible, enabled buttons showing their glyph and
 *     label. Clicking each one opens its window, and with every window open
 *     the icons still take clicks: the window layer above them lets clicks
 *     through, and nothing resolves their pointer-events to `none`.
 *   - Taskbar: the bar and its three controls are visible, enabled and take
 *     clicks, and each control works: "Start today's session", "Ask Gus" +
 *     Enter, the microphone, and the Account Center button.
 *
 * jsdom ignores viewport @media rules, so mounting the stylesheets fails if one
 * gains such a rule: the test could not see it at the generated widths.
 */

const VIEWPORT_MIN = 1024;
const VIEWPORT_MAX = 3840;
/** Browser default root font size, for resolving rem/em lengths. */
const ROOT_FONT_SIZE_PX = 16;
/** Real stylesheets of the rendered components (Jest stubs their imports). */
const STYLESHEETS = ['DesktopEnvironment.css', 'Taskbar.css'];
/** The Taskbar's three controls; "Ask Gus" is the input plus its microphone. */
const TASKBAR_CONTROL_IDS = [
  'taskbar-start-session',
  'taskbar-ask-gus-input',
  'taskbar-mic',
  'taskbar-account-center',
];
const GUS_QUESTION = 'What is on my exam next week?';

const APP_IDS: DesktopAppId[] = DEFAULT_DESKTOP_APPS.map((app) => app.id);

/** Integer viewport widths across the range Requirement 3.6 covers. */
const viewportWidthArb: fc.Arbitrary<number> = fc.integer({
  min: VIEWPORT_MIN,
  max: VIEWPORT_MAX,
});

/** All six apps in a random order, so every icon gets clicked. */
const clickOrderArb: fc.Arbitrary<DesktopAppId[]> = fc.shuffledSubarray(APP_IDS, {
  minLength: APP_IDS.length,
  maxLength: APP_IDS.length,
});

const originalInnerWidth = window.innerWidth;

/** Present a viewport `width` px wide, as a browser window of that width does. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
}

function restoreViewportWidth(): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
  // Drop the own property so the prototype's getter applies again.
  Reflect.deleteProperty(document.documentElement, 'clientWidth');
}

/**
 * Mount the components' real stylesheets so computed styles follow their
 * rules. jsdom does not evaluate viewport media queries, so a width-dependent
 * @media rule would go unseen at every generated width: fail instead of passing
 * without checking it.
 */
function mountStylesheets(): HTMLStyleElement[] {
  return STYLESHEETS.map((file) => {
    const style = document.createElement('style');
    style.dataset.stylesheet = file;
    style.textContent = readFileSync(join(__dirname, file), 'utf8');
    document.head.appendChild(style);

    const viewportQueries = Array.from(style.sheet?.cssRules ?? [])
      .map((rule) => (rule as Partial<CSSMediaRule>).media?.mediaText ?? '')
      .filter((query) => /width|aspect-ratio|orientation/i.test(query));
    if (viewportQueries.length > 0) {
      throw new Error(
        `${file} has viewport media queries jsdom does not evaluate (${viewportQueries.join('; ')}). ` +
          'Apply them at each generated width before relying on this test.'
      );
    }
    return style;
  });
}

type StyleOf = (el: Element) => CSSStyleDeclaration;

/**
 * getComputedStyle, memoized for one DOM snapshot. jsdom's version is slow:
 * every call re-matches its whole default stylesheet against the element and,
 * to resolve `visibility`, against each ancestor. Reading each element once
 * keeps the runs fast. Take a new reader after the DOM changes.
 */
function styleReader(): StyleOf {
  const cache = new Map<Element, CSSStyleDeclaration>();
  return (el) => {
    let style = cache.get(el);
    if (!style) {
      style = getComputedStyle(el);
      cache.set(el, style);
    }
    return style;
  };
}

/** A readable name for an element in failure messages. */
function describeElement(el: Element): string {
  return (
    el.getAttribute('data-testid') ??
    `${el.tagName.toLowerCase()}.${el.className} "${el.textContent ?? ''}"`
  );
}

/**
 * A declared CSS length in px at viewport width W, or null when it is not a
 * plain length (auto, calc(), min(), ...). Percentages resolve against W, an
 * upper bound for every containing block inside the full-viewport desktop.
 */
function toPx(value: string, viewportWidth: number): number | null {
  const match = /^(-?\d*\.?\d+)(px|vw|%|r?em)?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, amountText, unit = ''] = match;
  const amount = Number(amountText);
  switch (unit) {
    case 'px':
      return amount;
    case 'vw':
    case '%':
      return (amount * viewportWidth) / 100;
    case 'rem':
    case 'em':
      return amount * ROOT_FONT_SIZE_PX;
    default:
      // A unitless length is only valid as 0.
      return amount === 0 ? 0 : null;
  }
}

/** Declared left/right offsets in px, from the longhands or the `inset` shorthand. */
function horizontalOffsets(
  style: CSSStyleDeclaration,
  viewportWidth: number
): { left: number | null; right: number | null } {
  // inset: top [right [bottom [left]]], where right defaults to top and left to right.
  const inset = style.getPropertyValue('inset').split(/\s+/).filter(Boolean);
  const insetRight = inset[1] ?? inset[0] ?? '';
  const insetLeft = inset[3] ?? insetRight;
  return {
    left: toPx(style.left || insetLeft, viewportWidth),
    right: toPx(style.right || insetRight, viewportWidth),
  };
}

/** The shell is pinned to the viewport, exactly W wide, and clips horizontal overflow. */
function expectViewportBoundShell(style: CSSStyleDeclaration, viewportWidth: number): void {
  expect(style.position).toBe('fixed');
  expect(horizontalOffsets(style, viewportWidth)).toEqual({ left: 0, right: 0 });
  expect(toPx(style.width, viewportWidth)).toBe(viewportWidth);
  // overflow-x, or the first value of the `overflow` shorthand.
  expect(style.overflowX || style.overflow.split(/\s+/)[0]).toMatch(/^(hidden|clip)$/);
}

/**
 * Elements whose declared horizontal box (stylesheet + inline, resolved at W)
 * reaches past either edge of the viewport. The desktop's positioned
 * containers (shell, surface, window layer, taskbar slot) all start at the
 * viewport's left edge, so offsets are measured against [0, W].
 */
function horizontalOverflowOffenders(
  root: Element,
  viewportWidth: number,
  styleOf: StyleOf
): string[] {
  const offenders: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const style = styleOf(el);
    const span = Math.max(
      toPx(style.width, viewportWidth) ?? 0,
      toPx(style.minWidth, viewportWidth) ?? 0
    );
    const { left, right } = horizontalOffsets(style, viewportWidth);
    const fits = (offset: number | null): boolean =>
      offset === null || (offset >= 0 && offset + span <= viewportWidth);
    if (span > viewportWidth || !fits(left) || !fits(right)) {
      offenders.push(
        `${describeElement(el)}: span ${span}px, left ${left ?? 'auto'}, right ${right ?? 'auto'}`
      );
    }
  }
  return offenders;
}

/**
 * Elements that are not visible: hidden by display, visibility, opacity or the
 * `hidden` attribute, on themselves or on any ancestor. These are jest-dom's
 * toBeVisible rules (the desktop has no <details>), read through the memoized
 * styles instead of toBeVisible's fresh getComputedStyle per ancestor.
 */
function hiddenElements(elements: Element[], styleOf: StyleOf): string[] {
  const hidesItself = (node: Element): boolean => {
    const { display, visibility, opacity } = styleOf(node);
    return (
      node.hasAttribute('hidden') ||
      display === 'none' ||
      visibility === 'hidden' ||
      visibility === 'collapse' ||
      opacity === '0'
    );
  };
  return elements
    .filter((el) => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (hidesItself(node)) {
          return true;
        }
      }
      return false;
    })
    .map(describeElement);
}

/**
 * Elements whose pointer-events resolve to `none` (the property inherits), so
 * they cannot take clicks. userEvent refuses to click them; fireEvent does not
 * check, so the tests check explicitly.
 */
function unclickableElements(elements: Element[], styleOf: StyleOf): string[] {
  const pointerEventsOf = (el: Element): string => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const value = styleOf(node).pointerEvents;
      if (value && value !== 'inherit' && value !== 'unset') {
        return value;
      }
    }
    return 'auto';
  };
  return elements.filter((el) => pointerEventsOf(el) === 'none').map(describeElement);
}

describe('Feature: fmi-os, Property 6: Responsive Layout Invariant', () => {
  let stylesheets: HTMLStyleElement[] = [];

  beforeAll(() => {
    stylesheets = mountStylesheets();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    stylesheets.forEach((style) => style.remove());
    restoreViewportWidth();
  });

  it('renders without horizontal overflow, with all six icons and the Taskbar visible, at any width >= 1024px', () => {
    fc.assert(
      fc.property(viewportWidthArb, (viewportWidth) => {
        setViewportWidth(viewportWidth);
        render(<DesktopEnvironment taskbarSlot={<Taskbar />} />);

        try {
          const styleOf = styleReader();

          // No horizontal overflow: the shell bounds the page to the viewport,
          // and nothing inside it reaches past the viewport's edges.
          const shell = screen.getByTestId('desktop-environment');
          expectViewportBoundShell(styleOf(shell), viewportWidth);
          expect(horizontalOverflowOffenders(shell, viewportWidth, styleOf)).toEqual([]);

          // All six icons are enabled buttons showing their glyph and label.
          const surface = within(shell).getByTestId('desktop-surface');
          expect(within(surface).getAllByTestId(/^desktop-icon-/)).toHaveLength(
            DEFAULT_DESKTOP_APPS.length
          );
          const iconParts = DEFAULT_DESKTOP_APPS.flatMap((app) => {
            const icon = within(surface).getByTestId(`desktop-icon-${app.id}`);
            expect(icon.tagName).toBe('BUTTON');
            expect(icon).toBeEnabled();
            return [icon, within(icon).getByText(app.glyph), within(icon).getByText(app.name)];
          });

          // The Taskbar's three controls are enabled.
          const taskbar = screen.getByTestId('taskbar');
          const controls = TASKBAR_CONTROL_IDS.map((id) => within(taskbar).getByTestId(id));
          controls.forEach((control) => expect(control).toBeEnabled());

          // ...and the desktop, every icon part, the Taskbar and its controls
          // are visible.
          expect(
            hiddenElements(
              [
                shell,
                surface,
                ...iconParts,
                screen.getByTestId('desktop-taskbar-slot'),
                taskbar,
                ...controls,
              ],
              styleOf
            )
          ).toEqual([]);
        } finally {
          cleanup();
        }
      }),
      { numRuns: 150 }
    );
  }, 60_000);

  it('keeps every app icon clickable and every Taskbar control usable at any width >= 1024px', () => {
    fc.assert(
      fc.property(viewportWidthArb, clickOrderArb, (viewportWidth, clickOrder) => {
        setViewportWidth(viewportWidth);
        const onStartSession = jest.fn();
        const onGusQuery = jest.fn();
        const onVoiceActivate = jest.fn();
        const onAccountCenterOpen = jest.fn();
        render(
          <DesktopEnvironment
            taskbarSlot={
              <Taskbar
                onStartSession={onStartSession}
                onGusQuery={onGusQuery}
                onVoiceActivate={onVoiceActivate}
                onAccountCenterOpen={onAccountCenterOpen}
              />
            }
          />
        );

        try {
          // Every icon opens its window when clicked.
          for (const appId of clickOrder) {
            expect(screen.queryByTestId(`window-${appId}`)).not.toBeInTheDocument();
            fireEvent.click(screen.getByTestId(`desktop-icon-${appId}`));
            expect(screen.getByTestId(`window-${appId}`)).toBeInTheDocument();
          }

          // With every window open, the windows are visible and nothing reaches
          // past the viewport's edges.
          const styleOf = styleReader();
          const shell = screen.getByTestId('desktop-environment');
          const windows = APP_IDS.map((appId) => screen.getByTestId(`window-${appId}`));
          expect(hiddenElements(windows, styleOf)).toEqual([]);
          expect(horizontalOverflowOffenders(shell, viewportWidth, styleOf)).toEqual([]);

          // The icons and Taskbar controls still take clicks. The window layer
          // covers the desktop above the icons, so it must let clicks through
          // (jsdom cannot hit-test, so this checks the rule that does it).
          expect(styleOf(screen.getByTestId('desktop-window-layer')).pointerEvents).toBe('none');
          const icons = APP_IDS.map((appId) => screen.getByTestId(`desktop-icon-${appId}`));
          const controls = TASKBAR_CONTROL_IDS.map((id) => screen.getByTestId(id));
          expect(unclickableElements([...icons, ...controls], styleOf)).toEqual([]);

          // Every Taskbar control does its job.
          fireEvent.click(screen.getByTestId('taskbar-start-session'));
          expect(onStartSession).toHaveBeenCalledTimes(1);

          const askGus = screen.getByTestId('taskbar-ask-gus-input');
          fireEvent.change(askGus, { target: { value: GUS_QUESTION } });
          fireEvent.keyDown(askGus, { key: 'Enter' });
          expect(onGusQuery.mock.calls).toEqual([[GUS_QUESTION]]);

          fireEvent.click(screen.getByTestId('taskbar-mic'));
          expect(onVoiceActivate).toHaveBeenCalledTimes(1);

          fireEvent.click(screen.getByTestId('taskbar-account-center'));
          expect(onAccountCenterOpen).toHaveBeenCalledTimes(1);
        } finally {
          cleanup();
        }
      }),
      { numRuns: 100 }
    );
  }, 60_000);
});
