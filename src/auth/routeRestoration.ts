/**
 * Route restoration across session-token expiry (Task 1.5, Requirements 1.4).
 *
 * When a Student's Cognito session token can no longer be refreshed, FMI OS
 * redirects to the login screen. Per Requirement 1.4 the Student's last
 * location must be preserved so that, after a successful re-authentication, the
 * app can send them straight back to where they were instead of dropping them
 * on a default desktop.
 *
 * This module is the small, framework-agnostic persistence layer for that
 * "intended route". It deliberately depends only on `sessionStorage` (as called
 * out in design.md — Auth Flow and task 1.5) and never on a router, so it stays
 * trivially unit-testable and reusable whether or not a router is later added.
 *
 * `sessionStorage` (rather than `localStorage`) is the right scope: an expired
 * session is a within-tab, short-lived condition. The pending route should not
 * leak across browser restarts or bleed into other tabs, and it is naturally
 * cleared when the tab closes.
 */

/** Storage key under which the pending post-login route is stored. */
export const INTENDED_ROUTE_STORAGE_KEY = 'fmi-os:intended-route';

/**
 * The default route restored to when there is no saved location (or the saved
 * value is unusable). The desktop root.
 */
export const DEFAULT_RESTORE_ROUTE = '/';

/**
 * Minimal subset of the Web Storage API this module needs. Accepting this
 * interface (rather than reaching for the global `sessionStorage` directly)
 * keeps the helper injectable in tests and resilient to environments where
 * storage is unavailable.
 */
export interface RouteStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Resolves the storage to use. Defaults to the ambient `sessionStorage` when
 * available, and otherwise returns `null` so callers degrade gracefully (e.g.
 * SSR, privacy modes that throw on access, or test environments without DOM
 * storage).
 */
function resolveStore(store?: RouteStore | null): RouteStore | null {
  if (store !== undefined) {
    return store;
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage;
    }
  } catch {
    // Accessing sessionStorage can throw in some locked-down browser modes.
  }
  return null;
}

/**
 * Normalizes a candidate location into an in-app route string, or returns
 * `null` if it cannot be used safely.
 *
 * Accepts a path (optionally with query string and hash). Rejects values that
 * are empty, not root-relative, or that look like an absolute/protocol URL —
 * guarding against an attacker-planted storage value turning a restore into an
 * open redirect to an external origin.
 */
export function normalizeRoute(candidate: unknown): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Must be root-relative. Reject absolute URLs ("http://..."), protocol-
  // relative URLs ("//evil.com"), and backslash variants browsers may coerce.
  if (!trimmed.startsWith('/')) {
    return null;
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return null;
  }
  if (trimmed.includes('\\')) {
    return null;
  }

  return trimmed;
}

/**
 * Reads the current in-app location (pathname + search + hash) from a
 * `Location`-like object, defaulting to the ambient `window.location`.
 *
 * Returns `null` when no location is available (non-browser environments).
 */
export function getCurrentRoute(
  location?: Pick<Location, 'pathname' | 'search' | 'hash'> | null
): string | null {
  const loc =
    location === undefined
      ? typeof window !== 'undefined'
        ? window.location
        : null
      : location;

  if (!loc) {
    return null;
  }

  const path = `${loc.pathname ?? ''}${loc.search ?? ''}${loc.hash ?? ''}`;
  return normalizeRoute(path);
}

/**
 * Persists the Student's intended post-login route.
 *
 * Called at the moment a non-refreshable session is detected, before the
 * redirect to `/login`. A `null`/invalid route is treated as "nothing worth
 * restoring" and clears any previously saved value so a stale route is never
 * resurrected on the next login.
 *
 * Login/registration routes are intentionally not saved: restoring to them
 * after login would be pointless (or a redirect loop).
 */
export function saveIntendedRoute(
  route: string | null,
  store?: RouteStore | null
): void {
  const target = resolveStore(store);
  if (!target) {
    return;
  }

  const normalized = normalizeRoute(route);
  if (normalized === null || isAuthRoute(normalized)) {
    try {
      target.removeItem(INTENDED_ROUTE_STORAGE_KEY);
    } catch {
      // Best-effort; nothing actionable if storage write fails.
    }
    return;
  }

  try {
    target.setItem(INTENDED_ROUTE_STORAGE_KEY, normalized);
  } catch {
    // Best-effort; a failure here only means we fall back to the default
    // restore route after login, which is acceptable.
  }
}

/**
 * Convenience wrapper that captures the *current* route (from `window.location`
 * by default) and persists it. This is what the expiry handler calls.
 */
export function saveCurrentRoute(
  location?: Pick<Location, 'pathname' | 'search' | 'hash'> | null,
  store?: RouteStore | null
): void {
  saveIntendedRoute(getCurrentRoute(location), store);
}

/**
 * Reads the saved intended route without consuming it. Returns `null` when no
 * valid route is stored.
 */
export function peekIntendedRoute(store?: RouteStore | null): string | null {
  const target = resolveStore(store);
  if (!target) {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = target.getItem(INTENDED_ROUTE_STORAGE_KEY);
  } catch {
    return null;
  }
  return normalizeRoute(raw);
}

/**
 * Reads *and clears* the saved intended route, returning it (or
 * {@link DEFAULT_RESTORE_ROUTE} when none is stored).
 *
 * This is the restore side of the flow, invoked after a successful sign-in. It
 * consumes the value so a single expiry→login cycle restores exactly once; a
 * later ordinary navigation will not be hijacked by a stale saved route.
 */
export function consumeIntendedRoute(store?: RouteStore | null): string {
  const target = resolveStore(store);
  const route = peekIntendedRoute(target);

  if (target) {
    try {
      target.removeItem(INTENDED_ROUTE_STORAGE_KEY);
    } catch {
      // Ignore; the next save/consume cycle will overwrite anyway.
    }
  }

  return route ?? DEFAULT_RESTORE_ROUTE;
}

/**
 * Clears any saved intended route. Used, for example, on an explicit logout so
 * the next login starts from the default route rather than restoring the
 * location the Student had before deliberately signing out.
 */
export function clearIntendedRoute(store?: RouteStore | null): void {
  const target = resolveStore(store);
  if (!target) {
    return;
  }
  try {
    target.removeItem(INTENDED_ROUTE_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

/** Routes that must never be used as a restore target. */
const AUTH_ROUTE_PREFIXES = ['/login', '/register'];

/** True when `route` points at the login or registration screens. */
export function isAuthRoute(route: string): boolean {
  const path = route.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return AUTH_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}
