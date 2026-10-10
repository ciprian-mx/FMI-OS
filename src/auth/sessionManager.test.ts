import {
  AUTH_EVENTS,
  LOGIN_ROUTE,
  handleAuthEvent,
  startSessionManager,
  type AuthHub,
  type AuthHubCapsule,
} from './sessionManager';
import {
  INTENDED_ROUTE_STORAGE_KEY,
  type RouteStore,
} from './routeRestoration';

/**
 * Task 1.5 — session-expiry handling with route restoration (Requirements 1.4).
 *
 * These tests drive the Hub-event decision logic with injected mocks (no live
 * Cognito, no router): a token-refresh failure must save the current location
 * and redirect to /login; a subsequent sign-in must restore the saved route.
 */

function makeStore(initial: Record<string, string> = {}): RouteStore & {
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

function capsule(event: string): AuthHubCapsule {
  return { payload: { event } };
}

describe('handleAuthEvent', () => {
  it('on tokenRefresh_failure: saves current route then redirects to /login', () => {
    const store = makeStore();
    const redirect = jest.fn();
    const onRestore = jest.fn();
    const getLocation = () => ({
      pathname: '/materials',
      search: '?folder=week3',
      hash: '',
    });

    const result = handleAuthEvent(capsule(AUTH_EVENTS.TOKEN_REFRESH_FAILURE), {
      redirect,
      getLocation,
      onRestore,
      store,
    });

    expect(store.map.get(INTENDED_ROUTE_STORAGE_KEY)).toBe(
      '/materials?folder=week3'
    );
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
    expect(onRestore).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'expired', route: LOGIN_ROUTE });
  });

  it('on signedIn: restores and consumes the saved route', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/stats' });
    const redirect = jest.fn();
    const onRestore = jest.fn();

    const result = handleAuthEvent(capsule(AUTH_EVENTS.SIGNED_IN), {
      redirect,
      getLocation: () => null,
      onRestore,
      store,
    });

    expect(onRestore).toHaveBeenCalledWith('/stats');
    // Consumed: not left behind for a second restore.
    expect(store.map.has(INTENDED_ROUTE_STORAGE_KEY)).toBe(false);
    expect(result).toEqual({ action: 'restored', route: '/stats' });
  });

  it('on signedIn with nothing saved: restores to default route', () => {
    const store = makeStore();
    const onRestore = jest.fn();

    handleAuthEvent(capsule(AUTH_EVENTS.SIGNED_IN), {
      redirect: jest.fn(),
      getLocation: () => null,
      onRestore,
      store,
    });

    expect(onRestore).toHaveBeenCalledWith('/');
  });

  it('on signedOut: clears any saved route', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/x' });

    const result = handleAuthEvent(capsule(AUTH_EVENTS.SIGNED_OUT), {
      redirect: jest.fn(),
      getLocation: () => null,
      onRestore: jest.fn(),
      store,
    });

    expect(store.map.has(INTENDED_ROUTE_STORAGE_KEY)).toBe(false);
    expect(result.action).toBe('cleared');
  });

  it('ignores unrelated auth events', () => {
    const redirect = jest.fn();
    const onRestore = jest.fn();
    const result = handleAuthEvent(capsule('autoSignIn_failure'), {
      redirect,
      getLocation: () => null,
      onRestore,
      store: makeStore(),
    });
    expect(redirect).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(result.action).toBe('ignored');
  });
});

describe('startSessionManager (full expiry → relogin → restore cycle)', () => {
  it('wires Hub events to redirect and restoration via a fake Hub', () => {
    const store = makeStore();
    const redirect = jest.fn();
    const onRestore = jest.fn();
    let listener: ((c: AuthHubCapsule) => void) | null = null;
    const unsubscribe = jest.fn();

    const hub: AuthHub = {
      listen: (_channel, cb) => {
        listener = cb;
        return unsubscribe;
      },
    };

    const stop = startSessionManager({
      hub,
      redirect,
      onRestore,
      store,
      getLocation: () => ({ pathname: '/roadmap', search: '', hash: '' }),
    });

    expect(listener).not.toBeNull();

    // 1. Token refresh fails while on /roadmap.
    listener!(capsule(AUTH_EVENTS.TOKEN_REFRESH_FAILURE));
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
    expect(store.map.get(INTENDED_ROUTE_STORAGE_KEY)).toBe('/roadmap');

    // 2. Student re-authenticates.
    listener!(capsule(AUTH_EVENTS.SIGNED_IN));
    expect(onRestore).toHaveBeenCalledWith('/roadmap');

    // Teardown unsubscribes from the Hub.
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('defaults onRestore to a redirect when none is supplied', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/stats' });
    const redirect = jest.fn();
    let listener: ((c: AuthHubCapsule) => void) | null = null;

    const hub: AuthHub = {
      listen: (_channel, cb) => {
        listener = cb;
        return () => undefined;
      },
    };

    startSessionManager({ hub, redirect, store, getLocation: () => null });
    listener!(capsule(AUTH_EVENTS.SIGNED_IN));

    expect(redirect).toHaveBeenCalledWith('/stats');
  });
});
