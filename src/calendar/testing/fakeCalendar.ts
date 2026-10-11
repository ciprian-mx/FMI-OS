/**
 * Test doubles for the calendar providers' browser seams: a scriptable OAuth
 * pop-up (no real window, no provider, no network) and a JSON response builder
 * for injected `fetch` fakes.
 *
 * ```ts
 * const popup = createFakeOAuthPopup();
 * const provider = createGoogleCalendarProvider(config, { popup: popup.deps, fetch });
 * const signIn = provider.connect();
 * const state = popup.lastAuthorizationUrl().searchParams.get('state') ?? '';
 * popup.respond({ access_token: 'token', token_type: 'Bearer', state });
 * await signIn;
 * ```
 *
 * `respond` plays the part of `public/calendar-oauth-callback.js` relaying the
 * provider's redirect; wrap it in `act()` when a component is listening.
 */
import type { HttpResponseLike } from '../calendarProvider';
import {
  OAUTH_CALLBACK_MESSAGE_TYPE,
  OAuthCallbackMessage,
  OAuthPopupDeps,
  PopupWindowLike,
} from '../oauthPopup';

export interface FakeOAuthPopup {
  /** Inject as the provider's `popup` dependency. */
  readonly deps: OAuthPopupDeps;
  /** URLs the pop-up was opened with. */
  readonly opened: readonly string[];
  /** URLs the pop-up was navigated to: the authorization requests. */
  readonly navigations: readonly string[];
  /** Whether FMI OS closed the pop-up. */
  readonly closed: boolean;
  /** Callback listeners currently subscribed. */
  listenerCount(): number;
  /** The latest authorization request; throws if the pop-up was never navigated. */
  lastAuthorizationUrl(): URL;
  /** Relays a provider redirect carrying `params` in the fragment (default) or query. */
  respond(params: Record<string, string>, where?: 'hash' | 'search'): void;
  /** Makes the next `openPopup` fail, as a pop-up blocker would. */
  block(): void;
}

export function createFakeOAuthPopup(): FakeOAuthPopup {
  const opened: string[] = [];
  const navigations: string[] = [];
  const listeners = new Set<(message: OAuthCallbackMessage) => void>();
  let blockNext = false;
  let closed = false;

  const popup: PopupWindowLike = {
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
    location: {
      replace(url: string) {
        navigations.push(url);
      },
    },
  };

  const deps: OAuthPopupDeps = {
    openPopup(url) {
      opened.push(url);
      if (blockNext) {
        blockNext = false;
        return null;
      }
      closed = false;
      return popup;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    deps,
    opened,
    navigations,
    get closed() {
      return closed;
    },
    listenerCount: () => listeners.size,
    lastAuthorizationUrl() {
      const last = navigations[navigations.length - 1];
      if (last === undefined) {
        throw new Error('The sign-in pop-up was never navigated.');
      }
      return new URL(last);
    },
    respond(params, where = 'hash') {
      const query = new URLSearchParams(params).toString();
      const message: OAuthCallbackMessage = {
        type: OAUTH_CALLBACK_MESSAGE_TYPE,
        search: where === 'search' ? `?${query}` : '',
        hash: where === 'hash' ? `#${query}` : '',
      };
      Array.from(listeners).forEach((listener) => listener(message));
    },
    block() {
      blockNext = true;
    },
  };
}

/** A `fetch` response with a JSON body. */
export function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
