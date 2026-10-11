import {
  createCalendarProviders,
  DEFAULT_MICROSOFT_TENANT,
  resolveCalendarConfig,
} from './calendarConfig';

/**
 * Task 7.1 — environment configuration. A provider exists only when its
 * client ID is configured (otherwise API mode is unavailable and the app falls
 * back to iframe mode), and the OAuth redirect URI never leaves the app origin.
 *
 * Validates: Requirements 10.2, 10.3
 */

const ORIGIN = 'https://fmi-os.example.edu';
const CALLBACK = `${ORIGIN}/calendar-oauth-callback.html`;

describe('resolveCalendarConfig', () => {
  it('offers no providers when no client ID is configured', () => {
    const config = resolveCalendarConfig({}, ORIGIN);

    expect(config).toEqual({
      googleClientId: null,
      microsoftClientId: null,
      microsoftTenant: DEFAULT_MICROSOFT_TENANT,
      redirectUri: CALLBACK,
      embedUrl: null,
    });
    expect(createCalendarProviders(config)).toEqual([]);
  });

  it('creates a Google and an Outlook provider from their client IDs', () => {
    const config = resolveCalendarConfig(
      {
        REACT_APP_GOOGLE_CLIENT_ID: ' 123-abc.apps.googleusercontent.com ',
        REACT_APP_MS_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
        REACT_APP_MS_TENANT_ID: 'unibuc.ro',
        REACT_APP_CALENDAR_EMBED_URL: ' https://calendar.google.com/calendar/embed?src=x ',
      },
      ORIGIN
    );

    expect(config).toMatchObject({
      googleClientId: '123-abc.apps.googleusercontent.com',
      microsoftClientId: '11111111-2222-3333-4444-555555555555',
      microsoftTenant: 'unibuc.ro',
      embedUrl: 'https://calendar.google.com/calendar/embed?src=x',
    });
    expect(
      createCalendarProviders(config).map((provider) => [
        provider.id,
        provider.label,
        provider.isConnected(),
      ])
    ).toEqual([
      ['google', 'Google Calendar', false],
      ['outlook', 'Outlook Calendar', false],
    ]);
  });

  it('ignores malformed client IDs and tenants', () => {
    const config = resolveCalendarConfig(
      {
        REACT_APP_GOOGLE_CLIENT_ID: 'not a client id',
        REACT_APP_MS_CLIENT_ID: '../evil',
        REACT_APP_MS_TENANT_ID: 'common/../../evil',
      },
      ORIGIN
    );

    expect(config.googleClientId).toBeNull();
    expect(config.microsoftClientId).toBeNull();
    expect(config.microsoftTenant).toBe(DEFAULT_MICROSOFT_TENANT);
  });

  it('keeps the redirect URI on the app origin', () => {
    const redirect = (env: Parameters<typeof resolveCalendarConfig>[0]) =>
      resolveCalendarConfig(env, ORIGIN).redirectUri;

    expect(redirect({ PUBLIC_URL: '/fmi-os/' })).toBe(
      `${ORIGIN}/fmi-os/calendar-oauth-callback.html`
    );
    expect(redirect({ REACT_APP_CALENDAR_REDIRECT_URI: `${ORIGIN}/auth/calendar.html` })).toBe(
      `${ORIGIN}/auth/calendar.html`
    );
    expect(redirect({ REACT_APP_CALENDAR_REDIRECT_URI: 'https://attacker.example/steal' })).toBe(
      CALLBACK
    );
    expect(redirect({ PUBLIC_URL: 'https://cdn.example.com/app' })).toBe(CALLBACK);
  });

  it('creates no providers outside a browser', () => {
    const config = resolveCalendarConfig(
      { REACT_APP_GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com' },
      null
    );

    expect(config.redirectUri).toBeNull();
    expect(createCalendarProviders(config)).toEqual([]);
  });
});
