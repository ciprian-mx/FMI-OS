/**
 * Google Calendar provider (Task 7.1, Requirement 10.2).
 *
 * Sign-in uses Google's OAuth 2.0 token flow for browser apps
 * (`response_type=token`, documented as "OAuth 2.0 for Client-side Web
 * Applications"). Google's authorization-code exchange requires a client secret
 * for web clients, which a static front end cannot keep, so the code + PKCE flow
 * is not an option without a backend. The token arrives in the URL fragment of
 * FMI OS's callback page (never sent to a server), is checked against the
 * request's `state` and the granted scopes, and is then held in memory only
 * (see `createAccessTokenStore`). There is no refresh token: when the
 * ~1 hour token expires the student reconnects.
 *
 * Scope: `calendar.events.readonly` — read-only access to events, nothing else.
 *
 * Events come from Calendar API v3 `events.list` on the student's primary
 * calendar, with recurring events expanded (`singleEvents=true`) and only the
 * fields the widget renders requested.
 */
import {
  CalendarEvent,
  DateRange,
  nextDateKey,
  parseDateKey,
  sanitizeWebLink,
  toEventText,
} from './calendarEvents';
import {
  BASE_REQUEST_INIT,
  browserFetch,
  CalendarProvider,
  CalendarProviderError,
  CalendarRequestOptions,
  createAccessTokenStore,
  isRecord,
  requestJson,
} from './calendarProvider';
import {
  authorizeInPopup,
  OAuthProviderDeps,
  randomUrlSafeString,
  STATE_BYTES,
  withQuery,
} from './oauthPopup';

export const GOOGLE_PROVIDER_ID = 'google';
export const GOOGLE_PROVIDER_LABEL = 'Google Calendar';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_EVENTS_ENDPOINT =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** The only scope requested: read-only access to calendar events. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

const GOOGLE_EVENT_FIELDS = 'items(id,status,summary,location,htmlLink,start,end),nextPageToken';
const PAGE_SIZE = 250;
const MAX_PAGES = 4;

export interface GoogleCalendarProviderConfig {
  /** OAuth client ID of a "Web application" client (REACT_APP_GOOGLE_CLIENT_ID). */
  clientId: string;
  /** The callback page's URL, registered as an authorized redirect URI. */
  redirectUri: string;
}

/**
 * One Google `start` / `end` object as a {@link CalendarEvent} boundary:
 * `dateTime` (RFC 3339) → ISO instant, `date` ("YYYY-MM-DD") → all-day date.
 */
function readGoogleTime(value: unknown): { allDay: boolean; value: string } | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.dateTime === 'string') {
    const time = Date.parse(value.dateTime);
    return Number.isNaN(time) ? null : { allDay: false, value: new Date(time).toISOString() };
  }
  if (typeof value.date === 'string' && !Number.isNaN(parseDateKey(value.date))) {
    return { allDay: true, value: value.date };
  }
  return null;
}

/**
 * Maps one Calendar API event resource to a {@link CalendarEvent}; null for
 * cancelled or malformed items, which are skipped rather than failing the pull.
 */
export function mapGoogleEvent(raw: unknown): CalendarEvent | null {
  if (!isRecord(raw) || raw.status === 'cancelled') {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  const start = readGoogleTime(raw.start);
  if (!id || !start) {
    return null;
  }
  const end = readGoogleTime(raw.end);
  let endValue: string;
  if (end && end.allDay === start.allDay && end.value >= start.value) {
    endValue = end.value;
  } else {
    endValue = start.allDay ? nextDateKey(start.value) ?? start.value : start.value;
  }
  const location = toEventText(raw.location);
  const webLink = sanitizeWebLink(raw.htmlLink);
  return {
    id,
    title: toEventText(raw.summary),
    start: start.value,
    end: endValue,
    allDay: start.allDay,
    ...(location ? { location } : {}),
    ...(webLink ? { webLink } : {}),
  };
}

export function createGoogleCalendarProvider(
  config: GoogleCalendarProviderConfig,
  deps: OAuthProviderDeps = {}
): CalendarProvider {
  const fetchImpl = deps.fetch ?? browserFetch;
  const tokens = createAccessTokenStore(deps.now);

  async function connect(options: CalendarRequestOptions = {}): Promise<void> {
    // Everything up to authorizeInPopup runs synchronously inside the click.
    const state = randomUrlSafeString(STATE_BYTES, deps.random);
    const params = await authorizeInPopup({
      authorizationUrl: withQuery(GOOGLE_AUTHORIZATION_ENDPOINT, {
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'token',
        scope: GOOGLE_CALENDAR_SCOPE,
        state,
      }),
      state,
      signal: options.signal,
      timeoutMs: deps.popupTimeoutMs,
      deps: deps.popup,
    });

    const error = params.get('error');
    if (error) {
      throw new CalendarProviderError('auth', `Google sign-in failed (${error}).`);
    }
    const accessToken = params.get('access_token');
    const tokenType = params.get('token_type');
    if (!accessToken || (tokenType !== null && tokenType.toLowerCase() !== 'bearer')) {
      throw new CalendarProviderError('auth', 'Google returned no usable access token.');
    }
    // With granular consent the student may untick calendar access.
    const granted = params.get('scope');
    if (granted !== null && !granted.split(/\s+/).includes(GOOGLE_CALENDAR_SCOPE)) {
      throw new CalendarProviderError('auth', 'Calendar access was not granted.');
    }
    tokens.set(accessToken, Number(params.get('expires_in')));
  }

  async function listEvents(
    range: DateRange,
    options: CalendarRequestOptions = {}
  ): Promise<CalendarEvent[]> {
    const token = tokens.get();
    if (!token) {
      throw new CalendarProviderError('auth', 'Not signed in to Google Calendar.');
    }
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = await requestJson(
          fetchImpl,
          withQuery(GOOGLE_EVENTS_ENDPOINT, {
            timeMin: new Date(range.start).toISOString(),
            timeMax: new Date(range.end).toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: String(PAGE_SIZE),
            fields: GOOGLE_EVENT_FIELDS,
            pageToken,
          }),
          {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: options.signal,
          },
          GOOGLE_PROVIDER_LABEL
        );
        const items: unknown[] = Array.isArray(body.items) ? body.items : [];
        for (const item of items) {
          const event = mapGoogleEvent(item);
          if (event) {
            events.push(event);
          }
        }
        pageToken =
          typeof body.nextPageToken === 'string' && body.nextPageToken !== ''
            ? body.nextPageToken
            : undefined;
        if (!pageToken) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof CalendarProviderError && error.kind === 'auth') {
        // Expired or revoked: forget it so the student is asked to reconnect.
        tokens.clear();
      }
      throw error;
    }
    return events;
  }

  function disconnect(): void {
    const token = tokens.get();
    tokens.clear();
    if (token) {
      // Best effort: revoke the grant at Google. The token is already
      // forgotten either way, so failures (offline, CORS) are ignored.
      fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
        ...BASE_REQUEST_INIT,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      }).catch(() => undefined);
    }
  }

  return {
    id: GOOGLE_PROVIDER_ID,
    label: GOOGLE_PROVIDER_LABEL,
    connect,
    isConnected: () => tokens.get() !== null,
    listEvents,
    disconnect,
  };
}
