/**
 * Outlook / Microsoft 365 calendar provider over Microsoft Graph (Task 7.1,
 * Requirement 10.2).
 *
 * Sign-in uses the Microsoft identity platform's authorization-code flow with
 * PKCE (S256) for single-page apps: no client secret, and the code is redeemed
 * from the browser at the tenant's token endpoint (CORS is allowed because the
 * redirect URI is registered under the "Single-page application" platform).
 * The response comes back in the URL fragment (`response_mode=fragment`), so
 * the authorization code never reaches a server log. Only the access token is
 * kept, in memory; any refresh token in the response is discarded.
 *
 * Scope: `Calendars.ReadBasic` — Graph's least-privileged read-only calendar
 * permission (no bodies, attachments or extensions), available for both work /
 * school and personal Microsoft accounts.
 *
 * Events come from `GET /me/calendarView` for the visible week, with recurring
 * events expanded by Graph, times returned in UTC (`Prefer:
 * outlook.timezone="UTC"`) and only the rendered fields selected. Paging links
 * are followed only while they point at graph.microsoft.com, so the access
 * token is never sent anywhere else.
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
  createCodeChallenge,
  createCodeVerifier,
  DigestSource,
  OAuthProviderDeps,
  randomUrlSafeString,
  STATE_BYTES,
  withQuery,
} from './oauthPopup';

export const OUTLOOK_PROVIDER_ID = 'outlook';
export const OUTLOOK_PROVIDER_LABEL = 'Outlook Calendar';

export const MICROSOFT_AUTHORITY_HOST = 'https://login.microsoftonline.com';
export const GRAPH_HOST = 'graph.microsoft.com';
export const GRAPH_CALENDAR_VIEW_ENDPOINT = `https://${GRAPH_HOST}/v1.0/me/calendarView`;

/** The only scope requested: Graph's least-privileged read-only calendar permission. */
export const OUTLOOK_CALENDAR_SCOPE = `https://${GRAPH_HOST}/Calendars.ReadBasic`;

const GRAPH_EVENT_FIELDS = 'id,subject,start,end,isAllDay,isCancelled,location,webLink';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface OutlookCalendarProviderConfig {
  /** Application (client) ID of the Entra ID app registration (REACT_APP_MS_CLIENT_ID). */
  clientId: string;
  /** Tenant: "common", "organizations", "consumers", a tenant ID or a verified domain. */
  tenant: string;
  /** The callback page's URL, registered as a "Single-page application" redirect URI. */
  redirectUri: string;
}

export interface OutlookCalendarProviderDeps extends OAuthProviderDeps {
  /** SHA-256 for the PKCE challenge. Defaults to Web Crypto. */
  subtle?: DigestSource;
}

function authorityEndpoint(tenant: string, endpoint: 'authorize' | 'token'): string {
  return `${MICROSOFT_AUTHORITY_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/${endpoint}`;
}

const GRAPH_DATE_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * A Graph `dateTime` (e.g. "2024-06-03T09:00:00.0000000", UTC per the Prefer
 * header) as epoch ms. Graph sends 7 fractional digits, which not every JS
 * engine parses, so the value is normalized to millisecond precision first.
 */
export function parseGraphDateTime(value: string): number {
  const match = GRAPH_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return Number.NaN;
  }
  const [, minutes, seconds = ':00', fraction = '', zone = 'Z'] = match;
  return Date.parse(`${minutes}${seconds}.${`${fraction}000`.slice(0, 3)}${zone}`);
}

function graphDateTime(value: unknown): string | null {
  return isRecord(value) && typeof value.dateTime === 'string' ? value.dateTime : null;
}

/**
 * Maps one Graph event resource to a {@link CalendarEvent}; null for cancelled
 * or malformed items. All-day events are floating dates: Graph returns them at
 * midnight and does not shift them with the Prefer time zone, so their date part
 * is used as-is.
 */
export function mapGraphEvent(raw: unknown): CalendarEvent | null {
  if (!isRecord(raw) || raw.isCancelled === true) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  const start = graphDateTime(raw.start);
  if (!id || !start) {
    return null;
  }
  const end = graphDateTime(raw.end);
  const allDay = raw.isAllDay === true;
  let startValue: string;
  let endValue: string;
  if (allDay) {
    startValue = start.slice(0, 10);
    if (Number.isNaN(parseDateKey(startValue))) {
      return null;
    }
    const endKey = end ? end.slice(0, 10) : '';
    endValue =
      !Number.isNaN(parseDateKey(endKey)) && endKey > startValue
        ? endKey
        : nextDateKey(startValue) ?? startValue;
  } else {
    const startTime = parseGraphDateTime(start);
    if (Number.isNaN(startTime)) {
      return null;
    }
    const endTime = end ? parseGraphDateTime(end) : Number.NaN;
    startValue = new Date(startTime).toISOString();
    endValue = new Date(
      Number.isNaN(endTime) || endTime < startTime ? startTime : endTime
    ).toISOString();
  }
  const location = isRecord(raw.location) ? toEventText(raw.location.displayName) : '';
  const webLink = sanitizeWebLink(raw.webLink);
  return {
    id,
    title: toEventText(raw.subject),
    start: startValue,
    end: endValue,
    allDay,
    ...(location ? { location } : {}),
    ...(webLink ? { webLink } : {}),
  };
}

/** True only for https://graph.microsoft.com URLs: the token goes nowhere else. */
export function isGraphUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === GRAPH_HOST && !url.username && !url.password;
  } catch {
    return false;
  }
}

function calendarViewUrl(range: DateRange): string {
  // Built by hand so the OData `$` prefixes stay literal.
  const query = [
    `startDateTime=${encodeURIComponent(new Date(range.start).toISOString())}`,
    `endDateTime=${encodeURIComponent(new Date(range.end).toISOString())}`,
    `$select=${GRAPH_EVENT_FIELDS}`,
    '$orderby=start/dateTime',
    `$top=${PAGE_SIZE}`,
  ].join('&');
  return `${GRAPH_CALENDAR_VIEW_ENDPOINT}?${query}`;
}

export function createOutlookCalendarProvider(
  config: OutlookCalendarProviderConfig,
  deps: OutlookCalendarProviderDeps = {}
): CalendarProvider {
  const fetchImpl = deps.fetch ?? browserFetch;
  const tokens = createAccessTokenStore(deps.now);

  async function connect(options: CalendarRequestOptions = {}): Promise<void> {
    // Everything up to authorizeInPopup runs synchronously inside the click.
    const state = randomUrlSafeString(STATE_BYTES, deps.random);
    const verifier = createCodeVerifier(deps.random);
    const params = await authorizeInPopup({
      authorizationUrl: async () =>
        withQuery(authorityEndpoint(config.tenant, 'authorize'), {
          client_id: config.clientId,
          response_type: 'code',
          redirect_uri: config.redirectUri,
          response_mode: 'fragment',
          scope: OUTLOOK_CALENDAR_SCOPE,
          state,
          code_challenge: await createCodeChallenge(verifier, deps.subtle),
          code_challenge_method: 'S256',
        }),
      state,
      signal: options.signal,
      timeoutMs: deps.popupTimeoutMs,
      deps: deps.popup,
    });

    const error = params.get('error');
    if (error) {
      throw new CalendarProviderError('auth', `Microsoft sign-in failed (${error}).`);
    }
    const code = params.get('code');
    if (!code) {
      throw new CalendarProviderError('auth', 'Microsoft returned no authorization code.');
    }

    const body = await requestJson(
      fetchImpl,
      authorityEndpoint(config.tenant, 'token'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
          scope: OUTLOOK_CALENDAR_SCOPE,
        }).toString(),
        signal: options.signal,
      },
      OUTLOOK_PROVIDER_LABEL,
      // invalid_grant & co. arrive as 400: the student has to sign in again.
      { authStatuses: [400, 401, 403] }
    );
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const tokenType = typeof body.token_type === 'string' ? body.token_type : 'Bearer';
    if (!accessToken || tokenType.toLowerCase() !== 'bearer') {
      throw new CalendarProviderError('auth', 'Microsoft returned no usable access token.');
    }
    tokens.set(accessToken, Number(body.expires_in));
  }

  async function listEvents(
    range: DateRange,
    options: CalendarRequestOptions = {}
  ): Promise<CalendarEvent[]> {
    const token = tokens.get();
    if (!token) {
      throw new CalendarProviderError('auth', 'Not signed in to Outlook.');
    }
    const events: CalendarEvent[] = [];
    let url: string | null = calendarViewUrl(range);
    try {
      for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
        const body: Record<string, unknown> = await requestJson(
          fetchImpl,
          url,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              Prefer: 'outlook.timezone="UTC"',
            },
            signal: options.signal,
          },
          OUTLOOK_PROVIDER_LABEL
        );
        const items: unknown[] = Array.isArray(body.value) ? body.value : [];
        for (const item of items) {
          const event = mapGraphEvent(item);
          if (event) {
            events.push(event);
          }
        }
        const next = body['@odata.nextLink'];
        url = typeof next === 'string' && next !== '' ? next : null;
        if (url !== null && !isGraphUrl(url)) {
          throw new CalendarProviderError('unavailable', 'Outlook returned an unexpected paging link.');
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

  return {
    id: OUTLOOK_PROVIDER_ID,
    label: OUTLOOK_PROVIDER_LABEL,
    connect,
    isConnected: () => tokens.get() !== null,
    listEvents,
    // Microsoft has no endpoint to revoke a single SPA access token; it is
    // simply forgotten and expires on its own (about an hour).
    disconnect: () => tokens.clear(),
  };
}
