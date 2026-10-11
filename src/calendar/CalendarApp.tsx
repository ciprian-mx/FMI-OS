import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { calendarCachePrefix, CalendarEventCache, sharedEventCache } from './calendarCache';
import { getDefaultCalendarConfig, getDefaultCalendarProviders } from './calendarConfig';
import { EMBED_SANDBOX, EmbedUrlValidation, validateCalendarEmbedUrl } from './calendarEmbed';
import {
  addDays,
  CalendarDay,
  CalendarEvent,
  DateRange,
  eventBounds,
  groupEventsByDay,
  toDateKey,
  weekRange,
} from './calendarEvents';
import {
  CalendarProvider,
  CalendarProviderError,
  toCalendarProviderError,
} from './calendarProvider';
import { useCalendarEvents } from './useCalendarEvents';
import './CalendarApp.css';

/**
 * Calendar App (Task 7.1, Requirements 10.1–10.5).
 *
 * Shows the student's external calendar inside an FMI OS window, in one of two
 * integration modes (design.md — `CalendarApp`):
 *
 *   • API mode (Requirement 10.2): the student connects Google Calendar or
 *     Outlook through a read-only OAuth sign-in (see the provider modules); the
 *     visible week's events are fetched and laid out in a week view with
 *     loading, empty and error states. Events render from a cache
 *     (`calendarCache.ts`), so a running or failed refresh never blanks what is
 *     already on screen (Requirement 10.1).
 *   • Iframe mode (Requirement 10.3): an allowlisted calendar web page is
 *     embedded in a sandboxed iframe. Used when `integrationType="iframe"`,
 *     when no provider is configured (API unavailable), or when the student
 *     switches to it after connecting fails.
 *
 * Both modes refresh every 15 minutes while the window is open (Requirement
 * 10.4) — API mode re-fetches, iframe mode reloads the frame — and the timers
 * are cleared when the window closes. Unreachable sources and failed sign-ins
 * show an error message with a Retry button (Requirement 10.5); Retry signs in
 * again when the failure was an authentication one and re-fetches otherwise.
 *
 * Mapping to the design's props: `integrationType`, `externalCalendarUrl` and
 * `refreshIntervalMs` keep their meaning (now optional, with defaults); the
 * design's `onAuthenticateCalendar` callback is replaced by the injectable
 * `providers`, whose `connect()` performs the authentication.
 *
 * Observability for tests: `data-testid="calendar-app"` carries `data-mode`
 * ("api" | "iframe"); each day of the week view is
 * `data-testid="calendar-day-YYYY-MM-DD"` and each event
 * `data-testid="calendar-event"` with `data-event-id`; errors render in
 * `data-testid="calendar-error"` with a `role="alert"` message and a Retry
 * button; the frame is `data-testid="calendar-iframe"`.
 */

export type CalendarIntegrationType = 'api' | 'iframe';

export interface CalendarAppProps {
  /**
   * Preferred integration mode. Defaults to "api" when at least one provider
   * is configured, otherwise "iframe". "api" without a usable provider falls
   * back to iframe mode (Requirement 10.3).
   */
  integrationType?: CalendarIntegrationType;
  /**
   * Providers offered in API mode. Defaults to the ones configured through the
   * REACT_APP_* environment variables (`calendarConfig.ts`). Pass stable
   * instances: providers hold the (in-memory) access tokens.
   */
  providers?: readonly CalendarProvider[];
  /**
   * Calendar web page for iframe mode. Only allowlisted `https:` links are
   * embedded (`calendarEmbed.ts`). Defaults to REACT_APP_CALENDAR_EMBED_URL.
   */
  externalCalendarUrl?: string;
  /**
   * Auto-refresh period. Defaults to, and is capped at, 15 minutes
   * (Requirement 10.4); values under one minute are raised to one minute.
   */
  refreshIntervalMs?: number;
  /**
   * Where pulled events are cached. Defaults to an in-memory cache shared by
   * Calendar windows for the lifetime of the page.
   */
  eventCache?: CalendarEventCache;
  /**
   * Reference "now" for the visible week and today's highlight. Defaults to
   * the current time; inject a fixed date for deterministic tests.
   */
  now?: Date;
}

/** Requirement 10.4: refresh at least once every 15 minutes. */
export const CALENDAR_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** Floor for `refreshIntervalMs`, so a misconfiguration can't hammer the providers. */
export const MIN_CALENDAR_REFRESH_INTERVAL_MS = 60 * 1000;

/** How long the embedded page may take to load before the app reports it unavailable. */
export const IFRAME_LOAD_TIMEOUT_MS = 30 * 1000;

/** The effective auto-refresh period for a requested one. */
export function resolveRefreshInterval(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return CALENDAR_REFRESH_INTERVAL_MS;
  }
  return Math.min(
    CALENDAR_REFRESH_INTERVAL_MS,
    Math.max(MIN_CALENDAR_REFRESH_INTERVAL_MS, requested)
  );
}

/** Every message the app shows. */
export const CALENDAR_MESSAGES = {
  connectPrompt:
    'Connect a calendar account to see your events here. FMI OS only asks for read-only access.',
  connecting: (label: string) => `Waiting for you to sign in to ${label} in the pop-up window…`,
  loading: 'Loading events…',
  empty: 'No events this week.',
  popupBlocked:
    'Your browser blocked the sign-in pop-up. Allow pop-ups for FMI OS, then try again.',
  connectFailed: (label: string) => `Couldn't connect to ${label}. Please try again.`,
  sessionExpired: (label: string) =>
    `Your ${label} session has expired or access was revoked. Reconnect to keep your calendar up to date.`,
  unavailable: (label: string) =>
    `${label} is unavailable right now. Check your connection and try again.`,
  embedSlow: (label: string) =>
    `The embedded ${label} didn't finish loading. It may be unavailable right now.`,
  fallbackNote:
    "Calendar sign-in isn't configured, so your calendar's web page is embedded instead.",
  noEmbedLink: 'No calendar embed link is configured.',
  notConfigured:
    "Calendar isn't set up yet: FMI OS has no calendar sign-in (Google or Outlook) and no calendar embed link configured.",
};

function describeFailure(
  error: CalendarProviderError,
  label: string,
  during: 'connect' | 'sync'
): string {
  switch (error.kind) {
    case 'popup-blocked':
      return CALENDAR_MESSAGES.popupBlocked;
    case 'auth':
      return during === 'connect'
        ? CALENDAR_MESSAGES.connectFailed(label)
        : CALENDAR_MESSAGES.sessionExpired(label);
    default:
      return CALENDAR_MESSAGES.unavailable(label);
  }
}

/* -------------------------------------------------------------------------- *
 * Formatting
 * -------------------------------------------------------------------------- */

const DAY_HEADING_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const RANGE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

function formatWeek(range: DateRange): string {
  return `${RANGE_FORMAT.format(range.start)} – ${RANGE_FORMAT.format(
    addDays(new Date(range.end), -1)
  )}`;
}

/** The time label of `event` within `day` ("09:00 – 10:30", "From 22:00", "All day"…). */
function describeEventTime(event: CalendarEvent, day: CalendarDay): string {
  const bounds = eventBounds(event);
  if (event.allDay || !bounds) {
    return 'All day';
  }
  const startsToday = bounds.start >= day.start;
  const endsToday = bounds.end <= day.end;
  if (startsToday && endsToday) {
    return bounds.start === bounds.end
      ? TIME_FORMAT.format(bounds.start)
      : `${TIME_FORMAT.format(bounds.start)} – ${TIME_FORMAT.format(bounds.end)}`;
  }
  if (startsToday) {
    return `From ${TIME_FORMAT.format(bounds.start)}`;
  }
  if (endsToday) {
    return `Until ${TIME_FORMAT.format(bounds.end)}`;
  }
  return 'All day';
}

/* -------------------------------------------------------------------------- *
 * Shared pieces
 * -------------------------------------------------------------------------- */

interface CalendarAlertProps {
  message: string;
  onRetry: () => void;
  retryDisabled?: boolean;
  children?: React.ReactNode;
}

/** Error message + Retry button (Requirement 10.5). */
const CalendarAlert: React.FC<CalendarAlertProps> = ({
  message,
  onRetry,
  retryDisabled = false,
  children,
}) => {
  const messageId = useId();
  return (
    <div className="calendar-app__alert" data-testid="calendar-error">
      <p id={messageId} className="calendar-app__alert-message" role="alert">
        {message}
      </p>
      <div className="calendar-app__alert-actions">
        <button
          type="button"
          className="calendar-app__button calendar-app__button--primary"
          data-testid="calendar-retry"
          aria-describedby={messageId}
          onClick={onRetry}
          disabled={retryDisabled}
        >
          Retry
        </button>
        {children}
      </div>
    </div>
  );
};

interface EventItemProps {
  event: CalendarEvent;
  day: CalendarDay;
  providerLabel: string;
}

const EventItem: React.FC<EventItemProps> = ({ event, day, providerLabel }) => {
  const title = event.title || 'Untitled event';
  const bounds = eventBounds(event);
  const dateTime = event.allDay
    ? event.start
    : bounds
      ? new Date(bounds.start).toISOString()
      : undefined;
  return (
    <li
      className={
        event.allDay ? 'calendar-app__event calendar-app__event--all-day' : 'calendar-app__event'
      }
      data-testid="calendar-event"
      data-event-id={event.id}
    >
      <time className="calendar-app__event-time" dateTime={dateTime}>
        {describeEventTime(event, day)}
      </time>
      <span className="calendar-app__event-title">{title}</span>
      {event.location && (
        <span className="calendar-app__event-location">{event.location}</span>
      )}
      {event.webLink && (
        <a
          className="calendar-app__event-link"
          href={event.webLink}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label={`Open ${title} in ${providerLabel} (opens in a new tab)`}
        >
          Open
        </a>
      )}
    </li>
  );
};

interface WeekViewProps {
  days: CalendarDay[];
  label: string;
  todayKey: string;
  providerLabel: string;
  busy: boolean;
}

const WeekView: React.FC<WeekViewProps> = ({ days, label, todayKey, providerLabel, busy }) => (
  <ol
    className="calendar-app__week"
    data-testid="calendar-week"
    aria-label={`Events, ${label}`}
    aria-busy={busy}
  >
    {days.map((day) => {
      const isToday = day.key === todayKey;
      return (
        <li
          key={day.key}
          className={isToday ? 'calendar-app__day calendar-app__day--today' : 'calendar-app__day'}
          data-testid={`calendar-day-${day.key}`}
          aria-current={isToday ? 'date' : undefined}
        >
          <h3 className="calendar-app__day-heading">
            <time dateTime={day.key}>{DAY_HEADING_FORMAT.format(day.start)}</time>
            {isToday && <span className="calendar-app__today">Today</span>}
          </h3>
          {day.events.length === 0 ? (
            <p className="calendar-app__day-empty">No events</p>
          ) : (
            <ul className="calendar-app__events">
              {day.events.map((event) => (
                <EventItem
                  key={event.id}
                  event={event}
                  day={day}
                  providerLabel={providerLabel}
                />
              ))}
            </ul>
          )}
        </li>
      );
    })}
  </ol>
);

/* -------------------------------------------------------------------------- *
 * API mode
 * -------------------------------------------------------------------------- */

interface ApiCalendarProps {
  providers: readonly CalendarProvider[];
  cache: CalendarEventCache;
  refreshIntervalMs: number;
  now?: Date;
  /** Switches to iframe mode; only provided when a usable embed link exists. */
  onUseEmbed?: () => void;
}

interface ConnectFailure {
  providerId: string;
  error: CalendarProviderError;
}

const ApiCalendar: React.FC<ApiCalendarProps> = ({
  providers,
  cache,
  refreshIntervalMs,
  now,
  onUseEmbed,
}) => {
  // A provider still holding a token (e.g. the window was closed and reopened)
  // is shown straight away.
  const [activeId, setActiveId] = useState<string | null>(
    () => providers.find((provider) => provider.isConnected())?.id ?? null
  );
  const active = providers.find((provider) => provider.id === activeId) ?? null;
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectFailure, setConnectFailure] = useState<ConnectFailure | null>(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const connectAttemptRef = useRef<AbortController | null>(null);

  const cancelConnect = useCallback(() => {
    const attempt = connectAttemptRef.current;
    connectAttemptRef.current = null;
    attempt?.abort();
  }, []);
  // Closing the window mid sign-in abandons the attempt (and its pop-up).
  useEffect(() => cancelConnect, [cancelConnect]);

  const reference = now ?? new Date();
  const range = weekRange(reference, weekOffset);
  const sync = useCalendarEvents({
    provider: active,
    range,
    cache,
    refreshIntervalMs,
    connectionVersion,
  });

  const connect = (provider: CalendarProvider) => {
    cancelConnect();
    const controller = new AbortController();
    connectAttemptRef.current = controller;
    let attempt: Promise<void>;
    try {
      // Synchronous, inside the click: the provider opens its pop-up right away.
      attempt = provider.connect({ signal: controller.signal });
    } catch (error) {
      attempt = Promise.reject(error);
    }
    setConnectingId(provider.id);
    setConnectFailure(null);
    attempt.then(
      () => {
        if (connectAttemptRef.current !== controller) {
          return;
        }
        connectAttemptRef.current = null;
        setConnectingId(null);
        setActiveId(provider.id);
        // Pull again even when reconnecting the provider already on screen.
        setConnectionVersion((version) => version + 1);
      },
      (error: unknown) => {
        if (connectAttemptRef.current !== controller) {
          return; // Cancelled, superseded, or the window closed.
        }
        connectAttemptRef.current = null;
        setConnectingId(null);
        const failure = toCalendarProviderError(error, 'auth');
        if (failure.kind !== 'cancelled') {
          setConnectFailure({ providerId: provider.id, error: failure });
        }
      }
    );
  };

  const cancelSignIn = () => {
    cancelConnect();
    setConnectingId(null);
  };

  const disconnect = () => {
    if (!active) {
      return;
    }
    cancelSignIn();
    active.disconnect();
    cache.clear(calendarCachePrefix(active.id));
    setConnectFailure(null);
    setActiveId(null);
    setWeekOffset(0);
  };

  const connectingProvider = providers.find((provider) => provider.id === connectingId) ?? null;
  const failedProvider = connectFailure
    ? providers.find((provider) => provider.id === connectFailure.providerId) ?? null
    : null;

  let alert: { message: string; onRetry: () => void; offerEmbed: boolean } | null = null;
  if (connectFailure && failedProvider) {
    alert = {
      message: describeFailure(connectFailure.error, failedProvider.label, 'connect'),
      onRetry: () => connect(failedProvider),
      offerEmbed: false,
    };
  } else if (active && sync.error) {
    const { kind } = sync.error;
    alert = {
      message: describeFailure(sync.error, active.label, 'sync'),
      // An authentication failure needs a fresh sign-in; anything else a re-fetch.
      onRetry: kind === 'auth' || kind === 'popup-blocked' ? () => connect(active) : sync.refresh,
      offerEmbed: kind === 'unavailable',
    };
  }

  const embedButton = onUseEmbed ? (
    <button type="button" className="calendar-app__button" onClick={onUseEmbed}>
      Use embedded calendar instead
    </button>
  ) : null;

  const pendingBlock = connectingProvider ? (
    <div className="calendar-app__pending" data-testid="calendar-connecting">
      <p className="calendar-app__pending-text" role="status">
        {CALENDAR_MESSAGES.connecting(connectingProvider.label)}
      </p>
      <button type="button" className="calendar-app__button" onClick={cancelSignIn}>
        Cancel sign-in
      </button>
    </div>
  ) : null;

  const alertBlock = alert ? (
    <CalendarAlert
      message={alert.message}
      onRetry={alert.onRetry}
      retryDisabled={connectingId !== null || sync.pulling}
    >
      {alert.offerEmbed ? embedButton : null}
    </CalendarAlert>
  ) : null;

  if (!active) {
    return (
      <div className="calendar-app__connect" data-testid="calendar-connect">
        <p className="calendar-app__intro">{CALENDAR_MESSAGES.connectPrompt}</p>
        <div className="calendar-app__providers">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="calendar-app__button calendar-app__button--primary"
              data-testid={`calendar-connect-${provider.id}`}
              onClick={() => connect(provider)}
              disabled={connectingId !== null}
            >
              Connect {provider.label}
            </button>
          ))}
        </div>
        {pendingBlock}
        {alertBlock}
        {embedButton && <div className="calendar-app__alternative">{embedButton}</div>}
      </div>
    );
  }

  const weekLabel = formatWeek(range);
  const days = groupEventsByDay(sync.entry?.events ?? [], range);
  const hasEvents = days.some((day) => day.events.length > 0);

  const status = [`Connected to ${active.label}`];
  if (sync.entry) {
    status.push(`updated ${TIME_FORMAT.format(sync.entry.fetchedAt)}`);
    if (sync.pulling) {
      status.push('refreshing…');
    }
  }

  let content: React.ReactNode = null;
  if (!sync.entry) {
    // Nothing cached yet: loading until the first pull lands or fails.
    if (!sync.error) {
      content = (
        <p className="calendar-app__loading" data-testid="calendar-loading" aria-busy="true">
          {CALENDAR_MESSAGES.loading}
        </p>
      );
    }
  } else if (!hasEvents) {
    content = (
      <p className="calendar-app__empty" data-testid="calendar-empty">
        {CALENDAR_MESSAGES.empty}
      </p>
    );
  } else {
    content = (
      <WeekView
        days={days}
        label={weekLabel}
        todayKey={toDateKey(reference)}
        providerLabel={active.label}
        busy={sync.pulling}
      />
    );
  }

  return (
    <div className="calendar-app__api" data-testid="calendar-api-view" data-provider={active.id}>
      <div className="calendar-app__toolbar">
        <div className="calendar-app__nav" role="group" aria-label="Week navigation">
          <button
            type="button"
            className="calendar-app__button"
            onClick={() => setWeekOffset((offset) => offset - 1)}
          >
            Previous week
          </button>
          <button
            type="button"
            className="calendar-app__button"
            onClick={() => setWeekOffset(0)}
            disabled={weekOffset === 0}
          >
            This week
          </button>
          <button
            type="button"
            className="calendar-app__button"
            onClick={() => setWeekOffset((offset) => offset + 1)}
          >
            Next week
          </button>
        </div>
        <p className="calendar-app__range" data-testid="calendar-range">
          {weekLabel}
        </p>
        <div className="calendar-app__actions">
          <button
            type="button"
            className="calendar-app__button"
            onClick={sync.refresh}
            disabled={sync.pulling}
          >
            Refresh
          </button>
          <button type="button" className="calendar-app__button" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </div>
      <p className="calendar-app__status" role="status" data-testid="calendar-status">
        {status.join(' · ')}
      </p>
      {pendingBlock}
      {alertBlock}
      {content}
    </div>
  );
};

/* -------------------------------------------------------------------------- *
 * Iframe mode
 * -------------------------------------------------------------------------- */

interface CalendarFrameProps {
  url: string;
  label: string;
  refreshIntervalMs: number;
  note?: string;
}

const CalendarFrame: React.FC<CalendarFrameProps> = ({ url, label, refreshIntervalMs, note }) => {
  // Re-keying the iframe reloads the embedded page.
  const [loadCount, setLoadCount] = useState(0);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'slow'>('loading');
  const reload = useCallback(() => setLoadCount((count) => count + 1), []);

  // Requirement 10.4: reload the embedded page periodically while the window is open.
  useEffect(() => {
    const interval = setInterval(reload, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [reload, refreshIntervalMs]);

  // Every (re)load gets a deadline; past it, report the source unavailable (Requirement 10.5).
  useEffect(() => {
    setStatus('loading');
    const timer = setTimeout(
      () => setStatus((current) => (current === 'loading' ? 'slow' : current)),
      IFRAME_LOAD_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [loadCount, url]);

  return (
    <div className="calendar-app__embed" data-testid="calendar-embed">
      <div className="calendar-app__toolbar">
        <p className="calendar-app__range">{label}</p>
        <div className="calendar-app__actions">
          <button type="button" className="calendar-app__button" onClick={reload}>
            Reload calendar
          </button>
        </div>
      </div>
      {note && (
        <p className="calendar-app__note" data-testid="calendar-fallback-note">
          {note}
        </p>
      )}
      {status === 'slow' && (
        <CalendarAlert message={CALENDAR_MESSAGES.embedSlow(label)} onRetry={reload} />
      )}
      <iframe
        key={loadCount}
        className="calendar-app__frame"
        data-testid="calendar-iframe"
        data-load-count={loadCount}
        src={url}
        title={`Embedded ${label}`}
        sandbox={EMBED_SANDBOX}
        referrerPolicy="no-referrer"
        onLoad={() => setStatus('loaded')}
      />
    </div>
  );
};

interface EmbeddedCalendarProps {
  /** The validated embed link; null when none is configured. */
  embed: EmbedUrlValidation | null;
  refreshIntervalMs: number;
  note?: string;
  apiAvailable: boolean;
}

const EmbeddedCalendar: React.FC<EmbeddedCalendarProps> = ({
  embed,
  refreshIntervalMs,
  note,
  apiAvailable,
}) => {
  if (embed === null) {
    return (
      <p className="calendar-app__notice" data-testid="calendar-not-configured">
        {apiAvailable ? CALENDAR_MESSAGES.noEmbedLink : CALENDAR_MESSAGES.notConfigured}
      </p>
    );
  }
  if (!embed.ok) {
    return (
      <div className="calendar-app__alert" data-testid="calendar-embed-refused">
        <p className="calendar-app__alert-message" role="alert">
          {embed.error}
        </p>
      </div>
    );
  }
  return (
    <CalendarFrame
      url={embed.url}
      label={embed.providerLabel}
      refreshIntervalMs={refreshIntervalMs}
      note={note}
    />
  );
};

/* -------------------------------------------------------------------------- *
 * App
 * -------------------------------------------------------------------------- */

const CalendarApp: React.FC<CalendarAppProps> = ({
  integrationType,
  providers: providersProp,
  externalCalendarUrl,
  refreshIntervalMs,
  eventCache,
  now,
}) => {
  const titleId = useId();
  const providers = providersProp ?? getDefaultCalendarProviders();
  const embedSource =
    externalCalendarUrl !== undefined ? externalCalendarUrl : getDefaultCalendarConfig().embedUrl;
  const embed = useMemo<EmbedUrlValidation | null>(
    () =>
      embedSource !== null && embedSource.trim() !== ''
        ? validateCalendarEmbedUrl(embedSource)
        : null,
    [embedSource]
  );

  const apiAvailable = providers.length > 0;
  const preferred: CalendarIntegrationType = integrationType ?? (apiAvailable ? 'api' : 'iframe');
  // The student's own switch between modes, when they make one.
  const [chosen, setChosen] = useState<CalendarIntegrationType | null>(null);
  const mode: CalendarIntegrationType =
    (chosen ?? preferred) === 'api' && apiAvailable ? 'api' : 'iframe';

  const interval = resolveRefreshInterval(refreshIntervalMs);
  const cache = eventCache ?? sharedEventCache;
  const note =
    mode === 'iframe' && preferred === 'api' && !apiAvailable
      ? CALENDAR_MESSAGES.fallbackNote
      : undefined;

  return (
    <section
      className="calendar-app"
      data-testid="calendar-app"
      data-mode={mode}
      aria-labelledby={titleId}
    >
      <header className="calendar-app__header">
        <h2 id={titleId} className="calendar-app__title">
          Calendar
        </h2>
        {mode === 'iframe' && apiAvailable && (
          <button type="button" className="calendar-app__button" onClick={() => setChosen('api')}>
            Connect a calendar account
          </button>
        )}
      </header>
      <div className="calendar-app__body">
        {mode === 'api' ? (
          <ApiCalendar
            providers={providers}
            cache={cache}
            refreshIntervalMs={interval}
            now={now}
            onUseEmbed={embed !== null && embed.ok ? () => setChosen('iframe') : undefined}
          />
        ) : (
          <EmbeddedCalendar
            embed={embed}
            refreshIntervalMs={interval}
            note={note}
            apiAvailable={apiAvailable}
          />
        )}
      </div>
    </section>
  );
};

export default CalendarApp;
