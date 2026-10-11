/**
 * @jest-environment node
 */
// Node supplies Web Crypto for the OAuth `state`; no DOM is needed.
import type { CalendarProvider, FetchLike } from './calendarProvider';
import {
  createGoogleCalendarProvider,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_EVENTS_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
} from './googleCalendarProvider';
import { createFakeOAuthPopup, FakeOAuthPopup, jsonResponse } from './testing/fakeCalendar';

/**
 * Task 7.1 — Google Calendar provider: read-only token-flow sign-in through
 * the (fake) pop-up, events.list over an injected fetch, and token hygiene.
 * No real OAuth app or network is involved.
 *
 * Validates: Requirements 10.2, 10.5
 */

const CONFIG = {
  clientId: '123-abc.apps.googleusercontent.com',
  redirectUri: 'https://fmi-os.example.edu/calendar-oauth-callback.html',
};
const WEEK = { start: Date.UTC(2024, 5, 3), end: Date.UTC(2024, 5, 10) };
const TOKEN = 'ya29.test-access-token';

function setup(now?: () => number) {
  const popup = createFakeOAuthPopup();
  const fetchMock = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
  const provider = createGoogleCalendarProvider(CONFIG, { fetch: fetchMock, popup: popup.deps, now });
  return { popup, fetchMock, provider };
}

function stateOf(popup: FakeOAuthPopup): string {
  return popup.lastAuthorizationUrl().searchParams.get('state') ?? '';
}

async function signIn(provider: CalendarProvider, popup: FakeOAuthPopup): Promise<void> {
  const pending = provider.connect();
  popup.respond({
    access_token: TOKEN,
    token_type: 'Bearer',
    expires_in: '3599',
    scope: GOOGLE_CALENDAR_SCOPE,
    state: stateOf(popup),
  });
  await pending;
}

describe('Google Calendar provider: sign-in', () => {
  it('requests read-only event access with the token flow and keeps the token', async () => {
    const { popup, provider } = setup();
    const pending = provider.connect();
    const url = popup.lastAuthorizationUrl();

    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.clientId,
      redirect_uri: CONFIG.redirectUri,
      response_type: 'token',
      scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(provider.isConnected()).toBe(false);

    popup.respond({
      access_token: TOKEN,
      token_type: 'Bearer',
      expires_in: '3599',
      scope: GOOGLE_CALENDAR_SCOPE,
      state: url.searchParams.get('state') ?? '',
    });
    await pending;

    expect(provider.isConnected()).toBe(true);
  });

  it.each([
    ['a denied consent', { error: 'access_denied' }],
    ['unticked calendar access', { access_token: TOKEN, token_type: 'Bearer', scope: 'openid' }],
    ['a missing token', { token_type: 'Bearer' }],
  ])('rejects %s', async (_case, response: Record<string, string>) => {
    const { popup, provider } = setup();
    const pending = provider.connect();
    popup.respond({ ...response, state: stateOf(popup) });

    await expect(pending).rejects.toMatchObject({ kind: 'auth' });
    expect(provider.isConnected()).toBe(false);
  });

  it('treats the token as expired a minute before Google does', async () => {
    let now = 0;
    const { popup, provider } = setup(() => now);
    await signIn(provider, popup);

    now = (3599 - 60) * 1000 - 1;
    expect(provider.isConnected()).toBe(true);
    now += 1;
    expect(provider.isConnected()).toBe(false);
  });
});

describe('Google Calendar provider: events', () => {
  it('lists the primary calendar for the range with the bearer token and maps the events', async () => {
    const { popup, fetchMock, provider } = setup();
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'lecture',
            status: 'confirmed',
            summary: ' Algorithms lecture ',
            location: 'Room 214',
            htmlLink: 'https://www.google.com/calendar/event?eid=1',
            start: { dateTime: '2024-06-03T10:00:00+03:00' },
            end: { dateTime: '2024-06-03T12:00:00+03:00' },
          },
          { id: 'fest', summary: 'Hackathon', start: { date: '2024-06-05' }, end: { date: '2024-06-07' } },
          { id: 'gone', status: 'cancelled', start: { dateTime: '2024-06-04T10:00:00Z' } },
          {
            id: 'phish',
            summary: 'Phish',
            htmlLink: 'javascript:alert(1)',
            start: { dateTime: '2024-06-06T10:00:00Z' },
            end: { dateTime: '2024-06-06T11:00:00Z' },
          },
          { summary: 'No id', start: { dateTime: '2024-06-06T10:00:00Z' } },
        ],
      })
    );
    await signIn(provider, popup);

    await expect(provider.listEvents(WEEK)).resolves.toEqual([
      {
        id: 'lecture',
        title: 'Algorithms lecture',
        start: '2024-06-03T07:00:00.000Z',
        end: '2024-06-03T09:00:00.000Z',
        allDay: false,
        location: 'Room 214',
        webLink: 'https://www.google.com/calendar/event?eid=1',
      },
      { id: 'fest', title: 'Hackathon', start: '2024-06-05', end: '2024-06-07', allDay: true },
      {
        id: 'phish',
        title: 'Phish',
        start: '2024-06-06T10:00:00.000Z',
        end: '2024-06-06T11:00:00.000Z',
        allDay: false,
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    const request = new URL(url);
    expect(`${request.origin}${request.pathname}`).toBe(GOOGLE_EVENTS_ENDPOINT);
    expect(request.searchParams.get('timeMin')).toBe('2024-06-03T00:00:00.000Z');
    expect(request.searchParams.get('timeMax')).toBe('2024-06-10T00:00:00.000Z');
    expect(request.searchParams.get('singleEvents')).toBe('true');
    expect(init).toMatchObject({
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it('follows nextPageToken', async () => {
    const { popup, fetchMock, provider } = setup();
    const item = (id: string) => ({ id, start: { date: '2024-06-04' }, end: { date: '2024-06-05' } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [item('a')], nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(jsonResponse({ items: [item('b')] }));
    await signIn(provider, popup);

    const events = await provider.listEvents(WEEK);

    expect(events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('pageToken')).toBe('page-2');
  });

  it('forgets a token Google rejects, so the student must reconnect', async () => {
    const { popup, fetchMock, provider } = setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 401 } }, 401));
    await signIn(provider, popup);

    await expect(provider.listEvents(WEEK)).rejects.toMatchObject({ kind: 'auth' });
    expect(provider.isConnected()).toBe(false);

    fetchMock.mockClear();
    await expect(provider.listEvents(WEEK)).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports network failures and outages as unavailable and stays connected', async () => {
    const { popup, fetchMock, provider } = setup();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({}, 503));
    await signIn(provider, popup);

    await expect(provider.listEvents(WEEK)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(provider.listEvents(WEEK)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(provider.isConnected()).toBe(true);
  });

  it('forgets and revokes the token on disconnect', async () => {
    const { popup, fetchMock, provider } = setup();
    fetchMock.mockResolvedValue(jsonResponse({}));
    await signIn(provider, popup);

    provider.disconnect();

    expect(provider.isConnected()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      GOOGLE_REVOKE_ENDPOINT,
      expect.objectContaining({ method: 'POST', body: `token=${TOKEN}`, credentials: 'omit' })
    );
  });
});
