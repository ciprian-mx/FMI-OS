import { readFileSync } from 'fs';
import { join } from 'path';
import { OAUTH_CALLBACK_CHANNEL, OAUTH_CALLBACK_MESSAGE_TYPE } from './oauthPopup';

/**
 * Task 7.1 — the static page OAuth providers redirect the sign-in pop-up to
 * (`public/calendar-oauth-callback.js`). It must relay the response on the
 * channel `oauthPopup.ts` listens to, strip it from the address bar, and close.
 *
 * Validates: Requirement 10.2
 */

const SCRIPT = readFileSync(
  join(__dirname, '..', '..', 'public', 'calendar-oauth-callback.js'),
  'utf8'
);

class FakeBroadcastChannel {
  static posted: Array<{ name: string; message: unknown }> = [];

  constructor(private readonly name: string) {}

  postMessage(message: unknown): void {
    FakeBroadcastChannel.posted.push({ name: this.name, message });
  }

  close(): void {}
}

const globals = globalThis as unknown as { BroadcastChannel?: unknown };

describe('calendar OAuth callback page', () => {
  const originalChannel = globals.BroadcastChannel;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeBroadcastChannel.posted = [];
    globals.BroadcastChannel = FakeBroadcastChannel;
  });

  afterEach(() => {
    globals.BroadcastChannel = originalChannel;
    jest.useRealTimers();
    jest.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('relays the response to FMI OS, removes it from the address bar and closes', () => {
    const close = jest.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState(
      null,
      '',
      '/calendar-oauth-callback.html?code=abc#access_token=secret&state=s1'
    );

    // eslint-disable-next-line no-new-func
    new Function(SCRIPT)();

    expect(FakeBroadcastChannel.posted).toEqual([
      {
        name: OAUTH_CALLBACK_CHANNEL,
        message: {
          type: OAUTH_CALLBACK_MESSAGE_TYPE,
          search: '?code=abc',
          hash: '#access_token=secret&state=s1',
        },
      },
    ]);
    expect(window.location.href).toBe('http://localhost/calendar-oauth-callback.html');
    expect(close).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
