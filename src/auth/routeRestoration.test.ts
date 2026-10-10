import fc from 'fast-check';
import {
  DEFAULT_RESTORE_ROUTE,
  INTENDED_ROUTE_STORAGE_KEY,
  clearIntendedRoute,
  consumeIntendedRoute,
  getCurrentRoute,
  isAuthRoute,
  normalizeRoute,
  peekIntendedRoute,
  saveCurrentRoute,
  saveIntendedRoute,
  type RouteStore,
} from './routeRestoration';

/**
 * Task 1.5 — route restoration persistence layer (Requirements 1.4).
 *
 * These tests exercise the sessionStorage-backed "intended route" helper in
 * isolation: normalisation/safety of candidate routes, save/peek/consume
 * round-trips, and the auth-route guard. The manager wiring (Hub events →
 * redirect/restore) is covered in sessionManager.test.ts.
 */

/** Simple in-memory RouteStore for deterministic, isolated tests. */
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

describe('normalizeRoute', () => {
  it('accepts a plain root-relative path', () => {
    expect(normalizeRoute('/materials')).toBe('/materials');
  });

  it('preserves query string and hash', () => {
    expect(normalizeRoute('/stats?tab=grades#top')).toBe(
      '/stats?tab=grades#top'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRoute('   /roadmap   ')).toBe('/roadmap');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a string', 123 as unknown as string],
    ['relative without leading slash', 'materials'],
    ['absolute http url', 'http://evil.com/x'],
    ['protocol-relative url', '//evil.com'],
    ['backslash escape', '/\\evil.com'],
    ['embedded backslash', '/a\\b'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeRoute(input)).toBeNull();
  });
});

describe('getCurrentRoute', () => {
  it('composes pathname + search + hash', () => {
    expect(
      getCurrentRoute({ pathname: '/stats', search: '?a=1', hash: '#x' })
    ).toBe('/stats?a=1#x');
  });

  it('returns null when no location is available', () => {
    expect(getCurrentRoute(null)).toBeNull();
  });
});

describe('isAuthRoute', () => {
  it.each(['/login', '/login/', '/register', '/login?next=/x'])(
    'treats %s as an auth route',
    (route) => {
      expect(isAuthRoute(route)).toBe(true);
    }
  );

  it.each(['/', '/materials', '/stats'])(
    'treats %s as a normal route',
    (route) => {
      expect(isAuthRoute(route)).toBe(false);
    }
  );
});

describe('save / peek / consume round-trip', () => {
  it('saves a valid current route and reads it back', () => {
    const store = makeStore();
    saveCurrentRoute({ pathname: '/materials', search: '', hash: '' }, store);
    expect(store.map.get(INTENDED_ROUTE_STORAGE_KEY)).toBe('/materials');
    expect(peekIntendedRoute(store)).toBe('/materials');
  });

  it('consume returns the saved route then clears it', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/stats' });
    expect(consumeIntendedRoute(store)).toBe('/stats');
    expect(peekIntendedRoute(store)).toBeNull();
    // A second consume falls back to the default.
    expect(consumeIntendedRoute(store)).toBe(DEFAULT_RESTORE_ROUTE);
  });

  it('does not persist an auth route (avoids restore loops)', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/old' });
    saveIntendedRoute('/login', store);
    // Previous value is cleared rather than replaced with the auth route.
    expect(store.map.has(INTENDED_ROUTE_STORAGE_KEY)).toBe(false);
  });

  it('clears a previously saved route when given an invalid one', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/old' });
    saveIntendedRoute('http://evil.com', store);
    expect(store.map.has(INTENDED_ROUTE_STORAGE_KEY)).toBe(false);
  });

  it('clearIntendedRoute removes any saved value', () => {
    const store = makeStore({ [INTENDED_ROUTE_STORAGE_KEY]: '/x' });
    clearIntendedRoute(store);
    expect(store.map.has(INTENDED_ROUTE_STORAGE_KEY)).toBe(false);
  });

  it('degrades gracefully when storage is unavailable', () => {
    expect(() => saveIntendedRoute('/x', null)).not.toThrow();
    expect(peekIntendedRoute(null)).toBeNull();
    expect(consumeIntendedRoute(null)).toBe(DEFAULT_RESTORE_ROUTE);
  });
});

describe('property: valid routes survive a save→consume round-trip', () => {
  // Root-relative path segments made of URL-safe characters, no backslashes.
  const safePath = fc
    .array(
      fc.stringMatching(/^[A-Za-z0-9._~-]+$/).filter((s) => s.length > 0),
      { minLength: 1, maxLength: 5 }
    )
    .map((segments) => `/${segments.join('/')}`)
    // Exclude auth routes, which are intentionally never persisted.
    .filter((route) => !isAuthRoute(route));

  it('any safe route is returned verbatim after save then consume', () => {
    fc.assert(
      fc.property(safePath, (route) => {
        const store = makeStore();
        saveIntendedRoute(route, store);
        return consumeIntendedRoute(store) === route;
      }),
      { numRuns: 100 }
    );
  });
});
