/**
 * Iframe mode of the Calendar App (Task 7.1, Requirement 10.3: "WHERE an
 * external calendar API is unavailable, THE Calendar_App SHALL embed the
 * calendar webpage in an iframe within the Desktop_App window").
 *
 * The embed link is configuration (REACT_APP_CALENDAR_EMBED_URL or the
 * `externalCalendarUrl` prop), but it is still treated as untrusted input: only
 * `https:` URLs on a short allowlist of first-party calendar hosts are framed,
 * everything else is refused with {@link EMBED_URL_ERROR}. The frame itself is
 * sandboxed with {@link EMBED_SANDBOX} and rendered with
 * `referrerPolicy="no-referrer"`.
 */

/** Hosts whose calendar pages may be embedded (exact, lower-case host names). */
export const ALLOWED_EMBED_HOSTS = [
  'calendar.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
] as const;

export type AllowedEmbedHost = (typeof ALLOWED_EMBED_HOSTS)[number];

/**
 * Sandbox tokens for the embedded calendar. The allowlisted calendars are
 * script-driven pages that need their own origin (cookies) to render, and open
 * event details in a new tab. Both hosts are cross-origin to FMI OS, so
 * `allow-same-origin` gives the frame its own origin, never FMI OS's.
 * Deliberately absent: top-level navigation, forms, modals, downloads, pointer
 * lock and presentation.
 */
export const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/** Shown instead of the frame when the configured link is refused. */
export const EMBED_URL_ERROR =
  "This calendar link can't be embedded. Use an https:// link from Google Calendar " +
  '(calendar.google.com) or Outlook (outlook.live.com, outlook.office.com or outlook.office365.com).';

const MAX_EMBED_URL_LENGTH = 2048;

export type EmbedUrlValidation =
  | {
      ok: true;
      /** The normalized URL to put in `src`. */
      url: string;
      host: AllowedEmbedHost;
      /** "Google Calendar" or "Outlook Calendar", for titles and messages. */
      providerLabel: string;
    }
  | { ok: false; error: string };

function isAllowedHost(host: string): host is AllowedEmbedHost {
  return (ALLOWED_EMBED_HOSTS as readonly string[]).includes(host);
}

/** True when `value` contains whitespace or a control character. */
function hasWhitespaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/.test(value.charAt(index))) {
      return true;
    }
  }
  return false;
}

/**
 * Accepts `raw` only when it is an absolute `https:` URL on one of
 * {@link ALLOWED_EMBED_HOSTS}, on the default port and without credentials.
 * Embedded whitespace / control characters are refused outright rather than
 * left to the URL parser, which silently strips some of them.
 */
export function validateCalendarEmbedUrl(raw: unknown): EmbedUrlValidation {
  const refused = { ok: false as const, error: EMBED_URL_ERROR };
  if (typeof raw !== 'string') {
    return refused;
  }
  const candidate = raw.trim();
  if (
    candidate.length === 0 ||
    candidate.length > MAX_EMBED_URL_LENGTH ||
    hasWhitespaceOrControl(candidate)
  ) {
    return refused;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refused;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !isAllowedHost(host)
  ) {
    return refused;
  }
  return {
    ok: true,
    url: url.href,
    host,
    providerLabel: host === 'calendar.google.com' ? 'Google Calendar' : 'Outlook Calendar',
  };
}
