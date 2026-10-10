import { act, cleanup, renderHook } from '@testing-library/react';
import fc from 'fast-check';
import type { WindowState } from './DesktopEnvironment';
import {
  DESKTOP_STATE_STORAGE_KEY,
  VALID_DESKTOP_APP_IDS,
  type DesktopLayout,
  type DesktopState,
} from './desktopStatePersistence';
import { useDesktopStatePersistence } from './useDesktopStatePersistence';

/**
 * Feature: fmi-os, Property 5: State Persistence Round-Trip
 *
 * **Validates: Requirements 3.5**
 *
 * Property 5 (design.md): *For any* Desktop Environment state S (window
 * positions, sizes, open apps, focused app), persisting S and then restoring it
 * (via page refresh or re-authentication) SHALL produce an equivalent state S'
 * where all windows are in the same positions, have the same sizes, and the
 * same app focus.
 *
 * The round-trip goes through the seam the desktop persists with —
 * `useDesktopStatePersistence` over its default store, the real (jsdom)
 * `localStorage` — rather than calling the save/load helpers directly. Each run:
 *
 *   1. mounts a desktop session and persists S through the (debounced) `persist`;
 *   2. ends that session through one of the two restore paths the property names:
 *      - page refresh: the debounce settles and the write lands, then the page
 *        reloads. React never unmounts on unload, so nothing is flushed — the
 *        next page sees only what is already in storage;
 *      - re-authentication: token expiry redirects to /login, tearing the
 *        desktop down at once; unmounting flushes any pending write;
 *   3. mounts a fresh session on the same storage and asserts that its restored
 *      `initialState` deep-equals S.
 */

/**
 * A pixel value as the UI produces it: integral (seeded cascade positions,
 * default sizes) or fractional (pointer drags report sub-pixel clientX/clientY
 * on zoomed or high-DPI displays). Non-negative, as WindowPanel clamps drags to
 * the viewport origin; this also keeps -0 out, which JSON cannot represent and
 * no window position uses.
 */
const pixelArb = (min: number, max: number): fc.Arbitrary<number> =>
  fc.oneof(fc.integer({ min, max }), fc.double({ min, max, noNaN: true }));

/** Per-window facets; app id, z-order and focus are assigned at state level. */
const windowFacetsArb = fc.record({
  isOpen: fc.boolean(),
  position: fc.record({ x: pixelArb(0, 10_000), y: pixelArb(0, 10_000) }),
  size: fc.record({ width: pixelArb(1, 10_000), height: pixelArb(1, 10_000) }),
  // Strictly positive gap above the window below, so z-indices stay distinct.
  zGap: fc.integer({ min: 1, max: 1_000 }),
});

/** Optional free-form layout: a JSON-serializable object of scalar settings. */
const layoutArb: fc.Arbitrary<DesktopLayout> = fc.dictionary(
  fc.string(),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
);

/**
 * An arbitrary desktop state honouring the invariants DesktopEnvironment keeps:
 *   - at most one window per app (the registry is keyed by app id): a random
 *     subset of the six valid apps, 0..6 windows, in random back-to-front order;
 *   - distinct z-indices increasing along the array (windows are emitted in
 *     z-order);
 *   - at most one focused window, and focus implies open.
 */
const desktopStateArb: fc.Arbitrary<DesktopState> = fc
  .record({
    appIds: fc.shuffledSubarray([...VALID_DESKTOP_APP_IDS]),
    facets: fc.array(windowFacetsArb, {
      minLength: VALID_DESKTOP_APP_IDS.length,
      maxLength: VALID_DESKTOP_APP_IDS.length,
    }),
    // Focus target; when it names an app without a window, nothing is focused.
    focusedApp: fc.option(fc.constantFrom(...VALID_DESKTOP_APP_IDS), { nil: null }),
    layout: fc.option(layoutArb, { nil: undefined }),
  })
  .map(({ appIds, facets, focusedApp, layout }): DesktopState => {
    let zIndex = 0;
    const windows = appIds.map((appId, i): WindowState => {
      const { isOpen, position, size, zGap } = facets[i];
      zIndex += zGap;
      const isFocused = appId === focusedApp;
      return { appId, isOpen: isOpen || isFocused, position, size, zIndex, isFocused };
    });
    return layout === undefined ? { windows } : { windows, layout };
  });

type RestorePath = 'page-refresh' | 're-authentication';

const restorePathArb: fc.Arbitrary<RestorePath> = fc.constantFrom(
  'page-refresh',
  're-authentication'
);

/** Write debounce; 0 exercises the hook's synchronous-write path. */
const debounceMsArb = fc.integer({ min: 0, max: 1_000 });

describe('Feature: fmi-os, Property 5: State Persistence Round-Trip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
    localStorage.clear();
  });

  it('restores any desktop state exactly after a page refresh or re-authentication (Validates: Requirements 3.5)', () => {
    fc.assert(
      fc.property(
        desktopStateArb,
        restorePathArb,
        debounceMsArb,
        (original, restorePath, debounceMs) => {
          // Every run starts from a browser with nothing persisted.
          localStorage.clear();

          try {
            // Session 1: the desktop persists S on change.
            const session = renderHook(() => useDesktopStatePersistence({ debounceMs }));
            act(() => {
              session.result.current.persist(original);
            });

            if (restorePath === 'page-refresh') {
              // Let the debounce settle; the reload itself flushes nothing.
              act(() => {
                jest.advanceTimersByTime(debounceMs);
              });
            } else {
              // Redirect to /login unmounts the desktop immediately.
              session.unmount();
            }

            // S is durably stored before the next page/session reads it (this
            // keeps the empty-desktop case from passing vacuously).
            expect(localStorage.getItem(DESKTOP_STATE_STORAGE_KEY)).not.toBeNull();

            // Session 2: a fresh mount restores from storage (Requirement 3.5).
            const restoredSession = renderHook(() =>
              useDesktopStatePersistence({ debounceMs })
            );
            const restored = restoredSession.result.current.initialState;

            // S' ≡ S: the same windows in the same z-order, each with the same
            // position, size, open flag, z-index and focus, plus the same layout.
            expect(restored).toEqual(original);
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
