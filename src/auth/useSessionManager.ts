/**
 * React binding for the session-expiry / route-restoration manager
 * (Task 1.5, Requirements 1.4).
 *
 * `useSessionManager` mounts the Amplify Auth Hub listener for the lifetime of
 * the component that calls it (typically the app root), and tears it down on
 * unmount. It is a thin wrapper over {@link startSessionManager}; all the
 * decision logic and its mockable seams live in `sessionManager.ts`, so this
 * hook stays trivial and the behaviour is tested there without React.
 */
import { useEffect } from 'react';

import {
  startSessionManager,
  type SessionManagerDeps,
} from './sessionManager';

/**
 * Subscribe to session-expiry handling for as long as this component is
 * mounted.
 *
 * Pass {@link SessionManagerDeps} to inject a redirect/navigation strategy
 * (e.g. a router's `navigate`) via `onRestore`/`redirect`, or to supply mocks
 * in tests. With no arguments it uses the real Amplify Hub and browser
 * navigation.
 *
 * The dependencies are intentionally not part of the effect's dependency array:
 * the manager is a mount-once subscription, and callers are expected to pass a
 * stable `deps` object (or none). This mirrors how an auth listener should
 * behave — one subscription per app session, not one per render.
 */
export function useSessionManager(deps: SessionManagerDeps = {}): void {
  useEffect(() => {
    const unsubscribe = startSessionManager(deps);
    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
