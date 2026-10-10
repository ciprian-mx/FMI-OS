import { cleanup, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import FutureExaminationsApp from './FutureExaminationsApp';
import { Examination } from './examinations';

/**
 * Feature: fmi-os, Property 13: Exam Urgency Highlighting
 * **Validates: Requirements 9.5**
 *
 * *For any* examination E with deadline date D, if (D - today) ≤ 7 days, then
 * E SHALL display a visual urgency indicator (color or icon) in the Future
 * Examinations App.
 *
 * Oracle
 * ------
 * The expected flag is computed from the generated date and `now` alone, never
 * through `isUrgent` / `daysUntil`:
 *
 *     urgent(E)  ⟺  0 ≤ D − now ≤ 7 × 24 h
 *
 *   - "today" is the app's reference instant `now`, and the window is seven
 *     24-hour days of elapsed time ("exams ≤ 7 days away" in the design).
 *   - Past exams are never urgent. Requirement 9 is about *upcoming* deadlines
 *     (user story, 9.1, glossary), and 9.5 marks exams "within 7 days" to
 *     highlight urgency: a deadline that has passed has no urgency left,
 *     whether it ended 12 days or 1 ms ago. Read as a bare inequality,
 *     "(D − today) ≤ 7 days" would flag every past exam and defeat the
 *     highlight. An exam at exactly `now` is not past, so it is urgent.
 *   - A highlight is only meaningful if it is absent elsewhere, so the test
 *     checks both directions: on every urgent exam, and on no other.
 *
 * "Displays the indicator" is checked through all three signals of each
 * entry, which must agree with the oracle: `data-urgent`, the visible "Urgent"
 * badge `exam-urgency-{id}` inside the entry, and an accessible label ending
 * in ", urgent". The page must also hold exactly one badge per urgent exam.
 *
 * Generated dates concentrate on the boundaries: ended under 24 h ago (a
 * window that rounding partial days up mistakes for "today"), exactly now,
 * under 24 h away, exactly 7 days, just over 7 days, plus far past and far
 * future, all relative to an arbitrary millisecond `now`.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;
/** Requirement 9.5's "within 7 days", restated from the spec rather than imported. */
const URGENCY_WINDOW_MS = 7 * DAY_MS;

/** The oracle: the exam is no earlier than `now` and at most 7 days after it. */
function shouldBeUrgent(msFromNow: number): boolean {
  return msFromNow >= 0 && msFromNow <= URGENCY_WINDOW_MS;
}

/** Any millisecond from 2020 to 2035, so boundaries rarely land on round times. */
const nowMsArb = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2036, 0, 1) });

/** Offsets from `now` where the rule, or whole-day rounding, turns over. */
const PIVOTS_MS = [-DAY_MS, 0, DAY_MS, URGENCY_WINDOW_MS];

/** A boundary offset moved by at most `maxDistanceMs` either way. */
const nearPivot = (maxDistanceMs: number): fc.Arbitrary<number> =>
  fc
    .tuple(
      fc.constantFrom(...PIVOTS_MS),
      fc.integer({ min: -maxDistanceMs, max: maxDistanceMs })
    )
    .map(([pivot, distance]) => pivot + distance);

/** D − now for one exam, in ms. */
const msFromNowArb: fc.Arbitrary<number> = fc.oneof(
  // On a boundary, or a few ms either side of it.
  { weight: 4, arbitrary: nearPivot(2) },
  // Within an hour of a boundary.
  { weight: 2, arbitrary: nearPivot(HOUR_MS) },
  // Just past: ended under 24 h ago.
  { weight: 3, arbitrary: fc.integer({ min: -DAY_MS + 1, max: -1 }) },
  // Under 24 h away.
  { weight: 2, arbitrary: fc.integer({ min: 1, max: DAY_MS - 1 }) },
  // Anywhere from now to exactly 7 days.
  { weight: 2, arbitrary: fc.integer({ min: 0, max: URGENCY_WINDOW_MS }) },
  // Just over 7 days, by up to a day.
  {
    weight: 3,
    arbitrary: fc.integer({ min: URGENCY_WINDOW_MS + 1, max: URGENCY_WINDOW_MS + DAY_MS }),
  },
  // Far past and far future.
  { weight: 1, arbitrary: fc.integer({ min: -2 * YEAR_MS, max: -DAY_MS }) },
  { weight: 1, arbitrary: fc.integer({ min: URGENCY_WINDOW_MS + DAY_MS, max: 2 * YEAR_MS }) }
);

const scenarioArb = fc.record({
  nowMs: nowMsArb,
  msFromNow: fc.array(msFromNowArb, { minLength: 1, maxLength: 12 }),
});

interface UrgencyCase {
  /** D − now, in ms. */
  msFromNow: number;
  /** Whether the entry must carry the urgency indicator. */
  urgent: boolean;
}

/** The urgency signals of one timeline entry, as rendered. */
interface EntryUrgency {
  id: string;
  /** D − now in ms, so a failing diff shows where the entry sits. */
  msFromNow: number;
  dataUrgent: string | null;
  /** The visible "Urgent" badge is rendered inside this entry. */
  badge: boolean;
  /** The entry's accessible label ends with ", urgent". */
  labelEndsUrgent: boolean;
}

/** One exam per case, dated `msFromNow` after `now`, with ids unique per render. */
function examsFor(nowMs: number, cases: readonly UrgencyCase[]): Examination[] {
  return cases.map(({ msFromNow }, index) => ({
    id: `exam-${index}`,
    studentId: 'student-1',
    examName: `Exam ${index}`,
    subject: 'Algorithms',
    date: new Date(nowMs + msFromNow).toISOString(),
    notes: null,
  }));
}

function readEntryUrgency(id: string, msFromNow: number): EntryUrgency {
  const entry = screen.getByTestId(`exam-entry-${id}`);
  const badge = within(entry).queryByTestId(`exam-urgency-${id}`);
  if (badge) {
    expect(badge).toBeVisible();
    expect(badge).toHaveTextContent('Urgent');
  }
  return {
    id,
    msFromNow,
    dataUrgent: entry.getAttribute('data-urgent'),
    badge: badge !== null,
    labelEndsUrgent: /, urgent$/.test(entry.getAttribute('aria-label') ?? ''),
  };
}

/**
 * Render the cases' exams at `now`, and assert each entry shows the urgency
 * indicator exactly when its case says it must.
 */
function renderAndExpectUrgency(nowMs: number, cases: readonly UrgencyCase[]): void {
  const exams = examsFor(nowMs, cases);
  render(<FutureExaminationsApp examinations={exams} now={new Date(nowMs)} />);

  // Every exam is on the timeline, once.
  expect(screen.getAllByTestId(/^exam-entry-/)).toHaveLength(exams.length);

  const observed = exams.map((exam, i) => readEntryUrgency(exam.id, cases[i].msFromNow));
  const expected = exams.map(
    (exam, i): EntryUrgency => ({
      id: exam.id,
      msFromNow: cases[i].msFromNow,
      dataUrgent: String(cases[i].urgent),
      badge: cases[i].urgent,
      labelEndsUrgent: cases[i].urgent,
    })
  );
  expect(observed).toEqual(expected);

  // No badge anywhere else on the page.
  expect(screen.queryAllByTestId(/^exam-urgency-/)).toHaveLength(
    cases.filter((c) => c.urgent).length
  );
}

describe('Feature: fmi-os, Property 13: Exam Urgency Highlighting', () => {
  afterEach(cleanup);

  it('shows the urgency indicator on every exam from now to 7 days ahead, and on no other', () => {
    fc.assert(
      fc.property(scenarioArb, ({ nowMs, msFromNow }) => {
        try {
          renderAndExpectUrgency(
            nowMs,
            msFromNow.map((offset) => ({ msFromNow: offset, urgent: shouldBeUrgent(offset) }))
          );
        } finally {
          cleanup();
        }
      }),
      { numRuns: 200 }
    );
  }, 120_000);

  it('gets every boundary right, including exams that ended under a day ago', () => {
    // Off the hour, so no boundary lands on a round time.
    const nowMs = Date.UTC(2024, 5, 1, 9, 30, 15, 250);
    // Expected flags written out by hand, independent of the oracle above.
    renderAndExpectUrgency(nowMs, [
      { msFromNow: -2 * YEAR_MS, urgent: false }, // long past
      { msFromNow: -DAY_MS, urgent: false }, // exactly 24 h ago
      { msFromNow: -DAY_MS + 1, urgent: false }, // just under 24 h ago
      { msFromNow: -HOUR_MS, urgent: false }, // an hour ago
      { msFromNow: -1, urgent: false }, // 1 ms ago
      { msFromNow: 0, urgent: true }, // exactly now
      { msFromNow: 1, urgent: true }, // 1 ms from now
      { msFromNow: DAY_MS - 1, urgent: true }, // just under 24 h away
      { msFromNow: 3 * DAY_MS + 5 * HOUR_MS, urgent: true }, // mid-window
      { msFromNow: URGENCY_WINDOW_MS, urgent: true }, // exactly 7 days
      { msFromNow: URGENCY_WINDOW_MS + 1, urgent: false }, // 7 days + 1 ms
      { msFromNow: URGENCY_WINDOW_MS + 12 * HOUR_MS, urgent: false }, // 7.5 days
      { msFromNow: 2 * YEAR_MS, urgent: false }, // far future
    ]);
  });
});
