import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CalendarApp, {
  CALENDAR_MESSAGES,
  CALENDAR_REFRESH_INTERVAL_MS,
  CalendarAppProps,
  IFRAME_LOAD_TIMEOUT_MS,
} from './CalendarApp';
import { calendarCacheKey, createMemoryEventCache } from './calendarCache';
import { EMBED_SANDBOX, EMBED_URL_ERROR } from './calendarEmbed';
import { CalendarEvent, DateRange, weekRange } from './calendarEvents';
import {
  CalendarProviderError,
  CalendarRequestOptions,
  FetchLike,
} from './calendarProvider';
import {
  createGoogleCalendarProvider,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_EVENTS_ENDPOINT,
} from './googleCalendarProvider';
import { createFakeOAuthPopup, jsonResponse } from './testing/fakeCalendar';

/**
 * Task 7.1 — CalendarApp with dual integration mode.
 *
 * API mode runs against scripted providers (and, for the token check, the
 * real Google provider over a fake pop-up and fetch); iframe mode against the
 * embed allowlist. Fake timers drive the 15-minute refresh. No real OAuth app
 * or network call is involved. `now` is pinned to Wednesday 5 June 2024 and
 * event times are built from local components, so the week layout is the same
 * in every time zone.
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5
 */

const NOW = new Date(2024, 5, 5, 12, 0);
const WEEK = weekRange(NOW); // Monday 3 June → Monday 10 June
const at = (day: number, hour: number, minute = 0) =>
  new Date(2024, 5, day, hour, minute).toISOString();

const LECTURE: CalendarEvent = {
  id: 'lecture',
  title: 'Algorithms lecture',
  start: at(3, 10),
  end: at(3, 12),
  allDay: false,
  location: 'Room 214',
};
const HACKATHON: CalendarEvent = {
  id: 'hackathon',
  title: 'FMI Hackathon',
  start: '2024-06-05',
  end: '2024-06-07',
  allDay: true,
};
const UNTITLED: CalendarEvent = {
  id: 'untitled',
  title: '',
  start: at(7, 9),
  end: at(7, 9, 30),
  allDay: false,
};
const EVENTS = [UNTITLED, HACKATHON, LECTURE];

const GOOGLE_EMBED =
  'https://calendar.google.com/calendar/embed?src=student%40s.unibuc.ro&ctz=Europe%2FBucharest';

function createMockProvider({ connected = false, events = EVENTS } = {}) {
  let isConnected = connected;
  return {
    id: 'google',
    label: 'Google Calendar',
    connect: jest.fn(async (_options?: CalendarRequestOptions) => {
      isConnected = true;
    }),
    isConnected: jest.fn(() => isConnected),
    listEvents: jest.fn(
      async (_range: DateRange, _options?: CalendarRequestOptions): Promise<CalendarEvent[]> =>
        events
    ),
    disconnect: jest.fn(() => {
      isConnected = false;
    }),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Renders the app with nothing configured unless the test says otherwise. */
function renderCalendar(props: CalendarAppProps = {}) {
  return render(
    <CalendarApp
      providers={[]}
      externalCalendarUrl=""
      eventCache={createMemoryEventCache()}
      now={NOW}
      {...props}
    />
  );
}

const day = (key: string) => within(screen.getByTestId(`calendar-day-${key}`));
const errorBox = () => within(screen.getByTestId('calendar-error'));

describe('CalendarApp: API mode', () => {
  it('connects a provider, then fetches and renders the week of events', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider();
    const signIn = deferred<void>();
    provider.connect.mockReturnValueOnce(signIn.promise);
    renderCalendar({ providers: [provider] });

    expect(screen.getByTestId('calendar-app')).toHaveAttribute('data-mode', 'api');
    await user.click(screen.getByRole('button', { name: 'Connect Google Calendar' }));

    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('calendar-connecting')).toHaveTextContent(
      CALENDAR_MESSAGES.connecting('Google Calendar')
    );
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeDisabled();
    expect(provider.listEvents).not.toHaveBeenCalled();

    await act(async () => signIn.resolve());

    expect(await screen.findByText('Algorithms lecture')).toBeInTheDocument();
    expect(provider.listEvents).toHaveBeenCalledTimes(1);
    expect(provider.listEvents.mock.calls[0][0]).toEqual(WEEK);
    expect(day('2024-06-03').getByText('Room 214')).toBeInTheDocument();
    for (const key of ['2024-06-05', '2024-06-06']) {
      expect(day(key).getByText('FMI Hackathon')).toBeInTheDocument();
      expect(day(key).getByText('All day')).toBeInTheDocument();
    }
    expect(day('2024-06-07').queryByText('FMI Hackathon')).not.toBeInTheDocument();
    expect(day('2024-06-07').getByText('Untitled event')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-day-2024-06-05')).toHaveAttribute('aria-current', 'date');
    expect(screen.getByTestId('calendar-status')).toHaveTextContent('Connected to Google Calendar');
  });

  it('fetches the next week when navigating and shows the empty state', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider({ connected: true });
    renderCalendar({ providers: [provider] });
    await screen.findByText('Algorithms lecture');

    provider.listEvents.mockResolvedValueOnce([]);
    await user.click(screen.getByRole('button', { name: 'Next week' }));

    expect(await screen.findByTestId('calendar-empty')).toHaveTextContent(CALENDAR_MESSAGES.empty);
    expect(provider.listEvents).toHaveBeenLastCalledWith(weekRange(NOW, 1), expect.anything());
  });

  it('keeps the provider access token in memory only', async () => {
    const user = userEvent.setup();
    const token = 'ya29.secret-access-token';
    const popup = createFakeOAuthPopup();
    const fetchMock = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'lecture',
            summary: 'Algorithms lecture',
            start: { dateTime: at(3, 10) },
            end: { dateTime: at(3, 12) },
          },
        ],
      })
    );
    const provider = createGoogleCalendarProvider(
      {
        clientId: '123-abc.apps.googleusercontent.com',
        redirectUri: 'http://localhost/calendar-oauth-callback.html',
      },
      { fetch: fetchMock, popup: popup.deps }
    );
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    renderCalendar({ providers: [provider] });

    await user.click(screen.getByRole('button', { name: 'Connect Google Calendar' }));
    const authorization = popup.lastAuthorizationUrl();
    expect(`${authorization.origin}${authorization.pathname}`).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    await act(async () =>
      popup.respond({
        access_token: token,
        token_type: 'Bearer',
        expires_in: '3599',
        scope: GOOGLE_CALENDAR_SCOPE,
        state: authorization.searchParams.get('state') ?? '',
      })
    );

    expect(await screen.findByText('Algorithms lecture')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(GOOGLE_EVENTS_ENDPOINT),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      })
    );
    // Nowhere persistent, and not in the DOM either.
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(token);
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        expect(storage.getItem(storage.key(index) ?? '')).not.toContain(token);
      }
    }
    expect(document.cookie).not.toContain(token);
    expect(document.documentElement.innerHTML).not.toContain(token);
    setItem.mockRestore();
  });

  it('shows cached events again immediately when the window is reopened', async () => {
    const cache = createMemoryEventCache();
    const provider = createMockProvider({ connected: true });
    const first = renderCalendar({ providers: [provider], eventCache: cache });
    await screen.findByText('Algorithms lecture');
    first.unmount();

    provider.listEvents.mockReturnValueOnce(new Promise<CalendarEvent[]>(() => undefined));
    renderCalendar({ providers: [provider], eventCache: cache });

    expect(screen.getByText('Algorithms lecture')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-status')).toHaveTextContent('refreshing');
    expect(screen.queryByTestId('calendar-loading')).not.toBeInTheDocument();
  });

  it('disconnects, forgets the cached events and offers to connect again', async () => {
    const user = userEvent.setup();
    const cache = createMemoryEventCache();
    const provider = createMockProvider({ connected: true });
    renderCalendar({ providers: [provider], eventCache: cache });
    await screen.findByText('Algorithms lecture');

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(provider.disconnect).toHaveBeenCalledTimes(1);
    expect(cache.read(calendarCacheKey('google', WEEK))).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeInTheDocument();
    expect(screen.queryByText('Algorithms lecture')).not.toBeInTheDocument();
  });
});

describe('CalendarApp: errors and retry', () => {
  it('reports an unavailable source and recovers on Retry', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider({ connected: true });
    provider.listEvents.mockRejectedValueOnce(new CalendarProviderError('unavailable', 'HTTP 503'));
    renderCalendar({ providers: [provider] });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      CALENDAR_MESSAGES.unavailable('Google Calendar')
    );
    await user.click(errorBox().getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Algorithms lecture')).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-error')).not.toBeInTheDocument();
    expect(provider.listEvents).toHaveBeenCalledTimes(2);
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it('keeps showing cached events when a refresh fails', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider({ connected: true });
    renderCalendar({ providers: [provider] });
    await screen.findByText('Algorithms lecture');

    provider.listEvents.mockRejectedValueOnce(new CalendarProviderError('unavailable', 'offline'));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      CALENDAR_MESSAGES.unavailable('Google Calendar')
    );
    expect(screen.getByText('Algorithms lecture')).toBeInTheDocument();
  });

  it('asks the student to sign in again when the session has expired', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider({ connected: true });
    provider.listEvents.mockRejectedValueOnce(new CalendarProviderError('auth', 'HTTP 401'));
    renderCalendar({ providers: [provider] });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      CALENDAR_MESSAGES.sessionExpired('Google Calendar')
    );
    await user.click(errorBox().getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Algorithms lecture')).toBeInTheDocument();
    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(provider.listEvents).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('calendar-error')).not.toBeInTheDocument();
  });

  it('reports a failed sign-in and retries it', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider();
    provider.connect.mockRejectedValueOnce(new CalendarProviderError('popup-blocked', 'blocked'));
    renderCalendar({ providers: [provider] });

    await user.click(screen.getByRole('button', { name: 'Connect Google Calendar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(CALENDAR_MESSAGES.popupBlocked);

    await user.click(errorBox().getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Algorithms lecture')).toBeInTheDocument();
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });
});

describe('CalendarApp: iframe mode', () => {
  it('embeds an allowlisted https calendar in a restrictive sandbox', () => {
    renderCalendar({ integrationType: 'iframe', externalCalendarUrl: GOOGLE_EMBED });

    const frame = screen.getByTitle('Embedded Google Calendar');
    expect(screen.getByTestId('calendar-app')).toHaveAttribute('data-mode', 'iframe');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', GOOGLE_EMBED);
    expect(frame).toHaveAttribute('sandbox', EMBED_SANDBOX);
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-top-navigation|allow-forms|allow-modals/);
  });

  it.each([
    'http://calendar.google.com/calendar/embed?src=x',
    'https://calendar.google.com.evil.example/calendar/embed',
    'https://evil.example/calendar',
    'javascript:alert(1)',
  ])('refuses to embed %s', (url) => {
    renderCalendar({ integrationType: 'iframe', externalCalendarUrl: url });

    expect(screen.queryByTestId('calendar-iframe')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(EMBED_URL_ERROR);
  });

  it('falls back to the embedded calendar when API sign-in is not configured', () => {
    renderCalendar({ integrationType: 'api', providers: [], externalCalendarUrl: GOOGLE_EMBED });

    expect(screen.getByTestId('calendar-app')).toHaveAttribute('data-mode', 'iframe');
    expect(screen.getByTestId('calendar-iframe')).toHaveAttribute('src', GOOGLE_EMBED);
    expect(screen.getByTestId('calendar-fallback-note')).toHaveTextContent(
      CALENDAR_MESSAGES.fallbackNote
    );
  });

  it('explains when neither sign-in nor an embed link is configured', () => {
    renderCalendar();

    expect(screen.getByTestId('calendar-not-configured')).toHaveTextContent(
      CALENDAR_MESSAGES.notConfigured
    );
    expect(screen.queryByTestId('calendar-iframe')).not.toBeInTheDocument();
  });

  it('lets the student switch to the embedded calendar when the API fails, and back', async () => {
    const user = userEvent.setup();
    const provider = createMockProvider({ connected: true });
    provider.listEvents.mockRejectedValue(new CalendarProviderError('unavailable', 'HTTP 503'));
    renderCalendar({ providers: [provider], externalCalendarUrl: GOOGLE_EMBED });
    await screen.findByRole('alert');

    await user.click(errorBox().getByRole('button', { name: 'Use embedded calendar instead' }));
    expect(screen.getByTestId('calendar-app')).toHaveAttribute('data-mode', 'iframe');
    expect(screen.getByTestId('calendar-iframe')).toHaveAttribute('src', GOOGLE_EMBED);

    provider.listEvents.mockResolvedValue(EVENTS);
    await user.click(screen.getByRole('button', { name: 'Connect a calendar account' }));
    expect(screen.getByTestId('calendar-app')).toHaveAttribute('data-mode', 'api');
    expect(await screen.findByText('Algorithms lecture')).toBeInTheDocument();
  });
});

describe('CalendarApp: auto-refresh and timeouts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-fetches every 15 minutes while open and stops once closed', async () => {
    const provider = createMockProvider({ connected: true });
    const { unmount } = renderCalendar({ providers: [provider] });
    await act(async () => undefined);
    expect(provider.listEvents).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(CALENDAR_REFRESH_INTERVAL_MS - 1);
    });
    expect(provider.listEvents).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(provider.listEvents).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(CALENDAR_REFRESH_INTERVAL_MS);
    });
    expect(provider.listEvents).toHaveBeenCalledTimes(3);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(4 * CALENDAR_REFRESH_INTERVAL_MS);
    expect(provider.listEvents).toHaveBeenCalledTimes(3);
  });

  it('never refreshes less often than every 15 minutes', async () => {
    const provider = createMockProvider({ connected: true });
    renderCalendar({ providers: [provider], refreshIntervalMs: 60 * 60 * 1000 });
    await act(async () => undefined);

    await act(async () => {
      jest.advanceTimersByTime(CALENDAR_REFRESH_INTERVAL_MS);
    });
    expect(provider.listEvents).toHaveBeenCalledTimes(2);
  });

  it('reloads the embedded calendar every 15 minutes while open and stops once closed', () => {
    const { unmount } = renderCalendar({
      integrationType: 'iframe',
      externalCalendarUrl: GOOGLE_EMBED,
    });
    const first = screen.getByTestId('calendar-iframe');

    act(() => {
      jest.advanceTimersByTime(CALENDAR_REFRESH_INTERVAL_MS);
    });

    const second = screen.getByTestId('calendar-iframe');
    expect(second).not.toBe(first);
    expect(second).toHaveAttribute('src', GOOGLE_EMBED);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports an embedded calendar that does not load, with a Retry that reloads it', () => {
    renderCalendar({ integrationType: 'iframe', externalCalendarUrl: GOOGLE_EMBED });
    const first = screen.getByTestId('calendar-iframe');

    act(() => {
      jest.advanceTimersByTime(IFRAME_LOAD_TIMEOUT_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      CALENDAR_MESSAGES.embedSlow('Google Calendar')
    );

    fireEvent.click(errorBox().getByRole('button', { name: 'Retry' }));
    expect(screen.queryByTestId('calendar-error')).not.toBeInTheDocument();
    const reloaded = screen.getByTestId('calendar-iframe');
    expect(reloaded).not.toBe(first);

    fireEvent.load(reloaded);
    act(() => {
      jest.advanceTimersByTime(IFRAME_LOAD_TIMEOUT_MS);
    });
    expect(screen.queryByTestId('calendar-error')).not.toBeInTheDocument();
  });
});
