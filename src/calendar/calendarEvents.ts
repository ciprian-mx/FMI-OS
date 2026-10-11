/**
 * Calendar event model and week-view helpers for the Calendar App (Task 7.1,
 * Requirements 10.1 / 10.2).
 *
 * Every provider (Google Calendar, Outlook / Microsoft Graph) normalizes its
 * events into {@link CalendarEvent}; the widget then lays them out with
 * {@link groupEventsByDay}. Everything here is pure and works in the student's
 * local time zone: a week runs from Monday 00:00 to the next Monday 00:00 local
 * time, and all-day events are "floating" calendar dates ("2024-06-03"), which
 * is how both providers model them.
 */

/** One calendar event, normalized from any provider. */
export interface CalendarEvent {
  /** Provider event id (unique within one provider's results). */
  id: string;
  /** Event title; may be empty (the widget shows "Untitled event"). */
  title: string;
  /**
   * Timed events: an ISO 8601 instant ("2024-06-03T09:00:00.000Z").
   * All-day events: a local calendar date ("2024-06-03").
   */
  start: string;
  /** Exclusive end, in the same form as {@link CalendarEvent.start}. */
  end: string;
  /** True for all-day (date-only) events. */
  allDay: boolean;
  /** Free-text location, when the provider has one. */
  location?: string;
  /** `https:` link to the event in the provider's web UI. */
  webLink?: string;
}

/** A half-open interval [start, end) in epoch milliseconds. */
export interface DateRange {
  readonly start: number;
  readonly end: number;
}

export const DAYS_PER_WEEK = 7;

/** Longest stretch {@link groupEventsByDay} will lay out (guards a bad range). */
const MAX_LAYOUT_DAYS = 42;

/** Longest text kept from a provider field (titles, locations). */
export const MAX_EVENT_TEXT_LENGTH = 500;

/** Longest link accepted by {@link sanitizeWebLink}. */
const MAX_LINK_LENGTH = 2048;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local calendar date of `time` as "YYYY-MM-DD". */
export function toDateKey(time: number | Date): string {
  const date = new Date(typeof time === 'number' ? time : time.getTime());
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Local midnight (epoch ms) of a "YYYY-MM-DD" date, or `NaN` when the value is
 * not a real calendar date (e.g. "2024-02-30").
 */
export function parseDateKey(key: string): number {
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) {
    return Number.NaN;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return Number.NaN;
  }
  return date.getTime();
}

/** Local midnight `days` calendar days after `date` (DST-safe). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The calendar day after `key` ("2024-06-30" → "2024-07-01"); null if `key` is invalid. */
export function nextDateKey(key: string): string | null {
  const time = parseDateKey(key);
  return Number.isNaN(time) ? null : toDateKey(addDays(new Date(time), 1));
}

/** Local midnight on the Monday of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

/**
 * The week the widget shows: [Monday 00:00, next Monday 00:00) local time,
 * `weekOffset` weeks away from the week containing `reference`.
 */
export function weekRange(reference: Date, weekOffset = 0): DateRange {
  const monday = addDays(startOfWeek(reference), weekOffset * DAYS_PER_WEEK);
  return { start: monday.getTime(), end: addDays(monday, DAYS_PER_WEEK).getTime() };
}

/**
 * Epoch-millisecond bounds of an event, or null when its dates can't be read.
 * A missing or inverted end collapses to the start (timed events) or to a
 * single day (all-day events).
 */
export function eventBounds(event: CalendarEvent): DateRange | null {
  if (event.allDay) {
    const start = parseDateKey(event.start);
    if (Number.isNaN(start)) {
      return null;
    }
    const end = parseDateKey(event.end);
    return {
      start,
      end: Number.isNaN(end) || end <= start ? addDays(new Date(start), 1).getTime() : end,
    };
  }
  const start = Date.parse(event.start);
  if (Number.isNaN(start)) {
    return null;
  }
  const end = Date.parse(event.end);
  return { start, end: Number.isNaN(end) || end < start ? start : end };
}

/** One column of the week view. */
export interface CalendarDay {
  /** Local date, "YYYY-MM-DD". */
  key: string;
  /** Local midnight that starts the day (epoch ms). */
  start: number;
  /** Local midnight that ends the day (exclusive, epoch ms). */
  end: number;
  /** Events overlapping the day: all-day first, then by start, end and title. */
  events: CalendarEvent[];
}

interface MeasuredEvent {
  event: CalendarEvent;
  bounds: DateRange;
}

function overlapsDay(bounds: DateRange, dayStart: number, dayEnd: number): boolean {
  // A zero-length event belongs to the day it happens in.
  if (bounds.start === bounds.end) {
    return bounds.start >= dayStart && bounds.start < dayEnd;
  }
  return bounds.start < dayEnd && bounds.end > dayStart;
}

function compareMeasured(a: MeasuredEvent, b: MeasuredEvent): number {
  if (a.event.allDay !== b.event.allDay) {
    return a.event.allDay ? -1 : 1;
  }
  return (
    a.bounds.start - b.bounds.start ||
    a.bounds.end - b.bounds.end ||
    a.event.title.localeCompare(b.event.title) ||
    a.event.id.localeCompare(b.event.id)
  );
}

/**
 * Lays `events` out over the days of `range` (normally one {@link weekRange}).
 * Multi-day events appear on every day they overlap (ends are exclusive);
 * events outside the range, or whose dates can't be parsed, are left out, and
 * a duplicated id is shown once per day.
 */
export function groupEventsByDay(
  events: readonly CalendarEvent[],
  range: DateRange
): CalendarDay[] {
  const measured: MeasuredEvent[] = [];
  for (const event of events) {
    const bounds = eventBounds(event);
    if (bounds) {
      measured.push({ event, bounds });
    }
  }
  measured.sort(compareMeasured);

  const days: CalendarDay[] = [];
  for (
    let day = new Date(range.start);
    day.getTime() < range.end && days.length < MAX_LAYOUT_DAYS;
    day = addDays(day, 1)
  ) {
    const start = day.getTime();
    const end = addDays(day, 1).getTime();
    const seen = new Set<string>();
    const dayEvents: CalendarEvent[] = [];
    for (const { event, bounds } of measured) {
      if (!seen.has(event.id) && overlapsDay(bounds, start, end)) {
        seen.add(event.id);
        dayEvents.push(event);
      }
    }
    days.push({ key: toDateKey(start), start, end, events: dayEvents });
  }
  return days;
}

/** True for C0/C1 control characters (tab, newline, DEL…). */
function isControlCharacter(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Provider text (titles, locations) as plain display text: non-strings become
 * "", control characters become spaces, the result is trimmed and capped at
 * {@link MAX_EVENT_TEXT_LENGTH} characters. React escapes it on render.
 */
export function toEventText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  let text = '';
  for (let index = 0; index < raw.length && text.length < MAX_EVENT_TEXT_LENGTH; index += 1) {
    text += isControlCharacter(raw.charCodeAt(index)) ? ' ' : raw.charAt(index);
  }
  return text.trim();
}

/**
 * `raw` when it is an absolute `https:` URL, otherwise undefined, so provider
 * data can never put a `javascript:` / `data:` link into the widget.
 */
export function sanitizeWebLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_LENGTH) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
