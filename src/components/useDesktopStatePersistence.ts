/**
 * useDesktopStatePersistence (Task 2.6, Requirements 3.5 / 1.4).
 *
 * A thin React binding over the pure {@link saveDesktopState}/
 * {@link loadDesktopState} helpers in `desktopStatePersistence.ts`. It gives
 * DesktopEnvironment a one-line way to:
 *
 *   1. Restore the previously-persisted layout once, synchronously, on mount
 *      (so the desktop reopens prior windows on page refresh / re-auth), and
 *   2. Persist the current snapshot whenever it changes, debounced to coalesce
 *      the bursts of updates that dragging/resizing a window produces.
 *
 * All validation, schema/version guarding and defensive fallbacks live in the
 * pure module; this hook only owns the React lifecycle wiring, so it stays
 * trivially correct and the testable logic remains framework-free.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DesktopState,
  type DesktopStateStore,
  loadDesktopState,
  saveDesktopState,
} from './desktopStatePersistence';

export interface UseDesktopStatePersistenceOptions {
  /**
   * Storage to persist into. Defaults (inside the pure module) to the ambient
   * `localStorage`. Injectable so tests — and a future DynamoDB-backed adapter
   * exposing the same `getItem`/`setItem`/`removeItem` surface — can swap it.
   */
  store?: DesktopStateStore | null;
  /**
   * Milliseconds to debounce writes. Dragging a window fires many state updates
   * per second; debouncing avoids thrashing storage. Defaults to 300ms. Set to
   * 0 to write synchronously on every change.
   */
  debounceMs?: number;
}

export interface UseDesktopStatePersistenceResult {
  /** The snapshot restored on mount (empty default when none was stored). */
  initialState: DesktopState;
  /**
   * Persist a new snapshot. Debounced per {@link
   * UseDesktopStatePersistenceOptions.debounceMs}. Safe to call on every
   * desktop state change.
   */
  persist: (state: DesktopState) => void;
}

/**
 * Loads the persisted desktop state once on mount and returns a debounced
 * `persist` callback for saving subsequent changes.
 *
 * Typical use inside DesktopEnvironment:
 *
 * ```tsx
 * const { initialState, persist } = useDesktopStatePersistence();
 * // seed window registry from initialState.windows on first render
 * // call persist({ windows }) from onWindowsChange
 * ```
 */
export function useDesktopStatePersistence(
  options: UseDesktopStatePersistenceOptions = {}
): UseDesktopStatePersistenceResult {
  const { store, debounceMs = 300 } = options;

  // Load exactly once, on first render, so the restored layout is available
  // synchronously before the desktop paints. The empty deps on the lazy
  // initializer keeps this from re-reading storage on every render.
  const [initialState] = useState<DesktopState>(() => loadDesktopState(store));

  // Keep the latest store in a ref so `persist`'s identity stays stable even if
  // the caller passes a new (but equivalent) store reference across renders.
  const storeRef = useRef<DesktopStateStore | null | undefined>(store);
  storeRef.current = store;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<DesktopState | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current !== null) {
      saveDesktopState(pendingRef.current, storeRef.current);
      pendingRef.current = null;
    }
  }, []);

  const persist = useCallback(
    (state: DesktopState) => {
      if (debounceMs <= 0) {
        saveDesktopState(state, storeRef.current);
        return;
      }
      pendingRef.current = state;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingRef.current !== null) {
          saveDesktopState(pendingRef.current, storeRef.current);
          pendingRef.current = null;
        }
      }, debounceMs);
    },
    [debounceMs]
  );

  // On unmount, flush any pending write so a layout change made right before
  // the component tears down (e.g. navigating away) is not lost.
  useEffect(() => flush, [flush]);

  return { initialState, persist };
}

export default useDesktopStatePersistence;
