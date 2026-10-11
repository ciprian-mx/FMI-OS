import { webcrypto } from 'crypto';
import {
  authorizeInPopup,
  base64UrlEncode,
  createBrowserPopupDeps,
  createCodeChallenge,
  createCodeVerifier,
  DigestSource,
  OAUTH_CALLBACK_MESSAGE_TYPE,
  RandomSource,
} from './oauthPopup';
import { createFakeOAuthPopup } from './testing/fakeCalendar';

/**
 * Task 7.1 — browser-native OAuth plumbing: PKCE values and the pop-up flow
 * that waits for the callback page's relayed response (matching `state` only).
 * jsdom has no SubtleCrypto, so Node's Web Crypto is injected for hashing.
 *
 * Validates: Requirements 10.2, 10.5
 */

const subtle = webcrypto.subtle as unknown as DigestSource;

describe('PKCE', () => {
  it('derives the RFC 7636 S256 code challenge', async () => {
    await expect(
      createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', subtle)
    ).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates 43-character base64url verifiers from 32 random bytes', () => {
    const getRandomValues = jest.fn((bytes: Uint8Array) => bytes.fill(0xfb));
    const verifier = createCodeVerifier({ getRandomValues } as unknown as RandomSource);

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).toBe(base64UrlEncode(new Uint8Array(32).fill(0xfb)));
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});

describe('authorizeInPopup', () => {
  it('opens the pop-up synchronously and resolves with the response matching its state', async () => {
    const popup = createFakeOAuthPopup();
    const pending = authorizeInPopup({
      authorizationUrl: 'https://login.example/authorize?state=s1',
      state: 's1',
      deps: popup.deps,
    });

    // Opened and navigated before the first await, i.e. inside the click.
    expect(popup.opened).toEqual(['about:blank']);
    expect(popup.navigations).toEqual(['https://login.example/authorize?state=s1']);

    popup.respond({ state: 'forged', code: 'attacker-code' });
    popup.respond({ state: 's1', code: 'real-code' });

    await expect(pending).resolves.toEqual(new URLSearchParams({ state: 's1', code: 'real-code' }));
    expect(popup.closed).toBe(true);
    expect(popup.listenerCount()).toBe(0);
  });

  it('builds the authorization URL asynchronously when asked to', async () => {
    const popup = createFakeOAuthPopup();
    const pending = authorizeInPopup({
      authorizationUrl: async () => 'https://login.example/authorize',
      state: 's2',
      deps: popup.deps,
    });
    expect(popup.opened).toHaveLength(1);

    popup.respond({ state: 's2', code: 'c' }, 'search');

    await expect(pending).resolves.toEqual(new URLSearchParams({ state: 's2', code: 'c' }));
    expect(popup.navigations).toEqual(['https://login.example/authorize']);
  });

  it('reports a blocked pop-up', async () => {
    const popup = createFakeOAuthPopup();
    popup.block();

    await expect(
      authorizeInPopup({ authorizationUrl: 'https://login.example', state: 's', deps: popup.deps })
    ).rejects.toMatchObject({ kind: 'popup-blocked' });
  });

  it('is cancelled by its signal, closing the pop-up', async () => {
    const popup = createFakeOAuthPopup();
    const controller = new AbortController();
    const pending = authorizeInPopup({
      authorizationUrl: 'https://login.example',
      state: 's',
      signal: controller.signal,
      deps: popup.deps,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(popup.closed).toBe(true);
    expect(popup.listenerCount()).toBe(0);
  });

  it('gives up when sign-in takes too long', async () => {
    jest.useFakeTimers();
    try {
      const popup = createFakeOAuthPopup();
      const pending = authorizeInPopup({
        authorizationUrl: 'https://login.example',
        state: 's',
        timeoutMs: 1000,
        deps: popup.deps,
      });

      jest.advanceTimersByTime(1000);

      await expect(pending).rejects.toMatchObject({ kind: 'auth' });
      expect(popup.closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createBrowserPopupDeps', () => {
  it('accepts relayed responses from its own origin only', () => {
    const listener = jest.fn();
    const unsubscribe = createBrowserPopupDeps(window).subscribe(listener);
    const message = { type: OAUTH_CALLBACK_MESSAGE_TYPE, search: '', hash: '#state=s&code=c' };
    const post = (data: unknown, origin: string) =>
      window.dispatchEvent(new MessageEvent('message', { data, origin }));

    post(message, 'https://attacker.example');
    post({ type: 'something-else' }, window.location.origin);
    post(message, window.location.origin);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(message);

    unsubscribe();
    post(message, window.location.origin);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
