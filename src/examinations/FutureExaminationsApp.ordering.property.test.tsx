import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import FutureExaminationsApp from './FutureExaminationsApp';
import type { Examination } from './examinations';

/**
 * Feature: fmi-os, Property 12: Exam Timeline Chronological Ordering
 * **Validates: Requirements 9.1**
 *
 * Property 12 (design.md): *For any* set of examination deadlines E stored for
 * a student, the Future Examinations App timeline view SHALL display E in
 * strictly chronological order by date — no exam with an earlier date SHALL
 * appear after an exam with a later date.
 *
 * How the property is exercised
 * -----------------------------
 * Each run generates a student's set E and a reference `now`, renders the real
 * FutureExaminationsApp, and reads the timeline back from the DOM: the
 * `data-exam-id` of each entry in the timeline `<ol>`, top to bottom.
 *
 * The oracle is independent of the code under test: it never calls
 * sortByDate, toTimeline or parseExamDate. Each exam's timestamp is
 * `Date.parse` of the exact `date` string the app receives, and it must equal
 * the instant the generator wrote that string from (keeping the generator
 * honest).
 *
 * The generated sets cover:
 *   - the empty set, single exams, and up to 24 exams in arbitrary order;
 *   - a wide date range: `now` anywhere in 2000-2100, exams up to 50 years
 *     either side of it, mostly within weeks, so past and upcoming exams mix;
 *   - equal dates: exams share instants, sometimes as duplicate entries (same
 *     name, subject and date under another id);
 *   - the ISO 8601 shapes stored `AWSDateTime` values take: minute, second or
 *     millisecond precision, with "Z" or a ±hh:mm offset. One instant is often
 *     written two ways ("…T09:00Z" and "…T11:00+02:00"), and string order often
 *     contradicts time order, so sorting the date strings as text fails.
 * After its runs, each test asserts that the situations it relies on occurred.
 *
 * Equal dates
 * -----------
 * "Strictly chronological" cannot mean strictly increasing once two exams share
 * a date; the property's own clause defines it: no earlier exam after a later
 * one. So the first test requires non-decreasing dates in display order and
 * lets equal-date exams appear in either order. The second test requires that
 * order to be deterministic: the same set handed over in reverse displays the
 * identical timeline, so equal-date exams never swap places just because the
 * data arrived in another order. Which tie-break the app uses (examinations.ts
 * breaks ties by id) is deliberately not asserted.
 *
 * Scope and limits: every generated exam has a parseable date, as the schema's
 * `date: AWSDateTime!` guarantees for stored exams; where malformed dates go is
 * pinned by the example tests in examinations.test.ts. jsdom has no layout and
 * CSS is stubbed, so display order here is DOM order: the order assistive tech
 * reads the `<ol>` in, and the order it paints in unless CSS reorders entries.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

/** The reference "now" falls anywhere in 2000-2100. */
const NOW_MIN_MS = Date.UTC(2000, 0, 1);
const NOW_MAX_MS = Date.UTC(2100, 0, 1);

/** Largest generated set: several semesters' worth of exams. */
const MAX_EXAMS = 24;

const STUDENT_ID = 'student-1';

const SUBJECTS = [
  'Algorithms',
  'Databases',
  'Operating Systems',
  'Computer Networks',
  'Probability',
  'Formal Languages',
];

const EXAM_KINDS = ['Midterm', 'Final', 'Quiz', 'Lab test', 'Colloquium', 'Resit'];

/**
 * UTC offsets (minutes east) exam times are written with: Romania's +02:00 and
 * +03:00, other whole-hour zones, and half- and quarter-hour ones.
 */
const ZONE_OFFSETS_MINUTES = [0, 60, 120, 180, 330, 345, 570, 765, 840, -60, -180, -210, -300, -570, -720];

type Precision = 'minute' | 'second' | 'millisecond';

/** How an instant is written as an ISO 8601 date-time. */
interface DateFormat {
  precision: Precision;
  /** Minutes east of UTC, or null for the "Z" designator. */
  offsetMinutes: number | null;
}

/** Each precision's unit, and the length of its "YYYY-MM-DDTHH:mm[:ss[.sss]]" part. */
const PRECISIONS: Record<Precision, { unitMs: number; length: number }> = {
  minute: { unitMs: MINUTE_MS, length: 16 },
  second: { unitMs: 1000, length: 19 },
  millisecond: { unitMs: 1, length: 23 },
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

function zoneDesignator(offsetMinutes: number | null): string {
  if (offsetMinutes === null) {
    return 'Z';
  }
  const sign = offsetMinutes < 0 ? '-' : '+';
  const minutes = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/**
 * Writes `instant`, cut to the format's precision, as an ISO 8601 date-time in
 * the format's zone (e.g. "2024-06-01T11:00+02:00"). Returns the string and the
 * instant it denotes.
 */
function writeDate(
  instant: number,
  { precision, offsetMinutes }: DateFormat
): { date: string; instant: number } {
  const { unitMs, length } = PRECISIONS[precision];
  const exact = Math.floor(instant / unitMs) * unitMs;
  // The zone's wall-clock time, read off the UTC rendering of the shifted instant.
  const wallClock = new Date(exact + (offsetMinutes ?? 0) * MINUTE_MS).toISOString();
  return { date: wallClock.slice(0, length) + zoneDesignator(offsetMinutes), instant: exact };
}

/** One generated exam: what the app receives, and the instant its date denotes. */
interface GeneratedExam {
  exam: Examination;
  instant: number;
}

interface Scenario {
  now: Date;
  /** The stored set E, in the arbitrary order it reaches the app. */
  exams: GeneratedExam[];
}

/** The recipe for one exam. Exams sit on a few shared anchor instants, so ties are common. */
interface ExamSpec {
  id: string;
  examName: string;
  subject: string;
  /** Which of the run's anchor instants the exam sits on (modulo the anchor count). */
  anchor: number;
  /** Offset from that anchor; often 0, so exams share an instant. */
  jitterMs: number;
  format: DateFormat;
  /** Copy an earlier exam's name, subject and date (index modulo this one's): a duplicate entry. */
  copyOf: number | null;
}

/** Where an anchor sits relative to `now`: mostly within weeks of it, sometimes years or decades away. */
const anchorOffsetArb: fc.Arbitrary<number> = fc.oneof(
  // `now` itself, 1 ms either side, and a day, 7 and 14 days away.
  { weight: 2, arbitrary: fc.constantFrom(0, -1, 1, -DAY_MS, DAY_MS, 7 * DAY_MS, 14 * DAY_MS) },
  { weight: 4, arbitrary: fc.integer({ min: -30 * DAY_MS, max: 30 * DAY_MS }) },
  { weight: 2, arbitrary: fc.integer({ min: -2 * YEAR_MS, max: 2 * YEAR_MS }) },
  { weight: 1, arbitrary: fc.integer({ min: -50 * YEAR_MS, max: 50 * YEAR_MS }) }
);

/** How far an exam sits from its anchor: usually not at all (a tie), otherwise 1 ms to a day. */
const jitterArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 5, arbitrary: fc.constant(0) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(-1, 1, -1000, 1000, -MINUTE_MS, MINUTE_MS, -HOUR_MS, HOUR_MS),
  },
  { weight: 2, arbitrary: fc.integer({ min: -DAY_MS, max: DAY_MS }) }
);

const dateFormatArb: fc.Arbitrary<DateFormat> = fc.record({
  precision: fc.constantFrom<Precision>('minute', 'second', 'millisecond'),
  offsetMinutes: fc.oneof(
    { weight: 2, arbitrary: fc.constant(null) },
    { weight: 3, arbitrary: fc.constantFrom(...ZONE_OFFSETS_MINUTES) }
  ),
});

const examSpecArb: fc.Arbitrary<ExamSpec> = fc.record({
  id: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 1,
    maxLength: 6,
  }),
  examName: fc.constantFrom(...EXAM_KINDS),
  subject: fc.constantFrom(...SUBJECTS),
  anchor: fc.nat(),
  jitterMs: jitterArb,
  format: dateFormatArb,
  copyOf: fc.oneof({ weight: 6, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.nat() }),
});

/** Exam recipes with distinct ids (the table's key). */
const examSpecsArb = (minLength: number, maxLength: number): fc.Arbitrary<ExamSpec[]> =>
  fc.uniqueArray(examSpecArb, { minLength, maxLength, selector: (spec) => spec.id });

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    nowMs: fc.integer({ min: NOW_MIN_MS, max: NOW_MAX_MS }),
    anchorOffsets: fc.array(anchorOffsetArb, { minLength: 1, maxLength: 6 }),
    // The empty set and single exams get weight of their own.
    specs: fc.oneof(
      { weight: 1, arbitrary: examSpecsArb(0, 0) },
      { weight: 2, arbitrary: examSpecsArb(1, 1) },
      { weight: 7, arbitrary: examSpecsArb(2, MAX_EXAMS) }
    ),
  })
  .map(({ nowMs, anchorOffsets, specs }): Scenario => {
    const exams: GeneratedExam[] = [];
    specs.forEach((spec, index) => {
      const original =
        spec.copyOf === null || index === 0 ? undefined : exams[spec.copyOf % index];
      if (original) {
        exams.push({ exam: { ...original.exam, id: spec.id }, instant: original.instant });
        return;
      }
      const anchor = nowMs + anchorOffsets[spec.anchor % anchorOffsets.length];
      const { date, instant } = writeDate(anchor + spec.jitterMs, spec.format);
      exams.push({
        exam: {
          id: spec.id,
          studentId: STUDENT_ID,
          examName: spec.examName,
          subject: spec.subject,
          date,
          notes: null,
        },
        instant,
      });
    });
    return { now: new Date(nowMs), exams };
  });

/** Situations the generator must produce; checked after the runs. */
const TRAITS = [
  'empty set',
  'single exam',
  'past and upcoming exams',
  'equal dates',
  'equal dates written differently',
  'duplicate entries',
  'string order contradicting time order',
] as const;
type Trait = (typeof TRAITS)[number];

/** The situations a scenario contains, read off the generated data. */
function traitsOf({ now, exams }: Scenario): Trait[] {
  const traits = new Set<Trait>();
  if (exams.length === 0) traits.add('empty set');
  if (exams.length === 1) traits.add('single exam');
  if (
    exams.some(({ instant }) => instant < now.getTime()) &&
    exams.some(({ instant }) => instant >= now.getTime())
  ) {
    traits.add('past and upcoming exams');
  }
  exams.forEach((a, index) => {
    exams.slice(index + 1).forEach((b) => {
      if (a.instant !== b.instant) {
        if ((a.instant < b.instant) !== (a.exam.date < b.exam.date)) {
          traits.add('string order contradicting time order');
        }
        return;
      }
      traits.add('equal dates');
      if (a.exam.date !== b.exam.date) {
        traits.add('equal dates written differently');
      } else if (a.exam.examName === b.exam.examName && a.exam.subject === b.exam.subject) {
        traits.add('duplicate entries');
      }
    });
  });
  return Array.from(traits);
}

/** Traits from `required` that no run produced. */
function missingTraits(seen: ReadonlySet<Trait>, required: readonly Trait[] = TRAITS): Trait[] {
  return required.filter((trait) => !seen.has(trait));
}

interface OracleEntry {
  date: string;
  timestamp: number;
}

/**
 * The oracle: each exam's timestamp, parsed straight from the `date` string the
 * app receives. It must be the instant the generator wrote.
 */
function oracleOf(exams: readonly GeneratedExam[]): Map<string, OracleEntry> {
  const oracle = new Map<string, OracleEntry>();
  for (const { exam, instant } of exams) {
    const timestamp = Date.parse(exam.date);
    expect({ date: exam.date, timestamp }).toEqual({ date: exam.date, timestamp: instant });
    oracle.set(exam.id, { date: exam.date, timestamp });
  }
  return oracle;
}

/**
 * Renders the app for `examinations` and returns the ids its timeline lists,
 * top to bottom: the `data-exam-id` of each entry in the timeline `<ol>`. The
 * empty state renders no list, so it lists nothing.
 */
function renderTimeline(examinations: readonly Examination[], now: Date): string[] {
  const { container } = render(<FutureExaminationsApp examinations={examinations} now={now} />);
  try {
    const timeline = container.querySelector('[data-testid="future-exams-timeline"]');
    if (timeline === null) {
      return [];
    }
    expect(timeline.tagName).toBe('OL');
    return Array.from(
      timeline.children,
      (entry) => entry.getAttribute('data-exam-id') ?? '(entry without data-exam-id)'
    );
  } finally {
    cleanup();
  }
}

/**
 * Adjacent entries out of order: an exam listed right before one with an
 * earlier date. None means no earlier exam follows a later one anywhere in the
 * list, since <= is transitive.
 */
function chronologyViolations(
  listed: readonly string[],
  oracle: ReadonlyMap<string, OracleEntry>
): string[] {
  const label = (position: number): string => {
    const id = listed[position];
    const entry = oracle.get(id);
    return entry
      ? `#${position} "${id}" ${entry.date} (${new Date(entry.timestamp).toISOString()})`
      : `#${position} "${id}"`;
  };
  const violations: string[] = [];
  for (let position = 1; position < listed.length; position += 1) {
    const before = oracle.get(listed[position - 1])?.timestamp ?? NaN;
    const after = oracle.get(listed[position])?.timestamp ?? NaN;
    if (!(before <= after)) {
      violations.push(`${label(position - 1)} is listed before the earlier ${label(position)}`);
    }
  }
  return violations;
}

const examsOf = (scenario: Scenario): Examination[] => scenario.exams.map(({ exam }) => exam);

describe('Feature: fmi-os, Property 12: Exam Timeline Chronological Ordering (Validates: Requirements 9.1)', () => {
  afterEach(() => {
    cleanup();
  });

  it('lists every stored exam exactly once, never an earlier-dated exam after a later-dated one', () => {
    const seen = new Set<Trait>();

    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        traitsOf(scenario).forEach((trait) => seen.add(trait));
        const oracle = oracleOf(scenario.exams);

        const listed = renderTimeline(examsOf(scenario), scenario.now);

        // The timeline displays E: each stored exam once (ids are unique), nothing else...
        expect([...listed].sort()).toEqual([...oracle.keys()].sort());
        // ...and no exam with an earlier date appears after one with a later date.
        expect(chronologyViolations(listed, oracle)).toEqual([]);
      }),
      { numRuns: 200 }
    );

    expect(missingTraits(seen)).toEqual([]);
  }, 120_000);

  it('lists equal-date exams in the same order whatever order the set arrives in', () => {
    const seen = new Set<Trait>();

    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        traitsOf(scenario).forEach((trait) => seen.add(trait));
        const examinations = examsOf(scenario);

        const listed = renderTimeline(examinations, scenario.now);
        // Reversing flips the arrival order of every pair of exams, so any
        // tie order that follows arrival order shows up as a difference. Both
        // lists are chronological (first test), so they can only differ within
        // a group of equal dates.
        const listedFromReversed = renderTimeline([...examinations].reverse(), scenario.now);

        expect(listedFromReversed).toEqual(listed);
      }),
      { numRuns: 200 }
    );

    expect(
      missingTraits(seen, ['equal dates', 'equal dates written differently', 'duplicate entries'])
    ).toEqual([]);
  }, 120_000);
});
