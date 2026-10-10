/**
 * Session token expiry handling with route restoration (Task 1.5,
 * Requirements 1.4).
 *
 * Design (design.md — Auth Flow): "Amplify Auth silently refreshes; on failure,
 * redirects to `/login` with last desktop state stored." Concretely, this
 * module listens to the Amplify Auth Hub channel and reacts to the two events
 * that matter for session continuity:
 *
 *  - `tokenRefresh_failure` — the 1-hour access token could not be silently
 *    refreshed (refresh token expired/revoked). We capture the Student's
 *    current location, then redirect to `/login`.
 *  - `signedIn` — a (re-)authentication succeeded. We consume the saved
 *    location and restore the Student to it.
 *
 * Everything the module touches at runtime — the Hub, the redirect, the current
 * location, and the storage — is injected through {@link SessionManagerDeps}.
 * That keeps the whole flow unit-testable with plain mocks (no live Cognito and
 * no router required) while defaulting to the real Amplify Hub and
 * `window`/`sessionStorage` in production.
 */
import { Hub } from 'aws-amplify/utils';

import {
  consumeIntendedRoute,
  saveCurrentRoute,
  clearIntendedRoute,
  type RouteStore,
} from './routeRestoration';

/** The login route the Student is sent to when a session cannot be refreshed. */
export const LOGIN_ROUTE = '/login';

/**
 * The Amplify Auth Hub event names this manager reacts to. Centralised so the
 * strings are not duplicated and the set of handled events is explicit.
 */
export const AUTH_EVENTS = {
  TOKEN_REFRESH_FAILURE: 'tokenRefresh_failure',
  SIGNED_IN: 'signedIn',
  SIGNED_OUT: 'signedOut',
} as const;

/** Shape of a single Amplify Hub auth payload we care about. */
export interface AuthHubCapsule {
  payload: {
    event: string;
    data?: unknown;
    message?: string;
  };
}

/** A function matching Amplify `Hub.listen`'s return value (the unsubscribe). */
export type HubUnsubscribe = () => void;

/**
 * The narrow slice of the Amplify `Hub` API this module uses. Declaring it as
 * an interface lets tests pass a fake Hub without importing Amplify.
 */
export interface AuthHub {
  listen(
    channel: 'auth',
    callback: (capsule: AuthHubCapsule) => void
  ): HubUnsubscribe;
}

/** Abstraction over "send the browser to this route". */
export type Redirect = (route: string) => void;

/** Abstraction over "read the current in-app location". */
export type CurrentLocationProvider = () =>
  | Pick<Location, 'pathname' | 'search' | 'hash'>
  | null;

/** Injectable dependencies; every field defaults to a real browser/Amplify impl. */
export interface SessionManagerDeps {
  /** The Hub to subscribe to. Defaults to Amplify's Hub. */
  hub?: AuthHub;
  /** How to redirect. Defaults to assigning `window.location`. */
  redirect?: Redirect;
  /** How to read the current location. Defaults to `window.location`. */
  getLocation?: CurrentLocationProvider;
  /** Where to persist/restore the intended route. Defaults to `sessionStorage`. */
  store?: RouteStore | null;
  /**
   * Called after a successful sign-in with the route to restore to. Supply this
   * to perform in-app navigation (e.g. hand off to a router). When omitted, the
   * manager performs a redirect to the restored route via {@link redirect}.
   */
  onRestore?: (route: string) => void;
}

/** Default redirect: hard navigation via the browser location bar. */
const defaultRedirect: Redirect = (route) => {
  if (typeof window !== 'undefined' && window.location) {
    window.location.assign(route);
  }
};

/** Default location provider: the ambient `window.location`. */
const defaultGetLocation: CurrentLocationProvider = () =>
  typeof window !== 'undefined' ? window.location : null;

/**
 * Handles a single auth Hub event. Exported for direct unit testing of the
 * decision logic without having to drive it through a Hub subscription.
 *
 * Returns a small descriptor of what action was taken, which is handy both for
 * tests and for optional logging/telemetry by callers.
 */
export function handleAuthEvent(
  capsule: AuthHubCapsule,
  deps: Required<
    Pick<SessionManagerDeps, 'redirect' | 'getLocation' | 'onRestore'>
  > & { store?: RouteStore | null }
): { action: 'expired' | 'restored' | 'cleared' | 'ignored'; route?: string } {
  const event = capsule?.payload?.event;

  switch (event) {
    case AUTH_EVENTS.TOKEN_REFRESH_FAILURE: {
      // Session cannot be refreshed: remember where we were, then bounce to
      // login. Saving before redirecting guarantees the location is captured
      // even if the redirect synchronously tears down the page.
      const location = deps.getLocation();
      saveCurrentRoute(location, deps.store);
      deps.redirect(LOGIN_ROUTE);
      return { action: 'expired', route: LOGIN_ROUTE };
    }

    case AUTH_EVENTS.SIGNED_IN: {
      // (Re-)authentication succeeded. Restore the saved location (consuming it
      // so it only applies once) and let the caller navigate.
      const route = consumeIntendedRoute(deps.store);
      deps.onRestore(route);
      return { action: 'restored', route };
    }

    case AUTH_EVENTS.SIGNED_OUT: {
      // An explicit sign-out should not later restore the pre-logout location.
      clearIntendedRoute(deps.store);
      return { action: 'cleared' };
    }

    default:
      return { action: 'ignored' };
  }
}

/**
 * Subscribes to the Amplify Auth Hub and wires session-expiry → login redirect
 * and sign-in → route restoration.
 *
 * Returns an unsubscribe function; call it on teardown (e.g. a React effect
 * cleanup) to stop listening.
 *
 * @example
 *   useEffect(() => startSessionManager(), []);
 */
export function startSessionManager(
  deps: SessionManagerDeps = {}
): HubUnsubscribe {
  const hub = deps.hub ?? (Hub as unknown as AuthHub);
  const redirect = deps.redirect ?? defaultRedirect;
  const getLocation = deps.getLocation ?? defaultGetLocation;
  const store = deps.store;
  // When no explicit restore handler is given, restoring means navigating the
  // browser to the saved route.
  const onRestore = deps.onRestore ?? ((route: string) => redirect(route));

  return hub.listen('auth', (capsule) => {
    handleAuthEvent(capsule, { redirect, getLocation, onRestore, store });
  });
}
