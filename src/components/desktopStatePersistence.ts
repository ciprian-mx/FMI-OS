/**
 * Desktop state persistence (Task 2.6, Requirements 3.5 / 1.4).
 *
 * Requirement 3.5: when a Student refreshes the page, the Desktop Environment
 * must restore their workspace layout — reopening every previously-open app
 * window at its saved position, size, z-order and focus. Requirement 1.4 reuses
 * the same stored snapshot so the layout survives a session-token-expiry →
 * re-authentication round trip.
 *
 * This module is the small, framework-agnostic persistence layer for that
 * desktop snapshot. It deliberately mirrors `src/auth/routeRestoration.ts`:
 *
 *   - It depends only on an injectable {@link DesktopStateStore} (the minimal
 *     Web Storage surface), defaulting to the ambient `localStorage`. That
 *     keeps it trivially unit-testable and resilient to environments where
 *     storage is unavailable (SSR, privacy modes, test DOMs).
 *   - It is defensive on read: missing, corrupt, or schema-invalid JSON never
 *     throws — it collapses to a safe empty default so a bad snapshot can never
 *     brick the desktop.
 *   - It is versioned: a `schemaVersion` tag guards against silently restoring
 *     a snapshot written by an incompatible future/older build.
 *
 * `localStorage` (not `sessionStorage`) is the right scope here: unlike the
 * route-restoration case, a desktop layout is meant to persist across browser
 * restarts, which is exactly what Requirement 3.5 ("refreshes the page") and
 * 1.4 ("after re-authentication") describe.
 *
 * Design note — DynamoDB sync: design.md lists a `DesktopState` table
 * (`studentId` PK, `stateId` SK) as the eventual remote home for this snapshot.
 * No backend exists yet, so this module keeps `localStorage` as the concrete
 * store and exposes a clean async {@link DesktopStateSyncBackend} seam that a
 * later task can implement against AppSync/DynamoDB. No live AWS calls are made
 * here.
 */

import type { DesktopAppId, WindowState } from './DesktopEnvironment';

/** Storage key under which the desktop snapshot is persisted. */
export const DESKTOP_STATE_STORAGE_KEY = 'fmi-os:desktop-state';

/**
 * Schema version for the persisted snapshot. Bump this whenever the shape of
 * {@link PersistedDesktopState} changes incompatibly; older snapshots will then
 * be ignored (and the desktop opens empty) rather than mis-restored.
 */
export const DESKTOP_STATE_SCHEMA_VERSION = 1;

/**
 * The canonical set of valid desktop app ids, mirroring the `DesktopAppId`
 * union in DesktopEnvironment. Kept as a runtime value so deserialization can
 * reject windows for unknown apps (e.g. a snapshot from a build with a
 * different app set). If `DesktopAppId` ever changes, this list — and
 * `DESKTOP_STATE_SCHEMA_VERSION` — should change with it.
 */
export const VALID_DESKTOP_APP_IDS: readonly DesktopAppId[] = [
  'materials',
  'examinations',
  'calendar',
  'timetable',
  'stats',
  'roadmap',
];

/**
 * Optional free-form desktop layout alongside the open windows. Kept open-ended
 * (icon arrangement, wallpaper choice, etc.) so later tasks can extend the
 * snapshot without another schema bump, as long as the value stays
 * JSON-serializable. Validated structurally only (an object), not by key.
 */
export type DesktopLayout = Record<string, unknown>;

/**
 * The in-memory desktop state this module round-trips: the open-window registry
 * (an array of {@link WindowState}) plus any optional {@link DesktopLayout}.
 */
export interface DesktopState {
  windows: WindowState[];
  layout?: DesktopLayout;
}

/**
 * The on-storage envelope. The `schemaVersion` tag wraps the {@link DesktopState}
 * so reads can detect and reject incompatible snapshots.
 */
export interface PersistedDesktopState {
  schemaVersion: number;
  windows: WindowState[];
  layout?: DesktopLayout;
}

/**
 * Minimal subset of the Web Storage API this module needs. Accepting this
 * interface (rather than reaching for global `localStorage` directly) keeps the
 * helper injectable in tests and resilient to environments without DOM storage.
 */
export interface DesktopStateStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Async seam for a remote persistence backend (design.md: DynamoDB
 * `DesktopState` table). Intentionally NOT implemented here — no backend
 * exists. A later task can supply an implementation that pushes/pulls the
 * snapshot for the authenticated `studentId`; `localStorage` remains the
 * concrete, synchronous store in the meantime.
 */
export interface DesktopStateSyncBackend {
  /** Push the local snapshot to the remote store for the given student. */
  save(studentId: string, state: DesktopState): Promise<void>;
  /** Pull the remote snapshot for the given student, or `null` if none. */
  load(studentId: string): Promise<DesktopState | null>;
}

/** The empty, safe default returned whenever no valid snapshot is available. */
export function emptyDesktopState(): DesktopState {
  return { windows: [] };
}

/**
 * Resolves the storage to use. Defaults to the ambient `localStorage` when
 * available, otherwise returns `null` so callers degrade gracefully (SSR,
 * privacy modes that throw on access, or test environments without storage).
 */
function resolveStore(store?: DesktopStateStore | null): DesktopStateStore | null {
  if (store !== undefined) {
    return store;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // Accessing localStorage can throw in some locked-down browser modes.
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validates and normalizes a single candidate window. Returns a clean
 * {@link WindowState} or `null` if the candidate is structurally invalid or
 * names an unknown app. Validating per-window (and dropping bad ones) means a
 * single corrupt entry cannot discard the whole restorable layout.
 */
export function normalizeWindowState(candidate: unknown): WindowState | null {
  if (!isPlainObject(candidate)) {
    return null;
  }

  const { appId, isOpen, position, size, zIndex, isFocused } = candidate;

  if (typeof appId !== 'string') {
    return null;
  }
  if (!VALID_DESKTOP_APP_IDS.includes(appId as DesktopAppId)) {
    return null;
  }
  if (typeof isOpen !== 'boolean' || typeof isFocused !== 'boolean') {
    return null;
  }
  if (!isFiniteNumber(zIndex)) {
    return null;
  }
  if (!isPlainObject(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
    return null;
  }
  if (
    !isPlainObject(size) ||
    !isFiniteNumber(size.width) ||
    !isFiniteNumber(size.height)
  ) {
    return null;
  }

  return {
    appId: appId as DesktopAppId,
    isOpen,
    position: { x: position.x, y: position.y },
    size: { width: size.width, height: size.height },
    zIndex,
    isFocused,
  };
}

/**
 * Validates a parsed candidate into a {@link DesktopState}, or returns `null`
 * when it cannot be used. Rejects wrong-version envelopes and non-array window
 * lists; drops any individual windows that fail validation.
 */
export function normalizeDesktopState(candidate: unknown): DesktopState | null {
  if (!isPlainObject(candidate)) {
    return null;
  }

  // Schema-version guard: ignore snapshots from an incompatible build.
  if (candidate.schemaVersion !== DESKTOP_STATE_SCHEMA_VERSION) {
    return null;
  }

  if (!Array.isArray(candidate.windows)) {
    return null;
  }

  const windows: WindowState[] = [];
  for (const entry of candidate.windows) {
    const normalized = normalizeWindowState(entry);
    if (normalized !== null) {
      windows.push(normalized);
    }
  }

  const state: DesktopState = { windows };

  if (candidate.layout !== undefined) {
    if (!isPlainObject(candidate.layout)) {
      return null;
    }
    state.layout = candidate.layout;
  }

  return state;
}

/**
 * Persists the desktop snapshot. Wraps the state in a versioned envelope and
 * writes it as JSON under {@link DESKTOP_STATE_STORAGE_KEY}. Best-effort: if
 * storage is unavailable or the write throws (e.g. quota), it silently no-ops —
 * a failed save only means the next reload opens the default empty desktop,
 * which is acceptable.
 */
export function saveDesktopState(
  state: DesktopState,
  store?: DesktopStateStore | null
): void {
  const target = resolveStore(store);
  if (!target) {
    return;
  }

  const envelope: PersistedDesktopState = {
    schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
    windows: state.windows,
    ...(state.layout !== undefined ? { layout: state.layout } : {}),
  };

  try {
    target.setItem(DESKTOP_STATE_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Best-effort; nothing actionable if the write fails.
  }
}

/**
 * Reads and validates the persisted desktop snapshot. Always returns a usable
 * {@link DesktopState}: on a missing key, unparseable JSON, a wrong schema
 * version, or any structurally invalid payload it returns the safe empty
 * default rather than throwing. This is the restore side invoked on page load
 * (Requirement 3.5) and after re-authentication (Requirement 1.4).
 */
export function loadDesktopState(store?: DesktopStateStore | null): DesktopState {
  const target = resolveStore(store);
  if (!target) {
    return emptyDesktopState();
  }

  let raw: string | null = null;
  try {
    raw = target.getItem(DESKTOP_STATE_STORAGE_KEY);
  } catch {
    return emptyDesktopState();
  }

  if (raw === null) {
    return emptyDesktopState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — defensively fall back rather than crash the desktop.
    return emptyDesktopState();
  }

  return normalizeDesktopState(parsed) ?? emptyDesktopState();
}

/**
 * Clears any persisted desktop snapshot. Used, for example, on an explicit
 * logout so the next session starts from a clean desktop rather than restoring
 * the previous Student's layout. Best-effort and never throws.
 */
export function clearDesktopState(store?: DesktopStateStore | null): void {
  const target = resolveStore(store);
  if (!target) {
    return;
  }
  try {
    target.removeItem(DESKTOP_STATE_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}
