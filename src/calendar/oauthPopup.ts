/**
 * Browser-native OAuth 2.0 helpers for the calendar providers (Task 7.1,
 * Requirement 10.2). No SDK and no new dependency: Web Crypto for PKCE and
 * random `state` values, `window.open` for the sign-in pop-up, and a same-origin
 * relay page for the response.
 *
 * Flow:
 *   1. {@link authorizeInPopup} opens a pop-up synchronously, inside the
 *      student's click (pop-up blockers only allow that), then navigates it to
 *      the provider's authorization URL.
 *   2. The provider redirects the pop-up to FMI OS's static callback page
 *      (`public/calendar-oauth-callback.html`). Its script strips the response
 *      from the address bar, relays it as an {@link OAuthCallbackMessage} over a
 *      BroadcastChannel (and `window.opener.postMessage` when the opener is
 *      still reachable), then closes the pop-up.
 *   3. The waiting flow accepts only a response whose `state` matches the one
 *      it generated (CSRF / response-injection protection).
 *
 * Why a relay instead of polling `popup.location`: provider sign-in pages send
 * Cross-Origin-Opener-Policy headers that can sever the opener relationship, so
 * the FMI OS window may be unable to read the pop-up's location or even tell
 * whether it is still open. A same-origin BroadcastChannel is unaffected. For
 * the same reason a closed pop-up is not treated as "cancelled"; the flow ends
 * on a response, on the student pressing Cancel (`signal`), or on a timeout.
 */
import { CalendarProviderError } from './calendarProvider';
import type { FetchLike } from './calendarProvider';

/* -------------------------------------------------------------------------- *
 * Randomness and PKCE (RFC 7636)
 * -------------------------------------------------------------------------- */

export type RandomSource = Pick<Crypto, 'getRandomValues'>;
export type DigestSource = Pick<SubtleCrypto, 'digest'>;

function ambientCrypto(): Crypto {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new CalendarProviderError('auth', 'Secure random numbers are unavailable in this browser.');
  }
  return crypto;
}

function ambientSubtle(): DigestSource {
  const subtle = ambientCrypto().subtle;
  if (!subtle) {
    // Browsers only expose SubtleCrypto in secure contexts (HTTPS / localhost).
    throw new CalendarProviderError('auth', 'Web Crypto is unavailable; FMI OS must be served over HTTPS.');
  }
  return subtle;
}

/** Unpadded base64url (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `byteLength` CSPRNG bytes as base64url. */
export function randomUrlSafeString(
  byteLength: number,
  random: RandomSource = ambientCrypto()
): string {
  const bytes = new Uint8Array(byteLength);
  random.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Bytes of entropy in `state` values. */
export const STATE_BYTES = 16;

/** A PKCE code verifier: 32 CSPRNG bytes → 43 base64url characters. */
export function createCodeVerifier(random?: RandomSource): string {
  return randomUrlSafeString(32, random);
}

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** The S256 code challenge: BASE64URL(SHA-256(ASCII(verifier))). */
export async function createCodeChallenge(
  verifier: string,
  subtle: DigestSource = ambientSubtle()
): Promise<string> {
  if (!CODE_VERIFIER_PATTERN.test(verifier)) {
    throw new CalendarProviderError('auth', 'Invalid PKCE code verifier.');
  }
  // The verifier is ASCII by construction, so its UTF-8 bytes are its char codes.
  const data = new Uint8Array(verifier.length);
  for (let index = 0; index < verifier.length; index += 1) {
    data[index] = verifier.charCodeAt(index);
  }
  const digest = await subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** `base` with `params` set on its query string (undefined values skipped). */
export function withQuery(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/* -------------------------------------------------------------------------- *
 * Callback relay
 * -------------------------------------------------------------------------- */

/** BroadcastChannel the callback page posts to. Keep in sync with the page's script. */
export const OAUTH_CALLBACK_CHANNEL = 'fmios-calendar-oauth';

/** `type` of every relayed message. Keep in sync with the page's script. */
export const OAUTH_CALLBACK_MESSAGE_TYPE = 'fmios-calendar-oauth-callback';

/** What the callback page relays: the query string and fragment it was opened with. */
export interface OAuthCallbackMessage {
  readonly type: typeof OAUTH_CALLBACK_MESSAGE_TYPE;
  readonly search: string;
  readonly hash: string;
}

const MAX_CALLBACK_LENGTH = 16384;

/** `data` as an {@link OAuthCallbackMessage}, or null when it is anything else. */
export function parseOAuthCallbackMessage(data: unknown): OAuthCallbackMessage | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const { type, search, hash } = data as Record<string, unknown>;
  if (
    type !== OAUTH_CALLBACK_MESSAGE_TYPE ||
    typeof search !== 'string' ||
    typeof hash !== 'string' ||
    search.length + hash.length > MAX_CALLBACK_LENGTH
  ) {
    return null;
  }
  return { type: OAUTH_CALLBACK_MESSAGE_TYPE, search, hash };
}

/** The response parameters from the query and the fragment (fragment wins). */
export function callbackParams(message: OAuthCallbackMessage): URLSearchParams {
  const params = new URLSearchParams(message.search.replace(/^\?/, ''));
  new URLSearchParams(message.hash.replace(/^#/, '')).forEach((value, key) => {
    params.set(key, value);
  });
  return params;
}

/* -------------------------------------------------------------------------- *
 * Pop-up
 * -------------------------------------------------------------------------- */

/** The part of a pop-up `Window` the flow uses. */
export interface PopupWindowLike {
  readonly closed: boolean;
  close(): void;
  readonly location: { replace(url: string): void };
}

/** Browser seams of the pop-up flow; tests inject fakes. */
export interface OAuthPopupDeps {
  /** Opens the sign-in pop-up at `url`; null when the browser blocks it. */
  openPopup(url: string): PopupWindowLike | null;
  /** Delivers relayed callback messages to `listener`; returns an unsubscribe function. */
  subscribe(listener: (message: OAuthCallbackMessage) => void): () => void;
}

export const OAUTH_POPUP_NAME = 'fmios-calendar-oauth';
export const OAUTH_POPUP_FEATURES = 'popup=yes,width=520,height=680';

/** How long the student has to finish signing in before the attempt fails. */
export const OAUTH_POPUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The real pop-up seams: `window.open` (without `noopener`, so FMI OS can
 * navigate and close the pop-up it opened) and a listener on both the relay
 * BroadcastChannel and same-origin `message` events.
 */
export function createBrowserPopupDeps(win: Window = window): OAuthPopupDeps {
  return {
    openPopup: (url) => win.open(url, OAUTH_POPUP_NAME, OAUTH_POPUP_FEATURES),
    subscribe(listener) {
      const cleanups: Array<() => void> = [];
      if (typeof BroadcastChannel === 'function') {
        const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
        channel.onmessage = (event: MessageEvent) => {
          const message = parseOAuthCallbackMessage(event.data);
          if (message) {
            listener(message);
          }
        };
        cleanups.push(() => channel.close());
      }
      const onWindowMessage = (event: MessageEvent) => {
        // Only FMI OS's own callback page may answer.
        if (event.origin !== win.location.origin) {
          return;
        }
        const message = parseOAuthCallbackMessage(event.data);
        if (message) {
          listener(message);
        }
      };
      win.addEventListener('message', onWindowMessage);
      cleanups.push(() => win.removeEventListener('message', onWindowMessage));
      return () => {
        cleanups.forEach((cleanup) => cleanup());
      };
    },
  };
}

export interface AuthorizeInPopupRequest {
  /**
   * The provider's authorization URL, or a function producing it (e.g. after
   * computing a PKCE challenge, which is asynchronous).
   */
  authorizationUrl: string | (() => string | Promise<string>);
  /** The `state` sent with the request; responses with any other state are ignored. */
  state: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  deps?: OAuthPopupDeps;
}

function cancelledError(): CalendarProviderError {
  return new CalendarProviderError('cancelled', 'Sign-in was cancelled.');
}

/**
 * Runs the interactive leg of an OAuth flow in a pop-up and resolves with the
 * provider's response parameters (query + fragment) once the callback page
 * relays a response whose `state` matches.
 *
 * The pop-up opens before the first `await`, i.e. synchronously within the
 * caller's click handler. Rejects with {@link CalendarProviderError}:
 * `popup-blocked` when the pop-up can't be opened, `cancelled` when `signal`
 * aborts, `auth` when sign-in takes longer than `timeoutMs`. The pop-up is
 * closed (when still reachable) and the listener removed however it ends.
 */
export async function authorizeInPopup(request: AuthorizeInPopupRequest): Promise<URLSearchParams> {
  const { state, signal } = request;
  if (!state) {
    throw new CalendarProviderError('auth', 'Missing OAuth state.');
  }
  if (signal?.aborted) {
    throw cancelledError();
  }
  const deps = request.deps ?? createBrowserPopupDeps();
  // Synchronous on purpose: this must happen inside the student's click.
  const popup = deps.openPopup('about:blank');
  if (!popup) {
    throw new CalendarProviderError('popup-blocked', 'The sign-in pop-up was blocked.');
  }

  const cleanups: Array<() => void> = [];
  const response = new Promise<URLSearchParams>((resolve, reject) => {
    cleanups.push(
      deps.subscribe((message) => {
        const params = callbackParams(message);
        if (params.get('state') === state) {
          resolve(params);
        }
      })
    );
    const timer = setTimeout(
      () => reject(new CalendarProviderError('auth', 'Sign-in timed out.')),
      request.timeoutMs ?? OAUTH_POPUP_TIMEOUT_MS
    );
    cleanups.push(() => clearTimeout(timer));
    if (signal) {
      const onAbort = () => reject(cancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
  });
  // Awaited below; this only keeps an early rejection from being reported as unhandled.
  response.catch(() => undefined);

  try {
    const url =
      typeof request.authorizationUrl === 'function'
        ? await request.authorizationUrl()
        : request.authorizationUrl;
    if (signal?.aborted) {
      throw cancelledError();
    }
    try {
      popup.location.replace(url);
    } catch (error) {
      throw new CalendarProviderError('popup-blocked', 'The sign-in pop-up could not be opened.', error);
    }
    return await response;
  } finally {
    cleanups.forEach((cleanup) => cleanup());
    try {
      if (!popup.closed) {
        popup.close();
      }
    } catch {
      // Unreachable after a COOP severance; the callback page closes itself.
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Provider dependencies
 * -------------------------------------------------------------------------- */

/** Injectable dependencies shared by the OAuth-backed calendar providers. */
export interface OAuthProviderDeps {
  /** HTTP client. Defaults to the ambient `fetch`. */
  fetch?: FetchLike;
  /** CSPRNG for `state` and PKCE values. Defaults to Web Crypto. */
  random?: RandomSource;
  /** Pop-up seams. Default: {@link createBrowserPopupDeps}. */
  popup?: OAuthPopupDeps;
  /** Clock for token expiry. Defaults to `Date.now`. */
  now?: () => number;
  /** Sign-in timeout. Defaults to {@link OAUTH_POPUP_TIMEOUT_MS}. */
  popupTimeoutMs?: number;
}
