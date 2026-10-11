/**
 * Event cache for the Calendar App (Task 7.1, Requirement 10.1: the app shows
 * calendar events "persisting cached event data independently of current pull
 * status").
 *
 * Each successful pull is written here, keyed by provider and week. The widget
 * renders straight from the cache, so a refresh that is still running, has
 * failed, or needs the student to sign in again never blanks what is already on
 * screen, and reopening the Calendar window shows the last events immediately
 * while a fresh pull runs.
 *
 * The default {@link sharedEventCache} lives in memory only, for the lifetime
 * of the page: logout and session expiry both reload the page, which wipes it,
 * and calendar data is never written to Web Storage (a student's agenda should
 * not outlive their session on a shared lab machine). A deployment that wants
 * events to survive reloads can pass its own {@link CalendarEventCache}.
 */
import type { CalendarEvent, DateRange } from './calendarEvents';

/** What one successful pull produced. */
export interface CachedCalendarEvents {
  readonly events: readonly CalendarEvent[];
  /** When the pull completed (epoch ms). */
  readonly fetchedAt: number;
}

/**
 * Storage for pulled events. `read` must keep returning the same object until
 * the entry is written or cleared (it backs `useSyncExternalStore`).
 */
export interface CalendarEventCache {
  read(key: string): CachedCalendarEvents | undefined;
  write(key: string, entry: CachedCalendarEvents): void;
  /** Drops the entries whose key starts with `prefix` (every entry when omitted). */
  clear(prefix?: string): void;
  /** Calls `listener` after every change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Key prefix shared by every entry of one provider. */
export function calendarCachePrefix(providerId: string): string {
  return `${providerId}:`;
}

/** Cache key for one provider and visible range. */
export function calendarCacheKey(providerId: string, range: DateRange): string {
  return `${calendarCachePrefix(providerId)}${range.start}-${range.end}`;
}

/** Entries kept by default: a few weeks either side of the current one. */
export const DEFAULT_CACHE_ENTRIES = 12;

/**
 * An in-memory cache keeping the `maxEntries` most recently written entries.
 */
export function createMemoryEventCache(
  maxEntries: number = DEFAULT_CACHE_ENTRIES
): CalendarEventCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  const entries = new Map<string, CachedCalendarEvents>();
  const listeners = new Set<() => void>();

  const notify = () => {
    Array.from(listeners).forEach((listener) => listener());
  };

  return {
    read: (key) => entries.get(key),
    write(key, entry) {
      // Re-insert so the Map's insertion order doubles as recency order.
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > limit) {
        const oldest: string | undefined = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
      notify();
    },
    clear(prefix) {
      let changed = false;
      for (const key of Array.from(entries.keys())) {
        if (prefix === undefined || key.startsWith(prefix)) {
          entries.delete(key);
          changed = true;
        }
      }
      if (changed) {
        notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The default cache: memory only and shared by every Calendar window for the
 * lifetime of the page.
 */
export const sharedEventCache: CalendarEventCache = createMemoryEventCache();
