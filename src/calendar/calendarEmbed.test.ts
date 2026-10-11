import { EMBED_URL_ERROR, validateCalendarEmbedUrl } from './calendarEmbed';

/**
 * Task 7.1 — iframe mode only embeds `https:` pages on the calendar-host
 * allowlist; everything else is refused with a clear message.
 *
 * Validates: Requirement 10.3
 */

const REFUSED = { ok: false, error: EMBED_URL_ERROR };

describe('validateCalendarEmbedUrl', () => {
  it.each([
    [
      'https://calendar.google.com/calendar/embed?src=student%40s.unibuc.ro&ctz=Europe%2FBucharest',
      'calendar.google.com',
      'Google Calendar',
    ],
    [
      'https://outlook.office365.com/owa/calendar/abc@s.unibuc.ro/def/calendar.html',
      'outlook.office365.com',
      'Outlook Calendar',
    ],
    [
      'https://outlook.office.com/owa/calendar/abc/def/calendar.html',
      'outlook.office.com',
      'Outlook Calendar',
    ],
    [
      'https://outlook.live.com/owa/calendar/abc/def/calendar.html',
      'outlook.live.com',
      'Outlook Calendar',
    ],
  ])('accepts %s', (url, host, providerLabel) => {
    expect(validateCalendarEmbedUrl(url)).toEqual({ ok: true, url, host, providerLabel });
  });

  it('normalizes host case and surrounding whitespace', () => {
    expect(
      validateCalendarEmbedUrl('  https://CALENDAR.GOOGLE.COM/calendar/embed?src=x  ')
    ).toMatchObject({ ok: true, url: 'https://calendar.google.com/calendar/embed?src=x' });
  });

  it.each([
    'http://calendar.google.com/calendar/embed?src=x',
    'https://calendar.google.com.evil.example/calendar/embed',
    'https://evilcalendar.google.com/calendar/embed',
    'https://calendar.google.com./calendar/embed',
    'https://calendar.google.com:8443/calendar/embed',
    'https://user:pass@calendar.google.com/calendar/embed',
    'https://www.google.com/calendar/embed?src=x',
    'https://сalendar.google.com/calendar/embed',
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    '//calendar.google.com/calendar/embed',
    'calendar.google.com/calendar/embed',
    'https://calendar.google.com/calendar/embed\n?src=x',
    '',
  ])('refuses %j', (url) => {
    expect(validateCalendarEmbedUrl(url)).toEqual(REFUSED);
  });

  it('refuses non-string values', () => {
    expect(validateCalendarEmbedUrl(undefined)).toEqual(REFUSED);
    expect(validateCalendarEmbedUrl({ href: 'https://calendar.google.com' })).toEqual(REFUSED);
  });
});
