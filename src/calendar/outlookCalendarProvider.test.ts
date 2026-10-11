/**
 * @jest-environment node
 */
// Node supplies Web Crypto (getRandomValues + SubtleCrypto) for PKCE.
import { createHash } from 'crypto';
import type { FetchLike } from './calendarProvider';
import {
  createOutlookCalendarProvider,
  GRAPH_CALENDAR_VIEW_ENDPOINT,
  OUTLOOK_CALENDAR_SCOPE,
} from './outlookCalendarProvider';
import { createFakeOAuthPopup, FakeOAuthPopup, jsonResponse } from './testing/fakeCalendar';

/**
 * Task 7.1 — Outlook provider over Microsoft Graph: authorization code + PKCE
 * sign-in through the (fake) pop-up, code redemption and calendarView over an
 * injected fetch. No real OAuth app or network is involved.
 *
 * Validates: Requirements 10.2, 10.5
 */

const CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'organizations',
  redirectUri: 'https://fmi-os.example.edu/calendar-oauth-callback.html',
};
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
const WEEK = { start: Date.UTC(2024, 5, 3), end: Date.UTC(2024, 5, 10) };
const TOKEN = 'eyJ.graph-access-token';
const TOKEN_RESPONSE = jsonResponse({
  token_type: 'Bearer',
  access_token: TOKEN,
  expires_in: 3600,
  refresh_token: 'discarded',
});

function setup() {
  const popup = createFakeOAuthPopup();
  const fetchMock = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
  const provider = createOutlookCalendarProvider(CONFIG, { fetch: fetchMock, popup: popup.deps });
  return { popup, fetchMock, provider };
}

/** The pop-up is navigated once the (asynchronous) PKCE challenge is ready. */
async function authorizationRequest(popup: FakeOAuthPopup): Promise<URL> {
  for (let attempt = 0; attempt < 50 && popup.navigations.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return popup.lastAuthorizationUrl();
}

async function signIn({ popup, provider }: ReturnType<typeof setup>): Promise<void> {
  const pending = provider.connect();
  const url = await authorizationRequest(popup);
  popup.respond({ code: 'auth-code', state: url.searchParams.get('state') ?? '' });
  await pending;
}

describe('Outlook provider: sign-in', () => {
  it('uses authorization code + PKCE and redeems the code without a client secret', async () => {
    const { popup, fetchMock, provider } = setup();
    fetchMock.mockResolvedValue(TOKEN_RESPONSE);

    const pending = provider.connect();
    // Opened synchronously, before the asynchronous PKCE hashing.
    expect(popup.opened).toEqual(['about:blank']);
    const url = await authorizationRequest(popup);

    expect(`${url.origin}${url.pathname}`).toBe(`${AUTHORITY}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.clientId,
      response_type: 'code',
      redirect_uri: CONFIG.redirectUri,
      response_mode: 'fragment',
      scope: 'https://graph.microsoft.com/Calendars.ReadBasic',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    });

    popup.respond({ code: 'auth-code', state: url.searchParams.get('state') ?? '' });
    await pending;
    expect(provider.isConnected()).toBe(true);

    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe(`${AUTHORITY}/token`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    const body = new URLSearchParams(init?.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('scope')).toBe(OUTLOOK_CALENDAR_SCOPE);
    expect(body.has('client_secret')).toBe(false);
    // The verifier sent with the code hashes to the challenge sent before.
    const verifier = body.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge')
    );
  });

  it('treats a refused code redemption as an authentication failure', async () => {
    const context = setup();
    context.fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(signIn(context)).rejects.toMatchObject({ kind: 'auth' });
    expect(context.provider.isConnected()).toBe(false);
  });
});

describe('Outlook provider: events', () => {
  it('reads the calendar view in UTC and maps timed and all-day events', async () => {
    const context = setup();
    const { fetchMock, provider } = context;
    fetchMock
      .mockResolvedValueOnce(TOKEN_RESPONSE)
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'lab',
              subject: 'OS lab',
              isAllDay: false,
              isCancelled: false,
              start: { dateTime: '2024-06-04T08:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2024-06-04T10:00:00.0000000', timeZone: 'UTC' },
              location: { displayName: 'Lab 3' },
              webLink: 'https://outlook.office365.com/owa/?itemid=1',
            },
            {
              id: 'holiday',
              subject: 'Holiday',
              isAllDay: true,
              start: { dateTime: '2024-06-07T00:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2024-06-08T00:00:00.0000000', timeZone: 'UTC' },
            },
            {
              id: 'cancelled',
              subject: 'Cancelled',
              isCancelled: true,
              start: { dateTime: '2024-06-05T08:00:00.0000000' },
              end: { dateTime: '2024-06-05T09:00:00.0000000' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=abc',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    await signIn(context);

    await expect(provider.listEvents(WEEK)).resolves.toEqual([
      {
        id: 'lab',
        title: 'OS lab',
        start: '2024-06-04T08:00:00.000Z',
        end: '2024-06-04T10:00:00.000Z',
        allDay: false,
        location: 'Lab 3',
        webLink: 'https://outlook.office365.com/owa/?itemid=1',
      },
      { id: 'holiday', title: 'Holiday', start: '2024-06-07', end: '2024-06-08', allDay: true },
    ]);

    const [viewUrl, init] = fetchMock.mock.calls[1];
    expect(viewUrl).toBe(
      `${GRAPH_CALENDAR_VIEW_ENDPOINT}?startDateTime=2024-06-03T00%3A00%3A00.000Z` +
        '&endDateTime=2024-06-10T00%3A00%3A00.000Z' +
        '&$select=id,subject,start,end,isAllDay,isCancelled,location,webLink' +
        '&$orderby=start/dateTime&$top=100'
    );
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Prefer: 'outlook.timezone="UTC"',
    });
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=abc'
    );
  });

  it('never sends the token to a paging link off graph.microsoft.com', async () => {
    const context = setup();
    context.fetchMock
      .mockResolvedValueOnce(TOKEN_RESPONSE)
      .mockResolvedValueOnce(
        jsonResponse({
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com.attacker.example/steal',
        })
      );
    await signIn(context);

    await expect(context.provider.listEvents(WEEK)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(context.fetchMock).toHaveBeenCalledTimes(2);
  });
});
