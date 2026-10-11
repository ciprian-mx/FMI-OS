/**
 * Event synchronisation for the Calendar App's API mode (Task 7.1,
 * Requirements 10.1 / 10.4 / 10.5).
 *
 * `useCalendarEvents` pulls the visible week from the connected provider:
 *   • whenever the provider, the visible week or the connection changes;
 *   • every `refreshIntervalMs` (at most 15 minutes, Requirement 10.4) for as
 *     long as the component is mounted, i.e. while the window is open — the
 *     interval is cleared on unmount and in-flight requests are aborted;
 *   • on demand (`refresh`, used by the Refresh and Retry buttons).
 *
 * Results land in the {@link CalendarEventCache}, and the widget renders from
 * the cache (Requirement 10.1): cached events stay on screen while a pull runs,
 * after it fails, and when the student reopens the window. A failed pull is
 * reported as `error` (Requirement 10.5) and cleared by the next successful one.
 * Only one pull runs at a time; each one times out after `requestTimeoutMs`.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CachedCalendarEvents,
  CalendarEventCache,
  calendarCacheKey,
} from './calendarCache';
import type { CalendarEvent, DateRange } from './calendarEvents';
import {
  CalendarProvider,
  CalendarProviderError,
  toCalendarProviderError,
} from './calendarProvider';

/** How long one pull may take before it counts as "source unavailable". */
export const CALENDAR_REQUEST_TIMEOUT_MS = 30 * 1000;

export interface UseCalendarEventsOptions {
  /** The connected provider; null pauses syncing (nothing is pulled). */
  provider: CalendarProvider | null;
  /** The visible range. */
  range: DateRange;
  cache: CalendarEventCache;
  /** Auto-refresh period in ms. */
  refreshIntervalMs: number;
  /** Bump to pull again for the same provider and range (e.g. after reconnecting). */
  connectionVersion?: number;
  requestTimeoutMs?: number;
}

export interface CalendarEventsState {
  /** Cached events for the provider and range; undefined until the first pull lands. */
  entry: CachedCalendarEvents | undefined;
  /** A pull for the current provider and range is in flight. */
  pulling: boolean;
  /** Why the last pull failed; null once a pull succeeds. */
  error: CalendarProviderError | null;
  /** Pulls now, unless a pull for the same range is already running. */
  refresh: () => void;
}

interface Flight {
  key: string;
  controller: AbortController;
}

/** `promise`, but rejecting as soon as `signal` aborts (even if the provider ignores it). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new CalendarProviderError('cancelled', 'The request was cancelled.'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export function useCalendarEvents({
  provider,
  range,
  cache,
  refreshIntervalMs,
  connectionVersion = 0,
  requestTimeoutMs = CALENDAR_REQUEST_TIMEOUT_MS,
}: UseCalendarEventsOptions): CalendarEventsState {
  const { start, end } = range;
  const key = provider ? calendarCacheKey(provider.id, { start, end }) : null;

  const subscribe = useCallback((listener: () => void) => cache.subscribe(listener), [cache]);
  const getSnapshot = useCallback(
    () => (key === null ? undefined : cache.read(key)),
    [cache, key]
  );
  const entry = useSyncExternalStore(subscribe, getSnapshot);

  const [pullingKey, setPullingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    providerId: string;
    error: CalendarProviderError;
  } | null>(null);
  const flightRef = useRef<Flight | null>(null);

  const abortFlight = useCallback(() => {
    const flight = flightRef.current;
    flightRef.current = null;
    if (flight) {
      flight.controller.abort();
      setPullingKey(null);
    }
  }, []);

  const pull = useCallback(() => {
    if (!provider || key === null || flightRef.current?.key === key) {
      return;
    }
    // A pull for another week is now stale.
    flightRef.current?.controller.abort();
    const controller = new AbortController();
    const flight: Flight = { key, controller };
    flightRef.current = flight;
    setPullingKey(key);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    let request: Promise<CalendarEvent[]>;
    try {
      request = provider.listEvents({ start, end }, { signal: controller.signal });
    } catch (error) {
      request = Promise.reject(error);
    }

    untilAborted(request, controller.signal)
      .then((events) => {
        if (controller.signal.aborted) {
          return;
        }
        cache.write(key, { events, fetchedAt: Date.now() });
        setFailure(null);
      })
      .catch((error: unknown) => {
        // Superseded (other week, other provider, window closed): stay quiet.
        if (flightRef.current !== flight) {
          return;
        }
        const providerError = timedOut
          ? new CalendarProviderError('unavailable', `${provider.label} took too long to respond.`)
          : toCalendarProviderError(error);
        if (providerError.kind !== 'cancelled') {
          setFailure({ providerId: provider.id, error: providerError });
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (flightRef.current === flight) {
          flightRef.current = null;
          setPullingKey(null);
        }
      });
  }, [provider, key, start, end, cache, requestTimeoutMs]);

  // Pull on connect, on week changes and after reconnecting. Cached events stay
  // on screen meanwhile.
  useEffect(() => {
    pull();
  }, [pull, connectionVersion]);

  // Requirement 10.4: refresh periodically while the window is open.
  const latestPull = useRef(pull);
  useEffect(() => {
    latestPull.current = pull;
  }, [pull]);
  useEffect(() => {
    if (!provider) {
      return undefined;
    }
    const interval = setInterval(() => latestPull.current(), refreshIntervalMs);
    return () => clearInterval(interval);
  }, [provider, refreshIntervalMs]);

  // Abort the in-flight pull when the provider changes or the window closes.
  useEffect(() => abortFlight, [provider, abortFlight]);

  return {
    entry,
    pulling: key !== null && pullingKey === key,
    error: failure && provider && failure.providerId === provider.id ? failure.error : null,
    refresh: pull,
  };
}
