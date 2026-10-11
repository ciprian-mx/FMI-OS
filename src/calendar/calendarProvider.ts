/**
 * Calendar provider seam (Task 7.1, Requirement 10.2: "WHERE an external
 * calendar API is available, THE Calendar_App SHALL authenticate the Student
 * with the external calendar provider and fetch event data").
 *
 * The Calendar App talks to every external calendar through
 * {@link CalendarProvider}; `googleCalendarProvider.ts` and
 * `outlookCalendarProvider.ts` are the production implementations and tests
 * inject fakes. This module also holds what those implementations share:
 *
 *   • {@link CalendarProviderError} — typed failures the UI maps to messages
 *     and to the right retry action (Requirement 10.5);
 *   • {@link FetchLike} / {@link requestJson} — the minimal, injectable HTTP
 *     surface (no SDKs, no new dependencies);
 *   • {@link createAccessTokenStore} — the memory-only access-token holder.
 */
import type { CalendarEvent, DateRange } from './calendarEvents';

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

/**
 * Why a provider call failed:
 *   • `auth` — sign-in failed or was refused, or the token expired / was
 *     revoked: retrying means signing in again;
 *   • `popup-blocked` — the browser refused to open the sign-in pop-up;
 *   • `cancelled` — the student (or FMI OS) abandoned the operation;
 *   • `unavailable` — network failure, timeout, provider outage or an
 *     unreadable response: retrying means fetching again.
 */
export type CalendarProviderErrorKind = 'auth' | 'popup-blocked' | 'cancelled' | 'unavailable';

export class CalendarProviderError extends Error {
  readonly kind: CalendarProviderErrorKind;
  /** The underlying failure, for debugging. Never shown to the student. */
  readonly cause?: unknown;

  constructor(kind: CalendarProviderErrorKind, message: string, cause?: unknown) {
    super(message);
    // Keep `instanceof` working when the class is transpiled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CalendarProviderError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** True for DOMException / Error objects named "AbortError". */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Normalizes anything a provider threw: provider errors pass through, aborts
 * become `cancelled`, anything else becomes `fallback`.
 */
export function toCalendarProviderError(
  error: unknown,
  fallback: CalendarProviderErrorKind = 'unavailable'
): CalendarProviderError {
  if (error instanceof CalendarProviderError) {
    return error;
  }
  if (isAbortError(error)) {
    return new CalendarProviderError('cancelled', 'The request was cancelled.', error);
  }
  return new CalendarProviderError(
    fallback,
    error instanceof Error ? error.message : 'Unknown calendar error.',
    error
  );
}

/* -------------------------------------------------------------------------- *
 * Provider contract
 * -------------------------------------------------------------------------- */

export interface CalendarRequestOptions {
  /** Aborts the operation (closing the window, cancelling sign-in, timeouts). */
  signal?: AbortSignal;
}

/**
 * One external calendar. Implementations keep their access token in memory
 * only and reject with {@link CalendarProviderError}.
 */
export interface CalendarProvider {
  /** Stable id, e.g. "google"; also the cache-key prefix. */
  readonly id: string;
  /** Display name, e.g. "Google Calendar". */
  readonly label: string;
  /**
   * Interactive sign-in requesting read-only calendar access. Implementations
   * open a pop-up before their first `await`, so call this synchronously from
   * the click handler or the browser will block the pop-up.
   */
  connect(options?: CalendarRequestOptions): Promise<void>;
  /** True while an unexpired access token is held. */
  isConnected(): boolean;
  /**
   * Events overlapping `range` (start inclusive, end exclusive). Rejects with
   * kind `auth` when not connected or when the provider refuses the token (the
   * token is then forgotten).
   */
  listEvents(range: DateRange, options?: CalendarRequestOptions): Promise<CalendarEvent[]>;
  /** Forgets the access token (implementations may also revoke it). */
  disconnect(): void;
}

/* -------------------------------------------------------------------------- *
 * HTTP
 * -------------------------------------------------------------------------- */

/** The part of `Response` the providers read. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The part of `RequestInit` the providers use. */
export interface HttpRequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  credentials?: 'omit';
  cache?: 'no-store';
  referrerPolicy?: 'no-referrer';
}

/** `window.fetch`, narrowed so tests can inject a fake. */
export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** The ambient `fetch`, resolved at call time (jsdom has none). */
export const browserFetch: FetchLike = (url, init) =>
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch(url, init)
    : Promise.reject(new TypeError('fetch is not available in this environment.'));

/**
 * Applied to every provider request: bearer tokens are the only credential
 * (no cookies), responses are personal data (never HTTP-cached), and FMI OS
 * URLs are not leaked as referrers.
 */
export const BASE_REQUEST_INIT: Readonly<HttpRequestInit> = {
  credentials: 'omit',
  cache: 'no-store',
  referrerPolicy: 'no-referrer',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RequestJsonOptions {
  /** HTTP statuses that mean "sign in again". Defaults to 401 and 403. */
  authStatuses?: readonly number[];
}

/**
 * Sends one request and returns its JSON object body, mapping failures to
 * {@link CalendarProviderError}: aborts → `cancelled`, network errors, other
 * non-2xx statuses and unreadable bodies → `unavailable`, `authStatuses` →
 * `auth`.
 */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: HttpRequestInit,
  label: string,
  options: RequestJsonOptions = {}
): Promise<Record<string, unknown>> {
  const authStatuses = options.authStatuses ?? [401, 403];
  let response: HttpResponseLike;
  try {
    response = await fetchImpl(url, { ...BASE_REQUEST_INIT, ...init });
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) {
      throw new CalendarProviderError('cancelled', 'The request was cancelled.', error);
    }
    throw new CalendarProviderError('unavailable', `Couldn't reach ${label}.`, error);
  }
  if (!response.ok) {
    throw new CalendarProviderError(
      authStatuses.includes(response.status) ? 'auth' : 'unavailable',
      `${label} responded with HTTP ${response.status}.`
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new CalendarProviderError('unavailable', `${label} sent an unreadable response.`, error);
  }
  if (!isRecord(body)) {
    throw new CalendarProviderError('unavailable', `${label} sent an unexpected response.`);
  }
  return body;
}

/* -------------------------------------------------------------------------- *
 * Access tokens
 * -------------------------------------------------------------------------- */

/** Seconds shaved off a token's lifetime so it is never used at the last moment. */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60;

/** Lifetime assumed when a provider omits `expires_in`. */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

export interface AccessTokenStore {
  set(token: string, expiresInSeconds?: number): void;
  /** The token, or null once it has expired or been cleared. */
  get(): string | null;
  clear(): void;
}

/**
 * Holds one OAuth access token in a closure variable: memory only. It is never
 * written to localStorage, sessionStorage, cookies or IndexedDB, so it is gone
 * after a reload, a logout (hard navigation) or its expiry.
 */
export function createAccessTokenStore(now: () => number = Date.now): AccessTokenStore {
  let token: string | null = null;
  let expiresAt = 0;
  return {
    set(value, expiresInSeconds) {
      const lifetime =
        typeof expiresInSeconds === 'number' &&
        Number.isFinite(expiresInSeconds) &&
        expiresInSeconds > 0
          ? expiresInSeconds
          : DEFAULT_TOKEN_LIFETIME_SECONDS;
      token = value;
      expiresAt =
        now() + Math.max(lifetime - TOKEN_EXPIRY_SKEW_SECONDS, lifetime / 2) * 1000;
    },
    get() {
      if (token !== null && now() >= expiresAt) {
        token = null;
      }
      return token;
    },
    clear() {
      token = null;
      expiresAt = 0;
    },
  };
}
