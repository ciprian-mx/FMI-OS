/**
 * Future Examinations data-layer helpers (Task 6.1, Requirements 9.1 / 9.2 / 9.3).
 *
 * The Future Examinations App (task 6.2) renders a student's upcoming exams as
 * a chronological timeline with an urgency indicator for exams that are close
 * at hand, and the 80/20 session generator (task 12.x) later prioritizes topics
 * tied to exams whose deadlines fall inside a near-term window. Both consumers
 * need the same pure transforms over a student's `Examination` list, so this
 * module provides them in one framework-agnostic place:
 *
 *   • {@link sortByDate}          — order exams strictly chronologically,
 *   • {@link daysUntil}           — whole days from "now" to an exam date,
 *   • {@link isUrgent}            — exam ≤ 7 days away (Requirement 9.5),
 *   • {@link isUpcomingWithin}    — exam inside a deadline window (e.g. 14 days,
 *                                   used by the session generator),
 *   • {@link partitionByTime}     — split into upcoming vs past,
 *   • {@link groupBySubject}      — group a student's exams by subject,
 *   • {@link toTimeline}          — the sorted, urgency-decorated view model the
 *                                   FutureExaminationsApp consumes directly.
 *
 * As with `src/materials/folderHierarchy.ts`, everything here is deliberately
 * storage- and React-agnostic: it operates on plain {@link Examination} objects
 * and returns plain data, leaving the AppSync `examinationsByStudent` query and
 * the add/edit/delete mutations to the caller. That keeps the ordering and
 * urgency logic trivially unit- and property-testable.
 *
 * DynamoDB / AppSync note: the `Examination` model's `byStudent` index now
 * carries `date` as its sort key (see
 * `amplify/backend/api/fmios/schema.graphql`), so `examinationsByStudent`
 * returns a single student's exams already ordered by `date` and the
 * chronological transforms below are effectively a no-op on freshly fetched
 * data. They are still applied client-side because add/edit mutations and
 * optimistic UI updates can momentarily interleave records out of order.
 *
 * MANUAL DEPLOY STEP: adding the `date` sort key to the existing `byStudent`
 * GSI changes the index definition. Run `amplify push` to provision the updated
 * index before the date-ordered query is available in a real backend. No new
 * table, auth rule, or other AWS resource is introduced — owner-based `@auth`
 * (and therefore the Property 2 isolation invariant) is unchanged.
 */

/**
 * A single upcoming examination. Mirrors the `Examination` GraphQL `@model`
 * (see `amplify/backend/api/fmios/schema.graphql`): it belongs to a student,
 * names the exam and its subject, carries an ISO-8601 `date`, and optionally a
 * free-text `notes` field.
 */
export interface Examination {
  id: string;
  studentId: string;
  examName: string;
  subject: string;
  /** ISO-8601 timestamp of the exam, e.g. "2024-06-01T09:00:00Z". */
  date: string;
  notes?: string | null;
}

/**
 * The urgency window, in days, inside which an exam is flagged as urgent in the
 * timeline (Requirement 9.5: "a visual indicator for examinations within 7
 * days").
 */
export const URGENCY_WINDOW_DAYS = 7;

/**
 * The near-term window, in days, the session generator uses to pull exams worth
 * prioritizing (Requirement 9.4: "deadlines within the next 14 days").
 */
export const SESSION_PRIORITY_WINDOW_DAYS = 14;

/** Milliseconds in one day — the unit {@link daysUntil} rounds to. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The timeline view model for one exam: the exam itself decorated with the
 * fields the FutureExaminationsApp needs to render each row — how many whole
 * days remain, whether it is urgent, and whether it is already in the past.
 */
export interface ExaminationTimelineEntry {
  examination: Examination;
  /** Whole days from the reference "now" to the exam (negative if past). */
  daysUntil: number;
  /** True when the exam is in the future and ≤ {@link URGENCY_WINDOW_DAYS} away. */
  isUrgent: boolean;
  /** True when the exam date is strictly before the reference "now". */
  isPast: boolean;
}

/**
 * Parses an exam `date` to epoch milliseconds. Returns `NaN` for a missing or
 * unparseable value so callers can detect and skip bad data rather than throw.
 */
export function parseExamDate(date: string): number {
  if (typeof date !== 'string' || date.length === 0) {
    return NaN;
  }
  return new Date(date).getTime();
}

/**
 * Returns a new array of exams sorted strictly chronologically by `date`
 * (earliest first). Exams with an unparseable date are sorted to the end in a
 * stable, deterministic order. The input array is never mutated.
 *
 * Ties (equal dates) are broken by `id` so the ordering is total and stable,
 * which keeps the timeline deterministic across renders.
 */
export function sortByDate(examinations: readonly Examination[]): Examination[] {
  return [...examinations].sort((a, b) => {
    const ta = parseExamDate(a.date);
    const tb = parseExamDate(b.date);
    const aBad = Number.isNaN(ta);
    const bBad = Number.isNaN(tb);
    if (aBad && bBad) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (aBad) return 1; // bad dates sink to the end
    if (bBad) return -1;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Whole days from `now` until the exam `date`, rounded up so that any part of a
 * day still counts as a day remaining. A result of `0` means the exam is today
 * (within the next 24 hours); a negative result means the exam is in the past.
 * Returns `NaN` for an unparseable date.
 *
 * `now` defaults to the current time but is injectable so tests and the
 * prioritization logic are deterministic.
 */
export function daysUntil(date: string, now: Date = new Date()): number {
  const target = parseExamDate(date);
  if (Number.isNaN(target)) {
    return NaN;
  }
  return Math.ceil((target - now.getTime()) / MS_PER_DAY);
}

/**
 * True when the exam is strictly in the past relative to `now`.
 */
export function isPast(exam: Examination, now: Date = new Date()): boolean {
  const target = parseExamDate(exam.date);
  if (Number.isNaN(target)) {
    return false;
  }
  return target < now.getTime();
}

/**
 * True when the exam is upcoming (now or in the future) and no more than
 * `windowDays` away — the predicate the timeline uses to flag urgency
 * (Requirement 9.5, default {@link URGENCY_WINDOW_DAYS}). Past exams are never
 * urgent.
 */
export function isUrgent(
  exam: Examination,
  now: Date = new Date(),
  windowDays: number = URGENCY_WINDOW_DAYS
): boolean {
  const remaining = daysUntil(exam.date, now);
  if (Number.isNaN(remaining)) {
    return false;
  }
  return remaining >= 0 && remaining <= windowDays;
}

/**
 * True when the exam falls inside the near-term window `[now, now + windowDays]`
 * — the predicate the session generator uses to pull exams worth prioritizing
 * (Requirement 9.4, default {@link SESSION_PRIORITY_WINDOW_DAYS}). Equivalent to
 * {@link isUrgent} with a wider default window; kept as a named helper so each
 * call site reads intentionally.
 */
export function isUpcomingWithin(
  exam: Examination,
  windowDays: number = SESSION_PRIORITY_WINDOW_DAYS,
  now: Date = new Date()
): boolean {
  const remaining = daysUntil(exam.date, now);
  if (Number.isNaN(remaining)) {
    return false;
  }
  return remaining >= 0 && remaining <= windowDays;
}

/**
 * Splits a student's exams into `upcoming` (now or future, chronologically
 * ordered) and `past` (already elapsed, most-recent first). Exams with an
 * unparseable date are dropped from both buckets. The input is never mutated.
 */
export function partitionByTime(
  examinations: readonly Examination[],
  now: Date = new Date()
): { upcoming: Examination[]; past: Examination[] } {
  const upcoming: Examination[] = [];
  const past: Examination[] = [];
  for (const exam of examinations) {
    if (Number.isNaN(parseExamDate(exam.date))) {
      continue;
    }
    if (isPast(exam, now)) {
      past.push(exam);
    } else {
      upcoming.push(exam);
    }
  }
  const sortedUpcoming = sortByDate(upcoming);
  const sortedPast = sortByDate(past).reverse(); // most recent past first
  return { upcoming: sortedUpcoming, past: sortedPast };
}

/**
 * Groups a student's exams by `subject`. Returns a Map keyed by subject whose
 * values are the exams for that subject, each list sorted chronologically. The
 * Map preserves first-seen subject order for deterministic rendering.
 */
export function groupBySubject(
  examinations: readonly Examination[]
): Map<string, Examination[]> {
  const groups = new Map<string, Examination[]>();
  for (const exam of examinations) {
    const bucket = groups.get(exam.subject);
    if (bucket) {
      bucket.push(exam);
    } else {
      groups.set(exam.subject, [exam]);
    }
  }
  for (const [subject, exams] of groups) {
    groups.set(subject, sortByDate(exams));
  }
  return groups;
}

/**
 * Builds the chronological, urgency-decorated timeline the FutureExaminationsApp
 * renders directly. Each entry is a {@link ExaminationTimelineEntry} carrying
 * the exam plus its `daysUntil`, `isUrgent`, and `isPast` flags. Exams are
 * ordered strictly by date (earliest first); unparseable dates sink to the end
 * with `daysUntil === NaN` so the UI can surface them as "needs attention"
 * rather than silently hiding them.
 */
export function toTimeline(
  examinations: readonly Examination[],
  now: Date = new Date()
): ExaminationTimelineEntry[] {
  return sortByDate(examinations).map((examination) => ({
    examination,
    daysUntil: daysUntil(examination.date, now),
    isUrgent: isUrgent(examination, now),
    isPast: isPast(examination, now),
  }));
}
