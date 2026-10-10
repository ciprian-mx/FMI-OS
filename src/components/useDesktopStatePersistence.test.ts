import { act, renderHook } from '@testing-library/react';
import type { WindowState } from './DesktopEnvironment';
import {
  type DesktopState,
  type DesktopStateStore,
  loadDesktopState,
  saveDesktopState,
} from './desktopStatePersistence';
import { useDesktopStatePersistence } from './useDesktopStatePersistence';

/**
 * Task 2.6 — React binding for desktop state persistence (Requirements 3.5, 1.4).
 *
 * These tests cover only the hook's lifecycle wiring: restoring once on mount,
 * debouncing writes, and flushing on unmount. The validation and round-trip
 * correctness live in desktopStatePersistence.test.ts.
 */

function makeStore(initial: Record<string, string> = {}): DesktopStateStore & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function sampleWindow(overrides: Partial<WindowState> = {}): WindowState {
  return {
    appId: 'materials',
    isOpen: true,
    position: { x: 10, y: 20 },
    size: { width: 720, height: 480 },
    zIndex: 1,
    isFocused: true,
    ...overrides,
  };
}

describe('useDesktopStatePersistence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('restores the persisted snapshot once on mount', () => {
    const store = makeStore();
    const stored: DesktopState = { windows: [sampleWindow({ appId: 'stats' })] };
    saveDesktopState(stored, store);

    const { result } = renderHook(() => useDesktopStatePersistence({ store }));
    expect(result.current.initialState).toEqual(stored);
  });

  it('returns the empty default when nothing is stored', () => {
    const store = makeStore();
    const { result } = renderHook(() => useDesktopStatePersistence({ store }));
    expect(result.current.initialState).toEqual({ windows: [] });
  });

  it('debounces writes and persists only the latest state', () => {
    const store = makeStore();
    const { result } = renderHook(() =>
      useDesktopStatePersistence({ store, debounceMs: 300 })
    );

    act(() => {
      result.current.persist({ windows: [sampleWindow({ zIndex: 1 })] });
      result.current.persist({ windows: [sampleWindow({ zIndex: 2 })] });
    });
    // Nothing written before the debounce window elapses.
    expect(store.map.size).toBe(0);

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(loadDesktopState(store)).toEqual({ windows: [sampleWindow({ zIndex: 2 })] });
  });

  it('writes synchronously when debounceMs is 0', () => {
    const store = makeStore();
    const { result } = renderHook(() =>
      useDesktopStatePersistence({ store, debounceMs: 0 })
    );

    act(() => {
      result.current.persist({ windows: [sampleWindow()] });
    });

    expect(loadDesktopState(store)).toEqual({ windows: [sampleWindow()] });
  });

  it('flushes a pending write on unmount', () => {
    const store = makeStore();
    const { result, unmount } = renderHook(() =>
      useDesktopStatePersistence({ store, debounceMs: 300 })
    );

    act(() => {
      result.current.persist({ windows: [sampleWindow({ appId: 'roadmap' })] });
    });
    expect(store.map.size).toBe(0);

    act(() => {
      unmount();
    });

    expect(loadDesktopState(store)).toEqual({
      windows: [sampleWindow({ appId: 'roadmap' })],
    });
  });
});
