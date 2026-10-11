/**
 * Deployment configuration of the Calendar App (Task 7.1).
 *
 * Everything comes from build-time environment variables (Create React App
 * inlines `REACT_APP_*` values into the bundle, so none of them may be secret —
 * and none are: OAuth client IDs of public browser clients are public):
 *
 *   REACT_APP_GOOGLE_CLIENT_ID       Google OAuth client ID ("Web application")
 *   REACT_APP_MS_CLIENT_ID           Entra ID application (client) ID ("SPA")
 *   REACT_APP_MS_TENANT_ID           optional, default "common"
 *   REACT_APP_CALENDAR_EMBED_URL     optional iframe-mode link
 *   REACT_APP_CALENDAR_REDIRECT_URI  optional; default
 *                                    `${origin}${PUBLIC_URL}/calendar-oauth-callback.html`
 *
 * A provider is offered only when its client ID is configured, so with no
 * client IDs the Calendar App has no API mode and falls back to iframe mode
 * (Requirement 10.3).
 */
import type { CalendarProvider } from './calendarProvider';
import { createGoogleCalendarProvider } from './googleCalendarProvider';
import {
  createOutlookCalendarProvider,
  OutlookCalendarProviderDeps,
} from './outlookCalendarProvider';

/** The environment variables the Calendar App reads. */
export interface CalendarEnv {
  readonly REACT_APP_GOOGLE_CLIENT_ID?: string;
  readonly REACT_APP_MS_CLIENT_ID?: string;
  readonly REACT_APP_MS_TENANT_ID?: string;
  readonly REACT_APP_CALENDAR_EMBED_URL?: string;
  readonly REACT_APP_CALENDAR_REDIRECT_URI?: string;
  readonly PUBLIC_URL?: string;
}

/** Reads the variables, each referenced literally so the CRA build inlines it. */
export function readCalendarEnv(): CalendarEnv {
  return {
    REACT_APP_GOOGLE_CLIENT_ID: process.env.REACT_APP_GOOGLE_CLIENT_ID,
    REACT_APP_MS_CLIENT_ID: process.env.REACT_APP_MS_CLIENT_ID,
    REACT_APP_MS_TENANT_ID: process.env.REACT_APP_MS_TENANT_ID,
    REACT_APP_CALENDAR_EMBED_URL: process.env.REACT_APP_CALENDAR_EMBED_URL,
    REACT_APP_CALENDAR_REDIRECT_URI: process.env.REACT_APP_CALENDAR_REDIRECT_URI,
    PUBLIC_URL: process.env.PUBLIC_URL,
  };
}

/** The static relay page in `public/` that OAuth providers redirect to. */
export const OAUTH_CALLBACK_FILE = 'calendar-oauth-callback.html';

/** Multi-tenant authority: work/school and personal Microsoft accounts. */
export const DEFAULT_MICROSOFT_TENANT = 'common';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/;
// GUIDs, verified domains, "common" / "organizations" / "consumers".
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;

export interface CalendarConfig {
  googleClientId: string | null;
  microsoftClientId: string | null;
  microsoftTenant: string;
  /** Where providers return the student after sign-in; null outside a browser. */
  redirectUri: string | null;
  /** Raw iframe-mode link; validated by the app (`validateCalendarEmbedUrl`) before use. */
  embedUrl: string | null;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/** `value` resolved against `origin`, or null unless it stays on that origin. */
function sameOriginUrl(value: string, origin: string): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The OAuth redirect URI. It must be on FMI OS's own origin: the callback page
 * hands the response back over same-origin channels only, so a cross-origin
 * override is ignored (it could never work, and would send tokens elsewhere).
 */
export function resolveRedirectUri(env: CalendarEnv, origin: string): string | null {
  const override = sameOriginUrl(clean(env.REACT_APP_CALENDAR_REDIRECT_URI), origin);
  if (override) {
    return override;
  }
  const publicPath = clean(env.PUBLIC_URL).replace(/\/+$/, '');
  return (
    sameOriginUrl(`${publicPath}/${OAUTH_CALLBACK_FILE}`, origin) ??
    sameOriginUrl(`/${OAUTH_CALLBACK_FILE}`, origin)
  );
}

/** Validates and normalizes the raw variables. `origin` is the app's origin. */
export function resolveCalendarConfig(env: CalendarEnv, origin: string | null): CalendarConfig {
  const googleClientId = clean(env.REACT_APP_GOOGLE_CLIENT_ID);
  const microsoftClientId = clean(env.REACT_APP_MS_CLIENT_ID);
  const tenant = clean(env.REACT_APP_MS_TENANT_ID);
  const embedUrl = clean(env.REACT_APP_CALENDAR_EMBED_URL);
  return {
    googleClientId: CLIENT_ID_PATTERN.test(googleClientId) ? googleClientId : null,
    microsoftClientId: CLIENT_ID_PATTERN.test(microsoftClientId) ? microsoftClientId : null,
    microsoftTenant: TENANT_PATTERN.test(tenant) ? tenant : DEFAULT_MICROSOFT_TENANT,
    redirectUri: origin === null ? null : resolveRedirectUri(env, origin),
    embedUrl: embedUrl === '' ? null : embedUrl,
  };
}

/** One provider per configured client ID (Google first). */
export function createCalendarProviders(
  config: CalendarConfig,
  deps: OutlookCalendarProviderDeps = {}
): CalendarProvider[] {
  const { redirectUri } = config;
  if (!redirectUri) {
    return [];
  }
  const providers: CalendarProvider[] = [];
  if (config.googleClientId) {
    providers.push(
      createGoogleCalendarProvider({ clientId: config.googleClientId, redirectUri }, deps)
    );
  }
  if (config.microsoftClientId) {
    providers.push(
      createOutlookCalendarProvider(
        { clientId: config.microsoftClientId, tenant: config.microsoftTenant, redirectUri },
        deps
      )
    );
  }
  return providers;
}

function browserOrigin(): string | null {
  return typeof window !== 'undefined' && window.location ? window.location.origin : null;
}

let defaultConfig: CalendarConfig | null = null;
let defaultProviders: readonly CalendarProvider[] | null = null;

/** This deployment's configuration, read once. */
export function getDefaultCalendarConfig(): CalendarConfig {
  if (defaultConfig === null) {
    defaultConfig = resolveCalendarConfig(readCalendarEnv(), browserOrigin());
  }
  return defaultConfig;
}

/**
 * This deployment's providers, created once per page so a connection survives
 * closing and reopening the Calendar window. Tokens still live in memory only.
 */
export function getDefaultCalendarProviders(): readonly CalendarProvider[] {
  if (defaultProviders === null) {
    defaultProviders = Object.freeze(createCalendarProviders(getDefaultCalendarConfig()));
  }
  return defaultProviders;
}
