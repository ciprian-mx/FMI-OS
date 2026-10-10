import {
  Examination,
  SESSION_PRIORITY_WINDOW_DAYS,
  URGENCY_WINDOW_DAYS,
  daysUntil,
  groupBySubject,
  isPast,
  isUpcomingWithin,
  isUrgent,
  parseExamDate,
  partitionByTime,
  sortByDate,
  toTimeline,
} from './examinations';

/**
 * Task 6.1 — Future Examinations data-layer helpers.
 *
 * Covers the pure transforms the Future Examinations App (task 6.2) and the
 * session generator (task 12.x) rely on: chronological ordering, days-until /
 * urgency computation, upcoming-vs-past partitioning, subject grouping, and the
 * decorated timeline view model. These are concrete example/edge-case unit
 * tests; the universal ordering (Property 12) and urgency (Property 13)
 * invariants are property-tested separately in tasks 6.3 / 6.4.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5
 */

const STUDENT = 'student-1';

function exam(
  id: string,
  date: string,
  subject = 'Algorithms',
  examName = `Exam ${id}`
): Examination {
  return { id, studentId: STUDENT, examName, subject, date, notes: null };
}

/** A fixed reference "now" so the time-relative helpers are deterministic. */
const NOW = new Date('2024-06-01T00:00:00Z');

describe('parseExamDate', () => {
  it('parses an ISO-8601 timestamp to epoch millis', () => {
    expect(parseExamDate('2024-06-01T00:00:00Z')).toBe(NOW.getTime());
  });

  it('returns NaN for an empty or unparseable value', () => {
    expect(Number.isNaN(parseExamDate(''))).toBe(true);
    expect(Number.isNaN(parseExamDate('not-a-date'))).toBe(true);
  });
});

describe('sortByDate', () => {
  it('orders exams strictly chronologically, earliest first', () => {
    const unsorted = [
      exam('c', '2024-07-01T00:00:00Z'),
      exam('a', '2024-06-10T00:00:00Z'),
      exam('b', '2024-06-20T00:00:00Z'),
    ];
    expect(sortByDate(unsorted).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties on equal dates by id for a stable total order', () => {
    const same = '2024-06-10T00:00:00Z';
    const result = sortByDate([exam('y', same), exam('x', same)]);
    expect(result.map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('sinks exams with unparseable dates to the end', () => {
    const result = sortByDate([
      exam('bad', 'nonsense'),
      exam('good', '2024-06-10T00:00:00Z'),
    ]);
    expect(result.map((e) => e.id)).toEqual(['good', 'bad']);
  });

  it('does not mutate the input array', () => {
    const input = [exam('b', '2024-07-01T00:00:00Z'), exam('a', '2024-06-01T00:00:00Z')];
    const snapshot = input.map((e) => e.id);
    sortByDate(input);
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });
});

describe('daysUntil', () => {
  it('returns 0 for an exam within the next 24 hours (today)', () => {
    expect(daysUntil('2024-06-01T12:00:00Z', NOW)).toBe(1); // ceil of 0.5 day
    expect(daysUntil('2024-06-01T00:00:00Z', NOW)).toBe(0);
  });

  it('rounds partial days up for future exams', () => {
    expect(daysUntil('2024-06-08T06:00:00Z', NOW)).toBe(8);
  });

  it('returns a negative count for past exams', () => {
    expect(daysUntil('2024-05-30T00:00:00Z', NOW)).toBe(-2);
  });

  it('returns NaN for an unparseable date', () => {
    expect(Number.isNaN(daysUntil('bad', NOW))).toBe(true);
  });
});

describe('isPast', () => {
  it('is true for a date strictly before now', () => {
    expect(isPast(exam('a', '2024-05-31T23:59:59Z'), NOW)).toBe(true);
  });

  it('is false for a future date', () => {
    expect(isPast(exam('a', '2024-06-02T00:00:00Z'), NOW)).toBe(false);
  });
});

describe('isUrgent', () => {
  it('flags an exam within the 7-day window', () => {
    expect(isUrgent(exam('a', '2024-06-07T00:00:00Z'), NOW)).toBe(true);
  });

  it('flags an exam exactly on the window boundary', () => {
    const boundary = new Date(NOW.getTime() + URGENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    expect(isUrgent(exam('a', boundary.toISOString()), NOW)).toBe(true);
  });

  it('does not flag an exam beyond the window', () => {
    expect(isUrgent(exam('a', '2024-06-20T00:00:00Z'), NOW)).toBe(false);
  });

  it('does not flag a past exam', () => {
    expect(isUrgent(exam('a', '2024-05-20T00:00:00Z'), NOW)).toBe(false);
  });
});

describe('isUpcomingWithin', () => {
  it('uses the 14-day session window by default', () => {
    const within = exam('a', '2024-06-14T00:00:00Z');
    const beyond = exam('b', '2024-06-20T00:00:00Z');
    expect(isUpcomingWithin(within, SESSION_PRIORITY_WINDOW_DAYS, NOW)).toBe(true);
    expect(isUpcomingWithin(beyond, SESSION_PRIORITY_WINDOW_DAYS, NOW)).toBe(false);
  });

  it('excludes past exams', () => {
    expect(isUpcomingWithin(exam('a', '2024-05-01T00:00:00Z'), SESSION_PRIORITY_WINDOW_DAYS, NOW)).toBe(
      false
    );
  });
});

describe('partitionByTime', () => {
  it('splits into chronological upcoming and most-recent-first past', () => {
    const exams = [
      exam('past-old', '2024-05-01T00:00:00Z'),
      exam('past-recent', '2024-05-28T00:00:00Z'),
      exam('future-near', '2024-06-05T00:00:00Z'),
      exam('future-far', '2024-07-01T00:00:00Z'),
    ];
    const { upcoming, past } = partitionByTime(exams, NOW);
    expect(upcoming.map((e) => e.id)).toEqual(['future-near', 'future-far']);
    expect(past.map((e) => e.id)).toEqual(['past-recent', 'past-old']);
  });

  it('drops exams with unparseable dates from both buckets', () => {
    const { upcoming, past } = partitionByTime([exam('bad', 'nonsense')], NOW);
    expect(upcoming).toEqual([]);
    expect(past).toEqual([]);
  });
});

describe('groupBySubject', () => {
  it('groups exams by subject with each group sorted chronologically', () => {
    const exams = [
      exam('a2', '2024-07-01T00:00:00Z', 'Algorithms'),
      exam('d1', '2024-06-10T00:00:00Z', 'Databases'),
      exam('a1', '2024-06-05T00:00:00Z', 'Algorithms'),
    ];
    const groups = groupBySubject(exams);
    expect([...groups.keys()]).toEqual(['Algorithms', 'Databases']);
    expect(groups.get('Algorithms')?.map((e) => e.id)).toEqual(['a1', 'a2']);
    expect(groups.get('Databases')?.map((e) => e.id)).toEqual(['d1']);
  });

  it('returns an empty map for no exams', () => {
    expect(groupBySubject([]).size).toBe(0);
  });
});

describe('toTimeline', () => {
  it('produces a chronological, urgency-decorated view model', () => {
    const exams = [
      exam('far', '2024-07-01T00:00:00Z'),
      exam('urgent', '2024-06-05T00:00:00Z'),
      exam('past', '2024-05-25T00:00:00Z'),
    ];
    const timeline = toTimeline(exams, NOW);

    expect(timeline.map((t) => t.examination.id)).toEqual(['past', 'urgent', 'far']);

    const past = timeline[0];
    expect(past.isPast).toBe(true);
    expect(past.isUrgent).toBe(false);
    expect(past.daysUntil).toBeLessThan(0);

    const urgent = timeline[1];
    expect(urgent.isUrgent).toBe(true);
    expect(urgent.isPast).toBe(false);
    expect(urgent.daysUntil).toBe(4);

    const far = timeline[2];
    expect(far.isUrgent).toBe(false);
    expect(far.daysUntil).toBe(30);
  });

  it('places unparseable-date exams last with NaN daysUntil', () => {
    const timeline = toTimeline([exam('bad', 'nonsense'), exam('ok', '2024-06-05T00:00:00Z')], NOW);
    expect(timeline[timeline.length - 1].examination.id).toBe('bad');
    expect(Number.isNaN(timeline[timeline.length - 1].daysUntil)).toBe(true);
  });
});
