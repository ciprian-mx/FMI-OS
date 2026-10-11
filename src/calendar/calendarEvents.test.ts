import {
  CalendarEvent,
  groupEventsByDay,
  nextDateKey,
  parseDateKey,
  sanitizeWebLink,
  startOfWeek,
  toDateKey,
  toEventText,
  weekRange,
} from './calendarEvents';

/**
 * Task 7.1 — week-view helpers behind the Calendar App. Dates are built from
 * local components, so the assertions hold in any time zone.
 *
 * Validates: Requirements 10.1, 10.2
 */

const at = (day: number, hour: number, minute = 0) =>
  new Date(2024, 5, day, hour, minute).toISOString();

describe('weekRange', () => {
  it('runs from Monday 00:00 to the next Monday 00:00 local time', () => {
    expect(weekRange(new Date(2024, 5, 5, 15, 30))).toEqual({
      start: new Date(2024, 5, 3).getTime(),
      end: new Date(2024, 5, 10).getTime(),
    });
  });

  it('treats Sunday as the last day of the week and applies week offsets', () => {
    expect(toDateKey(startOfWeek(new Date(2024, 5, 9, 23, 59)))).toBe('2024-06-03');
    expect(weekRange(new Date(2024, 5, 5), -1).start).toBe(new Date(2024, 4, 27).getTime());
    expect(weekRange(new Date(2024, 5, 5), 4).start).toBe(new Date(2024, 6, 1).getTime());
  });
});

describe('groupEventsByDay', () => {
  it('places events on every day they overlap, all-day first, then by start time', () => {
    const events: CalendarEvent[] = [
      { id: 'late', title: 'Study group', start: at(5, 18), end: at(5, 19), allDay: false },
      { id: 'early', title: 'Lecture', start: at(5, 8), end: at(5, 10), allDay: false },
      { id: 'fest', title: 'Hackathon', start: '2024-06-05', end: '2024-06-07', allDay: true },
      { id: 'night', title: 'Deploy', start: at(6, 23), end: at(7, 1), allDay: false },
      { id: 'outside', title: 'Next week', start: at(10, 9), end: at(10, 10), allDay: false },
      { id: 'broken', title: 'Broken', start: 'not a date', end: 'nope', allDay: false },
    ];

    const days = groupEventsByDay(events, weekRange(new Date(2024, 5, 5)));
    const ids = (key: string) =>
      days.find((day) => day.key === key)?.events.map((event) => event.id);

    expect(days.map((day) => day.key)).toEqual([
      '2024-06-03',
      '2024-06-04',
      '2024-06-05',
      '2024-06-06',
      '2024-06-07',
      '2024-06-08',
      '2024-06-09',
    ]);
    expect(ids('2024-06-05')).toEqual(['fest', 'early', 'late']);
    expect(ids('2024-06-06')).toEqual(['fest', 'night']);
    // All-day ends are exclusive; the overnight event spills into Friday.
    expect(ids('2024-06-07')).toEqual(['night']);
    const shown = days.flatMap((day) => day.events.map((event) => event.id));
    expect(shown).not.toContain('outside');
    expect(shown).not.toContain('broken');
  });
});

describe('date keys', () => {
  it('parses real calendar dates only and steps across month ends', () => {
    expect(parseDateKey('2024-06-03')).toBe(new Date(2024, 5, 3).getTime());
    expect(parseDateKey('2024-02-30')).toBeNaN();
    expect(parseDateKey('03/06/2024')).toBeNaN();
    expect(nextDateKey('2024-06-30')).toBe('2024-07-01');
    expect(nextDateKey('2024-12-31')).toBe('2025-01-01');
  });
});

describe('provider data sanitizing', () => {
  it('keeps only absolute https links', () => {
    const link = 'https://www.google.com/calendar/event?eid=abc';
    expect(sanitizeWebLink(link)).toBe(link);
    for (const unsafe of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'http://example.com/event',
      '/relative/event',
      'https://user:pw@example.com/event',
      42,
    ]) {
      expect(sanitizeWebLink(unsafe)).toBeUndefined();
    }
  });

  it('turns provider text into trimmed single-line plain text', () => {
    expect(toEventText('  Exam\nreview\t ')).toBe('Exam review');
    expect(toEventText(undefined)).toBe('');
  });
});
