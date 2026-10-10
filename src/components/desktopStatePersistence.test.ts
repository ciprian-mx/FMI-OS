import fc from 'fast-check';
import type { DesktopAppId, WindowState } from './DesktopEnvironment';
import {
  DESKTOP_STATE_SCHEMA_VERSION,
  DESKTOP_STATE_STORAGE_KEY,
  VALID_DESKTOP_APP_IDS,
  type DesktopState,
  type DesktopStateStore,
  type PersistedDesktopState,
  clearDesktopState,
  emptyDesktopState,
  loadDesktopState,
  normalizeDesktopState,
  normalizeWindowState,
  saveDesktopState,
} from './desktopStatePersistence';

/**
 * Task 2.6 — desktop state persistence layer (Requirements 3.5, 1.4).
 *
 * These tests exercise the localStorage-backed snapshot helper in isolation:
 * save/load round-trips, schema-version guarding, defensive handling of
 * missing/corrupt/invalid payloads, and graceful degradation when storage is
 * unavailable. The formal Property 5 round-trip (task 2.7) is covered
 * separately; the property test here validates this module's own round-trip
 * correctness.
 */

/** Simple in-memory DesktopStateStore for deterministic, isolated tests. */
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

/** A representative valid window used across example-based tests. */
function sampleWindow(overrides: Partial<WindowState> = {}): WindowState {
  return {
    appId: 'materials',
    isOpen: true,
    position: { x: 80, y: 60 },
    size: { width: 720, height: 480 },
    zIndex: 1,
    isFocused: true,
    ...overrides,
  };
}

describe('emptyDesktopState', () => {
  it('is an empty window registry with no layout', () => {
    expect(emptyDesktopState()).toEqual({ windows: [] });
  });
});

describe('normalizeWindowState', () => {
  it('accepts a well-formed window', () => {
    const win = sampleWindow();
    expect(normalizeWindowState(win)).toEqual(win);
  });

  it('strips unknown extra fields down to the WindowState shape', () => {
    const win = { ...sampleWindow(), bogus: 'nope' };
    expect(normalizeWindowState(win)).toEqual(sampleWindow());
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['unknown appId', { ...sampleWindow(), appId: 'calculator' }],
    ['non-boolean isOpen', { ...sampleWindow(), isOpen: 'yes' }],
    ['non-boolean isFocused', { ...sampleWindow(), isFocused: 1 }],
    ['non-finite zIndex', { ...sampleWindow(), zIndex: Number.NaN }],
    ['missing position', { ...sampleWindow(), position: undefined }],
    ['bad position', { ...sampleWindow(), position: { x: 'a', y: 1 } }],
    ['bad size', { ...sampleWindow(), size: { width: 1 } }],
  ])('rejects %s', (_label, input) => {
    expect(normalizeWindowState(input)).toBeNull();
  });
});

describe('normalizeDesktopState', () => {
  it('accepts a valid versioned envelope', () => {
    const envelope: PersistedDesktopState = {
      schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
      windows: [sampleWindow()],
    };
    expect(normalizeDesktopState(envelope)).toEqual({ windows: [sampleWindow()] });
  });

  it('preserves a valid layout object', () => {
    const envelope: PersistedDesktopState = {
      schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
      windows: [],
      layout: { wallpaper: 'dark' },
    };
    expect(normalizeDesktopState(envelope)).toEqual({
      windows: [],
      layout: { wallpaper: 'dark' },
    });
  });

  it('drops individual invalid windows but keeps valid ones', () => {
    const envelope = {
      schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
      windows: [sampleWindow({ appId: 'stats' }), { appId: 'nope' }, 42],
    };
    expect(normalizeDesktopState(envelope)).toEqual({
      windows: [sampleWindow({ appId: 'stats' })],
    });
  });

  it.each([
    ['wrong schema version', { schemaVersion: 999, windows: [] }],
    ['missing schema version', { windows: [] }],
    ['windows not an array', { schemaVersion: DESKTOP_STATE_SCHEMA_VERSION, windows: {} }],
    ['layout not an object', { schemaVersion: DESKTOP_STATE_SCHEMA_VERSION, windows: [], layout: 7 }],
    ['not an object', 'string'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeDesktopState(input)).toBeNull();
  });
});

describe('save / load round-trip', () => {
  it('saves a snapshot under the storage key and reads it back', () => {
    const store = makeStore();
    const state: DesktopState = {
      windows: [sampleWindow(), sampleWindow({ appId: 'roadmap', zIndex: 2 })],
      layout: { foo: 'bar' },
    };
    saveDesktopState(state, store);

    const raw = store.map.get(DESKTOP_STATE_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).schemaVersion).toBe(DESKTOP_STATE_SCHEMA_VERSION);

    expect(loadDesktopState(store)).toEqual(state);
  });

  it('round-trips a snapshot without a layout', () => {
    const store = makeStore();
    const state: DesktopState = { windows: [sampleWindow()] };
    saveDesktopState(state, store);
    expect(loadDesktopState(store)).toEqual(state);
  });
});

describe('loadDesktopState defensive fallbacks', () => {
  it('returns the empty default when nothing is stored', () => {
    expect(loadDesktopState(makeStore())).toEqual(emptyDesktopState());
  });

  it('returns the empty default for corrupt JSON', () => {
    const store = makeStore({ [DESKTOP_STATE_STORAGE_KEY]: '{not json' });
    expect(loadDesktopState(store)).toEqual(emptyDesktopState());
  });

  it('returns the empty default for a wrong-version snapshot', () => {
    const store = makeStore({
      [DESKTOP_STATE_STORAGE_KEY]: JSON.stringify({ schemaVersion: 0, windows: [] }),
    });
    expect(loadDesktopState(store)).toEqual(emptyDesktopState());
  });

  it('returns the empty default for a structurally invalid snapshot', () => {
    const store = makeStore({
      [DESKTOP_STATE_STORAGE_KEY]: JSON.stringify({ hello: 'world' }),
    });
    expect(loadDesktopState(store)).toEqual(emptyDesktopState());
  });
});

describe('clearDesktopState', () => {
  it('removes any persisted snapshot', () => {
    const store = makeStore({ [DESKTOP_STATE_STORAGE_KEY]: '{"schemaVersion":1,"windows":[]}' });
    clearDesktopState(store);
    expect(store.map.has(DESKTOP_STATE_STORAGE_KEY)).toBe(false);
  });
});

describe('graceful degradation when storage is unavailable', () => {
  it('does not throw and loads the empty default', () => {
    expect(() => saveDesktopState({ windows: [sampleWindow()] }, null)).not.toThrow();
    expect(loadDesktopState(null)).toEqual(emptyDesktopState());
    expect(() => clearDesktopState(null)).not.toThrow();
  });

  it('swallows write failures (e.g. quota exceeded)', () => {
    const throwingStore: DesktopStateStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    expect(() => saveDesktopState({ windows: [sampleWindow()] }, throwingStore)).not.toThrow();
  });
});

describe('property: any valid desktop state survives a save→load round-trip', () => {
  const appIdArb: fc.Arbitrary<DesktopAppId> = fc.constantFrom(
    ...(VALID_DESKTOP_APP_IDS as DesktopAppId[])
  );

  const windowArb: fc.Arbitrary<WindowState> = fc.record({
    appId: appIdArb,
    isOpen: fc.boolean(),
    position: fc.record({
      x: fc.integer({ min: -5000, max: 5000 }),
      y: fc.integer({ min: -5000, max: 5000 }),
    }),
    size: fc.record({
      width: fc.integer({ min: 0, max: 4000 }),
      height: fc.integer({ min: 0, max: 4000 }),
    }),
    zIndex: fc.integer({ min: 0, max: 1000 }),
    isFocused: fc.boolean(),
  });

  const stateArb: fc.Arbitrary<DesktopState> = fc.record(
    {
      windows: fc.array(windowArb, { maxLength: 6 }),
      layout: fc.option(
        fc.dictionary(
          fc.string(),
          fc.oneof(fc.string(), fc.integer(), fc.boolean())
        ),
        { nil: undefined }
      ),
    },
    { requiredKeys: ['windows'] }
  );

  it('restored state equals the original (positions, sizes, open apps, focus, z-order)', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const store = makeStore();
        saveDesktopState(state, store);
        expect(loadDesktopState(store)).toEqual(state);
      }),
      { numRuns: 200 }
    );
  });
});
