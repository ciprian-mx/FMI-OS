import fc from 'fast-check';
import {
  DAYS,
  MINUTES_PER_DAY,
  TIME_BLOCK_ERRORS,
  compareTimeBlocks,
  isValidTimeRange,
  minutesToTime,
  normalizeTime,
  sortTimeBlocks,
  timeRangesOverlap,
  timeToMinutes,
  validateTimeBlockInput,
  type Day,
  type TimeRange,
} from './timeBlocks';

/**
 * Feature: fmi-os, Task 8.1: TimeBlock model invariants
 *
 * **Validates: Requirements 11.4**
 *
 * fast-check properties for the helpers behind manual add / edit (validation
 * and normalization), the weekly grid (timetable order) and clash checks
 * (half-open overlap). They are helper invariants, not one of the design's
 * numbered properties: Property 14 (generated sessions avoid class times) is
 * tested with the session generator in task 12.7.
 *
 * Oracles are independent of the module: times are built from generated
 * minute counts by the local `formatTime`, overlap is checked minute by minute,
 * and expected class names are assembled from the generated words.
 */

const LAST_MINUTE = MINUTES_PER_DAY - 1;

/** "HH:MM", or "H:MM" with the hour's leading zero dropped, as OCR and typed input often have it. */
function formatTime(minutes: number, padHour: boolean): string {
  const hours = String(Math.floor(minutes / 60));
  const mins = String(minutes % 60).padStart(2, '0');
  return `${padHour ? hours.padStart(2, '0') : hours}:${mins}`;
}

const canonical = (minutes: number): string => formatTime(minutes, true);

const CANONICAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

describe('Feature: fmi-os, Task 8.1: time conversion', () => {
  it('reads every valid time, padded or not, and formats it back as HH:MM', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: LAST_MINUTE }), fc.boolean(), (minutes, padHour) => {
        const time = formatTime(minutes, padHour);
        expect(timeToMinutes(time)).toBe(minutes);
        expect(minutesToTime(minutes)).toBe(canonical(minutes));
        expect(normalizeTime(time)).toBe(canonical(minutes));
      }),
      { numRuns: 300 }
    );
  });

  it('normalizes any string to null or to a canonical HH:MM that is its own normal form', () => {
    const timeLike = fc.oneof(
      fc.string({ maxLength: 8 }),
      fc
        .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }), fc.boolean())
        .map(([hours, minutes, padHour]) => {
          const h = padHour ? String(hours).padStart(2, '0') : String(hours);
          return `${h}:${String(minutes).padStart(2, '0')}`;
        })
    );

    fc.assert(
      fc.property(timeLike, (value) => {
        const normalized = normalizeTime(value);
        if (normalized === null) {
          expect(timeToMinutes(value)).toBeNaN();
          return;
        }
        expect(normalized).toMatch(CANONICAL_TIME);
        expect(normalizeTime(normalized)).toBe(normalized);
        expect(timeToMinutes(normalized)).toBe(timeToMinutes(value));
      }),
      { numRuns: 300 }
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Overlap
 * -------------------------------------------------------------------------- */

/** A range as generated: minute bounds in any order (so some are empty or reversed). */
interface MinuteRange {
  day: Day;
  start: number;
  end: number;
  padHour: boolean;
}

/** Days weighted towards one, so that pairs of ranges often share a day. */
const dayArb: fc.Arbitrary<Day> = fc.oneof(
  { arbitrary: fc.constant<Day>('WEDNESDAY'), weight: 3 },
  { arbitrary: fc.constantFrom(...DAYS), weight: 1 }
);

/** Minutes, with shared anchors so ranges often touch or coincide. */
const minuteArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: LAST_MINUTE }), weight: 2 },
  { arbitrary: fc.constantFrom(0, 480, 600, 720, LAST_MINUTE), weight: 1 }
);

const minuteRangeArb: fc.Arbitrary<MinuteRange> = fc.record({
  day: dayArb,
  start: minuteArb,
  end: minuteArb,
  padHour: fc.boolean(),
});

const toTimeRange = ({ day, start, end, padHour }: MinuteRange): TimeRange => ({
  day,
  startTime: formatTime(start, padHour),
  endTime: formatTime(end, padHour),
});

/** Oracle: some minute m has start <= m < end in both ranges, on the same day. */
function shareAMinute(a: MinuteRange, b: MinuteRange): boolean {
  if (a.day !== b.day) {
    return false;
  }
  for (let m = 0; m < MINUTES_PER_DAY; m += 1) {
    if (a.start <= m && m < a.end && b.start <= m && m < b.end) {
      return true;
    }
  }
  return false;
}

/** Times that are sometimes malformed, for checks that must hold for any input. */
const anyTimeArb = fc.oneof(
  { arbitrary: fc.tuple(minuteArb, fc.boolean()).map(([m, pad]) => formatTime(m, pad)), weight: 4 },
  { arbitrary: fc.constantFrom('24:00', '12:60', '', 'noon', '7', ' 8:00 '), weight: 1 }
);

/**
 * Pairs of ranges: mostly independent, sometimes built so that the second
 * starts where the first ends (or ends where it starts), to exercise touching.
 */
const rangePairArb: fc.Arbitrary<[MinuteRange, MinuteRange]> = fc.oneof(
  { arbitrary: fc.tuple(minuteRangeArb, minuteRangeArb), weight: 3 },
  {
    arbitrary: fc
      .tuple(minuteRangeArb, minuteArb, fc.boolean(), fc.boolean())
      .map(([a, other, after, padHour]): [MinuteRange, MinuteRange] => [
        a,
        after
          ? { day: a.day, start: a.end, end: other, padHour }
          : { day: a.day, start: other, end: a.start, padHour },
      ]),
    weight: 1,
  }
);

const anyRangeArb: fc.Arbitrary<TimeRange> = fc.record({
  day: fc.oneof(
    { arbitrary: dayArb, weight: 5 },
    { arbitrary: fc.constant('FUNDAY' as Day), weight: 1 }
  ),
  startTime: anyTimeArb,
  endTime: anyTimeArb,
});

describe('Feature: fmi-os, Task 8.1: half-open overlap', () => {
  it('reports an overlap exactly when two ranges share a minute on the same day', () => {
    let overlapping = 0;
    let touching = 0;

    fc.assert(
      fc.property(rangePairArb, ([a, b]) => {
        const expected = shareAMinute(a, b);
        expect(timeRangesOverlap(toTimeRange(a), toTimeRange(b))).toBe(expected);

        if (expected) {
          overlapping += 1;
        }
        const proper = a.start < a.end && b.start < b.end;
        if (proper && a.day === b.day && (a.end === b.start || b.end === a.start)) {
          touching += 1;
          // Ranges that only touch never overlap.
          expect(expected).toBe(false);
        }
      }),
      { numRuns: 400 }
    );

    expect(overlapping).toBeGreaterThan(0);
    expect(touching).toBeGreaterThan(0);
  });

  it('is symmetric, and a range overlaps itself iff it is valid, even for malformed input', () => {
    fc.assert(
      fc.property(anyRangeArb, anyRangeArb, (a, b) => {
        expect(timeRangesOverlap(a, b)).toBe(timeRangesOverlap(b, a));
        expect(timeRangesOverlap(a, a)).toBe(isValidTimeRange(a));
      }),
      { numRuns: 300 }
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Timetable order
 * -------------------------------------------------------------------------- */

/** A generated block. */
interface GeneratedBlock {
  id?: string;
  day: Day;
  startTime: string;
  endTime: string;
  className: string;
  /** The generated start minute, for the ordering oracle. */
  start: number;
}

const blockFieldsArb: fc.Arbitrary<GeneratedBlock> = fc
  .record({
    day: fc.constantFrom(...DAYS),
    start: fc.oneof(
      fc.integer({ min: 0, max: LAST_MINUTE - 1 }),
      fc.constantFrom(480, 600, 720)
    ),
    length: fc.oneof(fc.integer({ min: 1, max: 240 }), fc.constantFrom(60, 120)),
    className: fc.constantFrom('Algorithms', 'Databases', 'Logic'),
    padHour: fc.boolean(),
  })
  .map(({ day, start, length, className, padHour }) => ({
    day,
    startTime: formatTime(start, padHour),
    endTime: formatTime(Math.min(start + length, LAST_MINUTE), padHour),
    className,
    start,
  }));

/** Timetables of persisted blocks: unique ids. */
const timetableArb: fc.Arbitrary<GeneratedBlock[]> = fc
  .uniqueArray(fc.tuple(fc.uuid(), blockFieldsArb), {
    selector: ([id]) => id,
    maxLength: 25,
  })
  .map((entries) => entries.map(([id, fields]) => ({ ...fields, id })));

describe('Feature: fmi-os, Task 8.1: timetable order', () => {
  it('sorts any timetable Monday to Sunday, then by start time, as a permutation of its input', () => {
    fc.assert(
      fc.property(timetableArb, (blocks) => {
        const sorted = sortTimeBlocks(blocks);

        // Same objects, each exactly once.
        expect(sorted).toHaveLength(blocks.length);
        expect(new Set(sorted).size).toBe(blocks.length);
        expect(sorted.every((b) => blocks.includes(b))).toBe(true);
        for (let i = 1; i < sorted.length; i += 1) {
          const prev = sorted[i - 1];
          const next = sorted[i];
          const dayOrder = DAYS.indexOf(prev.day) - DAYS.indexOf(next.day);
          expect(dayOrder < 0 || (dayOrder === 0 && prev.start <= next.start)).toBe(true);
          expect(compareTimeBlocks(prev, next)).toBeLessThan(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('produces the same order from any permutation of the same blocks', () => {
    const withShuffle = timetableArb.chain((blocks) =>
      fc.tuple(
        fc.constant(blocks),
        fc.shuffledSubarray(blocks, { minLength: blocks.length, maxLength: blocks.length })
      )
    );

    fc.assert(
      fc.property(withShuffle, ([blocks, shuffled]) => {
        const ids = (list: GeneratedBlock[]) => sortTimeBlocks(list).map((b) => b.id);
        expect(ids(shuffled)).toEqual(ids(blocks));
      }),
      { numRuns: 200 }
    );
  });

  it('is stable and idempotent: blocks that compare equal keep their input order', () => {
    // Id-less drafts from a small pool of fields, so equal blocks are common.
    const pool = fc.constantFrom(
      ...DAYS.slice(0, 2).flatMap((day) =>
        ['08:00', '10:00'].map((startTime) => ({
          day,
          startTime,
          endTime: '12:00',
          className: 'Algorithms',
        }))
      )
    );
    const draftsArb = fc
      .array(pool, { maxLength: 30 })
      .map((drafts) => drafts.map((draft, seq) => ({ ...draft, seq })));

    let ties = 0;
    fc.assert(
      fc.property(draftsArb, (drafts) => {
        const sorted = sortTimeBlocks(drafts);
        for (let i = 1; i < sorted.length; i += 1) {
          if (compareTimeBlocks(sorted[i - 1], sorted[i]) === 0) {
            ties += 1;
            expect(sorted[i - 1].seq).toBeLessThan(sorted[i].seq);
          }
        }
        const again = sortTimeBlocks(sorted);
        again.forEach((draft, i) => expect(draft).toBe(sorted[i]));
      }),
      { numRuns: 200 }
    );
    expect(ties).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Validation and normalization
 * -------------------------------------------------------------------------- */

const wordArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzĂÂÎȘȚăâîșț0123456789()-'.split('')),
  { minLength: 1, maxLength: 12 }
);
const gapArb = fc.constantFrom(' ', '  ', '\t', '\n', ' \r\n ');
const edgeArb = fc.constantFrom('', ' ', '\n', ' \t ');

/** Words joined by arbitrary whitespace and padded with it; `expected` is the normalized text. */
const messyTextArb = fc
  .tuple(fc.array(fc.tuple(wordArb, gapArb), { minLength: 1, maxLength: 5 }), edgeArb, edgeArb)
  .map(([parts, lead, trail]) => ({
    raw: lead + parts.map(([word, gap]) => word + gap).join('') + trail,
    expected: parts.map(([word]) => word).join(' '),
  }));

const timeOrderArb = fc
  .tuple(fc.integer({ min: 0, max: LAST_MINUTE }), fc.integer({ min: 0, max: LAST_MINUTE }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const);

describe('Feature: fmi-os, Task 8.1: validation and normalization', () => {
  it('accepts any well-formed input, normalizes it, and the result validates to itself', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DAYS),
        // Which letters of the day name to lower-case ("WEDNESDAY" has nine).
        fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
        edgeArb,
        timeOrderArb,
        fc.boolean(),
        messyTextArb,
        fc.option(messyTextArb, { nil: null }),
        (day, lowerMask, pad, [start, end], padHour, className, location) => {
          const dayText = [...day].map((c, i) => (lowerMask[i] ? c.toLowerCase() : c)).join('');
          const input = {
            day: `${pad}${dayText}${pad}`,
            startTime: formatTime(start, padHour),
            endTime: formatTime(end, padHour),
            className: className.raw,
            // A missing location arrives as blank text.
            location: location === null ? pad : location.raw,
          };

          const result = validateTimeBlockInput(input);

          expect(result).toEqual({
            ok: true,
            value: {
              day,
              startTime: canonical(start),
              endTime: canonical(end),
              className: className.expected,
              location: location === null ? null : location.expected,
            },
          });
          if (result.ok) {
            expect(validateTimeBlockInput(result.value)).toEqual(result);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it('rejects any block whose end is not after its start', () => {
    const notAfter = fc
      .tuple(fc.integer({ min: 0, max: LAST_MINUTE }), fc.integer({ min: 0, max: LAST_MINUTE }))
      .map(([a, b]) => [Math.max(a, b), Math.min(a, b)] as const);

    fc.assert(
      fc.property(fc.constantFrom(...DAYS), notAfter, fc.boolean(), (day, [start, end], padHour) => {
        expect(
          validateTimeBlockInput({
            day,
            startTime: formatTime(start, padHour),
            endTime: formatTime(end, padHour),
            className: 'Algorithms',
          })
        ).toEqual({ ok: false, errors: { endTime: TIME_BLOCK_ERRORS.endNotAfterStart } });
      }),
      { numRuns: 200 }
    );
  });
});
