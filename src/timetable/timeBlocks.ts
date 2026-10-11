/**
 * Timetable data-layer helpers (Task 8.1, Requirements 11.1 / 11.4).
 *
 * A student's timetable is a set of weekly class blocks ("Algorithms, Monday
 * 10:00–12:00, Room 214"). The Timetable App renders them as a weekly grid
 * (task 8.3), the OCR Lambda extracts them from an uploaded image (task 8.2),
 * and the session generator must schedule study time around them (tasks 12.5 /
 * 12.7, Requirements 11.5 / 15.7). All three need the same rules over plain
 * block objects, so they live here with no imports at all: no React, no
 * Amplify, nothing a Lambda bundle could not include.
 *
 *   • Model:      {@link Day}, {@link TimeBlock}, {@link TimeRange}, raw
 *                 {@link TimeBlockInput} and validated {@link TimeBlockFields}.
 *   • Times:      {@link timeToMinutes}, {@link minutesToTime}, {@link normalizeTime}.
 *   • Days:       {@link parseDay}, {@link isDay}, {@link DAY_LABELS}.
 *   • Validation: {@link validateTimeBlockInput}.
 *   • Ordering:   {@link compareTimeBlocks}, {@link sortTimeBlocks}, {@link groupByDay}.
 *   • Overlap:    {@link minuteRangesOverlap}, {@link timeRangesOverlap},
 *                 {@link isValidTimeRange}, {@link findConflicts},
 *                 {@link isConflictFree}, {@link findOverlappingPairs}.
 *
 * Time format. Stored times are 24-hour, zero-padded "HH:MM" strings from 00:00
 * to 23:59. Parsing also accepts a one-digit hour ("8:05"), because OCR output
 * and typed input often drop the zero, and validation normalizes it ("08:05")
 * before anything is saved. A block never crosses midnight: its start must be
 * strictly before its end on the same day.
 *
 * Overlap semantics. A range covers the half-open minute interval
 * [start, end): its start minute up to, but not including, its end minute.
 * Ranges that only touch therefore do NOT overlap. Back-to-back classes
 * (10:00–12:00, 12:00–14:00) don't conflict, and a study slot may begin the
 * minute a class ends. Ranges on different days never overlap. A malformed
 * range (unknown day, unparseable time) or an empty or reversed one
 * (start ≥ end) covers no time, so it overlaps nothing.
 *
 * Overlapping blocks are allowed in a timetable (alternating-week seminars,
 * optional courses), so validation never rejects them. Callers use
 * {@link findConflicts} / {@link findOverlappingPairs} to warn instead.
 */

/* -------------------------------------------------------------------------- *
 * Model
 * -------------------------------------------------------------------------- */

/** Days in timetable order (Monday first), spelled as in the GraphQL `Day` enum. */
export const DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

/** A day of the week: one value of the GraphQL `Day` enum. */
export type Day = (typeof DAYS)[number];

/** Display names for the weekly grid's columns. */
export const DAY_LABELS: Readonly<Record<Day, string>> = {
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
  FRIDAY: 'Friday',
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
};

/**
 * A stretch of time on one weekday. Class blocks are time ranges, and so is
 * any candidate checked against them, such as a proposed study slot.
 */
export interface TimeRange {
  day: Day;
  /** "HH:MM", 24-hour. */
  startTime: string;
  /** "HH:MM", 24-hour; strictly after `startTime` for a valid range. */
  endTime: string;
}

/**
 * A persisted class block. Mirrors the `TimeBlock` GraphQL `@model` in
 * `amplify/backend/api/fmios/schema.graphql`.
 */
export interface TimeBlock extends TimeRange {
  id: string;
  /** The owning student (Cognito `sub`); partition key of the `byStudent` index. */
  studentId: string;
  className: string;
  location?: string | null;
}

/**
 * The editable fields of a block before validation, as typed into the grid's
 * form or extracted by OCR. `day` may be any casing of a day name ("Monday",
 * "MONDAY"); times may omit the hour's leading zero. A {@link TimeBlock}
 * satisfies this shape, so a stored block can be re-validated as-is.
 */
export interface TimeBlockInput {
  day: string;
  startTime: string;
  endTime: string;
  className: string;
  location?: string | null;
}

/** The validated, normalized editable fields: what the create / update mutations send. */
export interface TimeBlockFields extends TimeRange {
  /** Trimmed, with inner whitespace collapsed to single spaces. */
  className: string;
  /** Trimmed like `className`; `null` when blank, which clears it on update. */
  location: string | null;
}

/** True when `value` is one of the seven {@link DAYS}, spelled exactly as the enum. */
export function isDay(value: unknown): value is Day {
  return typeof value === 'string' && (DAYS as readonly string[]).includes(value);
}

/**
 * Reads a day name case-insensitively, ignoring surrounding whitespace, so
 * "MONDAY", "Monday" and " monday " all yield `'MONDAY'`. Returns `null` for
 * anything else, including abbreviations ("Mon") and non-strings.
 */
export function parseDay(value: unknown): Day | null {
  if (typeof value !== 'string') {
    return null;
  }
  const candidate = value.trim().toUpperCase();
  return isDay(candidate) ? candidate : null;
}

/* -------------------------------------------------------------------------- *
 * Times
 * -------------------------------------------------------------------------- */

/** Minutes in a day. Valid times are 0 (00:00) to `MINUTES_PER_DAY - 1` (23:59). */
export const MINUTES_PER_DAY = 24 * 60;

/** A one- or two-digit hour and exactly two minute digits. */
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/**
 * Minutes since midnight for a 24-hour time: "10:30" → 630, "8:05" → 485.
 * Surrounding whitespace is ignored. Returns `NaN` for anything that is not a
 * time from 00:00 to 23:59 ("24:00", "12:60", "1200", "noon"), so a malformed
 * time compares false with everything.
 */
export function timeToMinutes(time: string): number {
  if (typeof time !== 'string') {
    return NaN;
  }
  const match = TIME_PATTERN.exec(time.trim());
  if (!match) {
    return NaN;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return NaN;
  }
  return hours * 60 + minutes;
}

/**
 * Formats minutes since midnight as zero-padded "HH:MM": 630 → "10:30".
 * Throws a `RangeError` unless `minutes` is a whole number from 0 to 1439.
 */
export function minutesToTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
    throw new RangeError(
      `Expected whole minutes from 0 to ${MINUTES_PER_DAY - 1}, got ${minutes}.`
    );
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** The stored "HH:MM" form of a time ("8:05" → "08:05"), or `null` when it is not valid. */
export function normalizeTime(time: string): string | null {
  const minutes = timeToMinutes(time);
  return Number.isNaN(minutes) ? null : minutesToTime(minutes);
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

/** Longest class name accepted, in UTF-16 code units. */
export const MAX_CLASS_NAME_LENGTH = 200;

/** Longest location accepted, in UTF-16 code units. */
export const MAX_LOCATION_LENGTH = 200;

/** User-facing validation messages, keyed by rule. */
export const TIME_BLOCK_ERRORS = {
  dayRequired: 'Day is required.',
  dayInvalid: 'Day must be one of Monday to Sunday.',
  startTimeRequired: 'Start time is required.',
  startTimeInvalid: 'Start time must be a valid time from 00:00 to 23:59 (HH:MM).',
  endTimeRequired: 'End time is required.',
  endTimeInvalid: 'End time must be a valid time from 00:00 to 23:59 (HH:MM).',
  endNotAfterStart: 'End time must be after start time.',
  classNameRequired: 'Class name is required.',
  classNameTooLong: `Class name must be ${MAX_CLASS_NAME_LENGTH} characters or fewer.`,
  locationTooLong: `Location must be ${MAX_LOCATION_LENGTH} characters or fewer.`,
} as const;

/** A field of {@link TimeBlockInput}. */
export type TimeBlockField = keyof TimeBlockInput;

/** One message per invalid field. */
export type TimeBlockErrors = Partial<Record<TimeBlockField, string>>;

/** Outcome of {@link validateTimeBlockInput}. */
export type TimeBlockValidation =
  | { ok: true; value: TimeBlockFields }
  | { ok: false; errors: TimeBlockErrors };

/** Text from an untrusted value: `''` for null / undefined, otherwise `String(value)`. */
function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Trims and collapses inner whitespace runs, line breaks included, to one space. */
function cleanText(value: unknown): string {
  return toText(value).replace(/\s+/g, ' ').trim();
}

/**
 * Validates and normalizes a block's editable fields. Every rule is checked,
 * so a form can show all of its errors at once:
 *
 *   • `day` is required and must name a weekday (any casing) → canonical {@link Day};
 *   • `startTime` / `endTime` are required valid times → zero-padded "HH:MM";
 *   • the start must be strictly before the end (same day, no midnight wrap);
 *   • `className` is required after trimming and collapsing whitespace;
 *   • `location` is optional; blank becomes `null`.
 *
 * Values are coerced defensively, so untrusted OCR / JSON input (missing
 * fields, numbers) produces field errors rather than throwing.
 */
export function validateTimeBlockInput(input: TimeBlockInput): TimeBlockValidation {
  const errors: TimeBlockErrors = {};

  const rawDay = toText(input.day).trim();
  const day = parseDay(rawDay);
  if (rawDay.length === 0) {
    errors.day = TIME_BLOCK_ERRORS.dayRequired;
  } else if (day === null) {
    errors.day = TIME_BLOCK_ERRORS.dayInvalid;
  }

  const rawStart = toText(input.startTime).trim();
  const startTime = normalizeTime(rawStart);
  if (rawStart.length === 0) {
    errors.startTime = TIME_BLOCK_ERRORS.startTimeRequired;
  } else if (startTime === null) {
    errors.startTime = TIME_BLOCK_ERRORS.startTimeInvalid;
  }

  const rawEnd = toText(input.endTime).trim();
  const endTime = normalizeTime(rawEnd);
  if (rawEnd.length === 0) {
    errors.endTime = TIME_BLOCK_ERRORS.endTimeRequired;
  } else if (endTime === null) {
    errors.endTime = TIME_BLOCK_ERRORS.endTimeInvalid;
  } else if (startTime !== null && timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    errors.endTime = TIME_BLOCK_ERRORS.endNotAfterStart;
  }

  const className = cleanText(input.className);
  if (className.length === 0) {
    errors.className = TIME_BLOCK_ERRORS.classNameRequired;
  } else if (className.length > MAX_CLASS_NAME_LENGTH) {
    errors.className = TIME_BLOCK_ERRORS.classNameTooLong;
  }

  const location = cleanText(input.location);
  if (location.length > MAX_LOCATION_LENGTH) {
    errors.location = TIME_BLOCK_ERRORS.locationTooLong;
  }

  if (day === null || startTime === null || endTime === null || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      day,
      startTime,
      endTime,
      className,
      location: location.length > 0 ? location : null,
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Ordering
 * -------------------------------------------------------------------------- */

/**
 * The block shape the ordering and conflict helpers accept: persisted blocks,
 * validated fields and unsaved OCR drafts alike.
 */
export interface SortableTimeBlock extends TimeRange {
  className?: string | null;
  id?: string | null;
}

/** Weekday position (Monday = 0); unknown days rank after Sunday. */
function dayRank(day: unknown): number {
  return isDay(day) ? DAYS.indexOf(day) : DAYS.length;
}

/** Minutes since midnight; unparseable times rank after every valid time. */
function minuteRank(time: string): number {
  const minutes = timeToMinutes(time);
  return Number.isNaN(minutes) ? MINUTES_PER_DAY : minutes;
}

/** Code-unit comparison, so the order is identical in every environment. */
function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/**
 * Timetable order: day (Monday → Sunday), then start time, then end time (the
 * shorter of two blocks starting together comes first), then class name, then
 * id. That is a total order on persisted blocks, so the grid renders the same
 * way whatever order DynamoDB returns them in. A block with an unknown day sorts
 * after Sunday; an unparseable time sorts after the valid ones of its day.
 */
export function compareTimeBlocks(a: SortableTimeBlock, b: SortableTimeBlock): number {
  return (
    dayRank(a.day) - dayRank(b.day) ||
    minuteRank(a.startTime) - minuteRank(b.startTime) ||
    minuteRank(a.endTime) - minuteRank(b.endTime) ||
    compareText(a.className, b.className) ||
    compareText(a.id, b.id)
  );
}

/**
 * Returns a new array in {@link compareTimeBlocks} order without mutating the
 * input. The sort is stable: blocks that compare equal, which needs equal ids
 * (such as id-less drafts), keep their input order.
 */
export function sortTimeBlocks<T extends SortableTimeBlock>(blocks: readonly T[]): T[] {
  return [...blocks].sort(compareTimeBlocks);
}

/**
 * Buckets blocks into the grid's seven day columns. Every day is present (an
 * empty array when there is no class that day) and each column is in timetable
 * order. A block whose `day` is not a valid {@link Day} has no column and is
 * left out.
 */
export function groupByDay<T extends SortableTimeBlock>(blocks: readonly T[]): Record<Day, T[]> {
  const columns = {} as Record<Day, T[]>;
  for (const day of DAYS) {
    columns[day] = [];
  }
  for (const block of sortTimeBlocks(blocks)) {
    if (isDay(block.day)) {
      columns[block.day].push(block);
    }
  }
  return columns;
}

/* -------------------------------------------------------------------------- *
 * Overlap and conflicts
 * -------------------------------------------------------------------------- */

/**
 * True when the half-open minute ranges [aStart, aEnd) and [bStart, bEnd)
 * share at least one minute. Touching ranges (aEnd === bStart) don't overlap.
 * An empty or reversed range (start ≥ end) and `NaN` bounds overlap nothing.
 */
export function minuteRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

/**
 * True when two time ranges (class blocks, or a block and any candidate range)
 * fall on the same day and share at least one minute. Uses the half-open
 * semantics described in the module header: touching ranges don't overlap, and
 * malformed, empty or reversed ranges overlap nothing. Symmetric.
 */
export function timeRangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return (
    isDay(a.day) &&
    a.day === b.day &&
    minuteRangesOverlap(
      timeToMinutes(a.startTime),
      timeToMinutes(a.endTime),
      timeToMinutes(b.startTime),
      timeToMinutes(b.endTime)
    )
  );
}

/** True when `range` has a valid day and valid times, with start strictly before end. */
export function isValidTimeRange(range: TimeRange): boolean {
  return isDay(range.day) && timeToMinutes(range.startTime) < timeToMinutes(range.endTime);
}

/** Options for {@link findConflicts}. */
export interface FindConflictsOptions {
  /** Skip the block with this id, e.g. the block being edited, so it can't conflict with itself. */
  ignoreId?: string;
}

/**
 * The blocks that overlap `candidate`, in input order. Use it to warn when an
 * added or edited block clashes with existing classes (pass the edited block's
 * id as `ignoreId`). An empty result means no clash; it does not mean the
 * candidate is well formed (see {@link isConflictFree}).
 */
export function findConflicts<T extends SortableTimeBlock>(
  candidate: TimeRange,
  blocks: readonly T[],
  options: FindConflictsOptions = {}
): T[] {
  const { ignoreId } = options;
  return blocks.filter(
    (block) =>
      (ignoreId === undefined || block.id !== ignoreId) && timeRangesOverlap(candidate, block)
  );
}

/**
 * True when `candidate` is a valid range ({@link isValidTimeRange}) that
 * overlaps none of `blocks`. This is the check for a proposed study slot
 * (Requirements 11.5 / 15.7). A malformed candidate overlaps nothing, but it is
 * never conflict-free, so a bad slot can't pass the check vacuously.
 */
export function isConflictFree(candidate: TimeRange, blocks: readonly TimeRange[]): boolean {
  return (
    isValidTimeRange(candidate) && !blocks.some((block) => timeRangesOverlap(candidate, block))
  );
}

/**
 * Every pair of overlapping blocks in a timetable, each pair once and in
 * timetable order (a pair's earlier block first, pairs ordered by that block).
 * Used to flag clashes, such as OCR rows that need a review.
 */
export function findOverlappingPairs<T extends SortableTimeBlock>(
  blocks: readonly T[]
): Array<[T, T]> {
  const sorted = sortTimeBlocks(blocks);
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (timeRangesOverlap(sorted[i], sorted[j])) {
        pairs.push([sorted[i], sorted[j]]);
      }
    }
  }
  return pairs;
}
