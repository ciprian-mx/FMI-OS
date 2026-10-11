import {
  DAYS,
  DAY_LABELS,
  MAX_CLASS_NAME_LENGTH,
  MAX_LOCATION_LENGTH,
  TIME_BLOCK_ERRORS,
  compareTimeBlocks,
  findConflicts,
  findOverlappingPairs,
  groupByDay,
  isConflictFree,
  isValidTimeRange,
  minuteRangesOverlap,
  minutesToTime,
  normalizeTime,
  parseDay,
  sortTimeBlocks,
  timeRangesOverlap,
  timeToMinutes,
  validateTimeBlockInput,
  type Day,
  type TimeBlock,
  type TimeBlockInput,
} from './timeBlocks';

/**
 * Task 8.1 — TimeBlock model helpers (Requirements 11.1, 11.4).
 *
 * Time and day parsing, validation / normalization of add and edit input,
 * timetable ordering and grid grouping, and the half-open overlap rules the
 * grid (task 8.3) and the session generator (task 12.5) rely on.
 */

function block(
  id: string,
  day: Day,
  startTime: string,
  endTime: string,
  className = `Class ${id}`
): TimeBlock {
  return { id, studentId: 'student-1', day, startTime, endTime, className, location: null };
}

const ids = (blocks: readonly { id?: string | null }[]) => blocks.map((b) => b.id);

describe('time conversion', () => {
  it.each([
    ['00:00', 0],
    ['08:00', 480],
    ['8:00', 480],
    ['10:30', 630],
    ['23:59', 1439],
    [' 9:05 ', 545],
  ])('reads %j as %i minutes', (time, minutes) => {
    expect(timeToMinutes(time)).toBe(minutes);
  });

  it.each(['24:00', '12:60', '1200', '12:5', '123:00', '12:00:00', '-1:00', '12 :00', 'ab:cd', ''])(
    'rejects %j',
    (time) => {
      expect(timeToMinutes(time)).toBeNaN();
      expect(normalizeTime(time)).toBeNull();
    }
  );

  it('formats minutes as zero-padded HH:MM', () => {
    expect(minutesToTime(0)).toBe('00:00');
    expect(minutesToTime(485)).toBe('08:05');
    expect(minutesToTime(1439)).toBe('23:59');
  });

  it.each([-1, 1440, 1.5, NaN])('refuses to format %p minutes', (minutes) => {
    expect(() => minutesToTime(minutes)).toThrow(RangeError);
  });

  it('normalizes a one-digit hour', () => {
    expect(normalizeTime('8:05')).toBe('08:05');
    expect(normalizeTime(' 13:00 ')).toBe('13:00');
  });
});

describe('parseDay', () => {
  it.each([
    ['MONDAY', 'MONDAY'],
    ['Monday', 'MONDAY'],
    [' sunday ', 'SUNDAY'],
  ])('reads %j as %s', (value, day) => {
    expect(parseDay(value)).toBe(day);
  });

  it.each(['Mon', '', 'Funday', 'Luni', 42, null])('rejects %p', (value) => {
    expect(parseDay(value)).toBeNull();
  });

  it('labels every day, Monday first', () => {
    expect(DAYS.map((day) => DAY_LABELS[day])).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });
});

describe('validateTimeBlockInput', () => {
  const valid: TimeBlockInput = {
    day: 'MONDAY',
    startTime: '10:00',
    endTime: '12:00',
    className: 'Algorithms',
    location: 'Room 214',
  };

  it('normalizes day, times, class name and location', () => {
    expect(
      validateTimeBlockInput({
        day: ' monday ',
        startTime: '8:00',
        endTime: ' 9:30',
        className: '  Algorithms \n  Lecture ',
        location: '\tRoom   214 ',
      })
    ).toEqual({
      ok: true,
      value: {
        day: 'MONDAY',
        startTime: '08:00',
        endTime: '09:30',
        className: 'Algorithms Lecture',
        location: 'Room 214',
      },
    });
  });

  it.each([undefined, null, '', '   '])('stores a blank location (%p) as null', (location) => {
    const result = validateTimeBlockInput({ ...valid, location });
    expect(result).toEqual({ ok: true, value: { ...valid, location: null } });
  });

  it('reports every missing required field at once', () => {
    expect(
      validateTimeBlockInput({ day: '', startTime: ' ', endTime: '', className: ' \n ' })
    ).toEqual({
      ok: false,
      errors: {
        day: TIME_BLOCK_ERRORS.dayRequired,
        startTime: TIME_BLOCK_ERRORS.startTimeRequired,
        endTime: TIME_BLOCK_ERRORS.endTimeRequired,
        className: TIME_BLOCK_ERRORS.classNameRequired,
      },
    });
  });

  it('rejects an unknown day and malformed times', () => {
    expect(
      validateTimeBlockInput({ ...valid, day: 'Mon', startTime: '24:00', endTime: '9.30' })
    ).toEqual({
      ok: false,
      errors: {
        day: TIME_BLOCK_ERRORS.dayInvalid,
        startTime: TIME_BLOCK_ERRORS.startTimeInvalid,
        endTime: TIME_BLOCK_ERRORS.endTimeInvalid,
      },
    });
  });

  it.each([
    ['10:00', '10:00'],
    ['12:00', '10:00'],
    ['23:59', '00:00'],
  ])('requires the start (%s) to be strictly before the end (%s)', (startTime, endTime) => {
    expect(validateTimeBlockInput({ ...valid, startTime, endTime })).toEqual({
      ok: false,
      errors: { endTime: TIME_BLOCK_ERRORS.endNotAfterStart },
    });
  });

  it('accepts the longest class name and location, and rejects longer ones', () => {
    const longestName = 'a'.repeat(MAX_CLASS_NAME_LENGTH);
    const longestLocation = 'b'.repeat(MAX_LOCATION_LENGTH);
    expect(
      validateTimeBlockInput({ ...valid, className: longestName, location: longestLocation }).ok
    ).toBe(true);
    expect(
      validateTimeBlockInput({
        ...valid,
        className: `${longestName}a`,
        location: `${longestLocation}b`,
      })
    ).toEqual({
      ok: false,
      errors: {
        className: TIME_BLOCK_ERRORS.classNameTooLong,
        location: TIME_BLOCK_ERRORS.locationTooLong,
      },
    });
  });

  it('turns untrusted non-string values into field errors instead of throwing', () => {
    const untrusted = {
      day: 3,
      startTime: 800,
      endTime: null,
      className: undefined,
    } as unknown as TimeBlockInput;

    expect(validateTimeBlockInput(untrusted)).toEqual({
      ok: false,
      errors: {
        day: TIME_BLOCK_ERRORS.dayInvalid,
        startTime: TIME_BLOCK_ERRORS.startTimeInvalid,
        endTime: TIME_BLOCK_ERRORS.endTimeRequired,
        className: TIME_BLOCK_ERRORS.classNameRequired,
      },
    });
  });

  it('accepts a stored block as input', () => {
    const stored = block('a', 'FRIDAY', '14:00', '16:00', 'Databases');
    expect(validateTimeBlockInput(stored)).toEqual({
      ok: true,
      value: {
        day: 'FRIDAY',
        startTime: '14:00',
        endTime: '16:00',
        className: 'Databases',
        location: null,
      },
    });
  });
});

describe('timetable ordering', () => {
  it('orders days Monday to Sunday, not alphabetically', () => {
    const blocks = [...DAYS].reverse().map((day) => block(day, day, '10:00', '11:00'));
    expect(sortTimeBlocks(blocks).map((b) => b.day)).toEqual([...DAYS]);
  });

  it('breaks ties by start, then end, then class name, then id', () => {
    const blocks = [
      block('e', 'TUESDAY', '10:00', '12:00', 'Logic'),
      block('d', 'TUESDAY', '10:00', '12:00', 'Algebra'),
      block('c', 'TUESDAY', '10:00', '11:00', 'Logic'),
      block('b', 'TUESDAY', '08:00', '14:00', 'Logic'),
      block('f', 'TUESDAY', '10:00', '12:00', 'Logic'),
    ];
    expect(ids(sortTimeBlocks(blocks))).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('compares times by value, not as text', () => {
    const blocks = [block('late', 'MONDAY', '10:00', '11:00'), block('early', 'MONDAY', '8:00', '9:00')];
    expect(ids(sortTimeBlocks(blocks))).toEqual(['early', 'late']);
  });

  it('does not mutate its input', () => {
    const blocks = [block('b', 'TUESDAY', '10:00', '11:00'), block('a', 'MONDAY', '10:00', '11:00')];
    const snapshot = [...blocks];
    sortTimeBlocks(blocks);
    expect(blocks).toEqual(snapshot);
  });

  it('sinks unknown days after Sunday and bad times after valid ones', () => {
    const unknownDay = { ...block('x', 'MONDAY', '08:00', '09:00'), day: 'FUNDAY' as Day };
    const badTime = block('y', 'MONDAY', '25:00', '26:00');
    const sunday = block('z', 'SUNDAY', '08:00', '09:00');
    const monday = block('w', 'MONDAY', '12:00', '13:00');

    expect(ids(sortTimeBlocks([unknownDay, badTime, sunday, monday]))).toEqual(['w', 'y', 'z', 'x']);
    expect(compareTimeBlocks(monday, monday)).toBe(0);
  });
});

describe('groupByDay', () => {
  it('returns all seven columns, each in timetable order', () => {
    const blocks = [
      block('b', 'WEDNESDAY', '12:00', '14:00'),
      block('a', 'WEDNESDAY', '08:00', '10:00'),
      block('c', 'FRIDAY', '16:00', '18:00'),
    ];
    const columns = groupByDay(blocks);

    expect(Object.keys(columns)).toEqual([...DAYS]);
    expect(ids(columns.WEDNESDAY)).toEqual(['a', 'b']);
    expect(ids(columns.FRIDAY)).toEqual(['c']);
    expect(columns.MONDAY).toEqual([]);
    expect(columns.SUNDAY).toEqual([]);
  });

  it('leaves out blocks with an unknown day', () => {
    const stray = { ...block('x', 'MONDAY', '08:00', '09:00'), day: 'FUNDAY' as Day };
    const columns = groupByDay([stray]);
    expect(Object.values(columns).flat()).toEqual([]);
  });
});

describe('overlap', () => {
  it.each([
    ['partial overlap', 600, 720, 660, 780, true],
    ['containment', 600, 720, 630, 660, true],
    ['identical ranges', 600, 720, 600, 720, true],
    ['one shared minute', 600, 661, 660, 720, true],
    ['touching ranges', 600, 720, 720, 840, false],
    ['disjoint ranges', 600, 660, 700, 760, false],
    ['an empty range', 650, 650, 600, 720, false],
    ['a reversed range', 700, 620, 600, 720, false],
    ['a NaN bound', NaN, 720, 600, 720, false],
  ])('minute ranges: %s → %p', (_label, aStart, aEnd, bStart, bEnd, expected) => {
    expect(minuteRangesOverlap(aStart, aEnd, bStart, bEnd)).toBe(expected);
    expect(minuteRangesOverlap(bStart, bEnd, aStart, aEnd)).toBe(expected);
  });

  it('treats back-to-back classes as not overlapping', () => {
    const first = block('a', 'MONDAY', '10:00', '12:00');
    const second = block('b', 'MONDAY', '12:00', '14:00');
    expect(timeRangesOverlap(first, second)).toBe(false);
  });

  it('detects an overlap on the same day only', () => {
    const lecture = block('a', 'MONDAY', '8:00', '10:00');
    expect(timeRangesOverlap(lecture, { day: 'MONDAY', startTime: '09:00', endTime: '11:00' })).toBe(
      true
    );
    expect(timeRangesOverlap(lecture, { day: 'TUESDAY', startTime: '09:00', endTime: '11:00' })).toBe(
      false
    );
  });

  it('never matches a malformed range', () => {
    const lecture = block('a', 'MONDAY', '08:00', '20:00');
    expect(timeRangesOverlap(lecture, { day: 'MONDAY', startTime: 'noon', endTime: '13:00' })).toBe(
      false
    );
    const strayDay = { day: 'FUNDAY' as Day, startTime: '08:00', endTime: '20:00' };
    expect(timeRangesOverlap(strayDay, strayDay)).toBe(false);
  });

  it('validates ranges', () => {
    expect(isValidTimeRange({ day: 'MONDAY', startTime: '8:00', endTime: '09:00' })).toBe(true);
    expect(isValidTimeRange({ day: 'MONDAY', startTime: '09:00', endTime: '09:00' })).toBe(false);
    expect(isValidTimeRange({ day: 'MONDAY', startTime: '09:00', endTime: '24:00' })).toBe(false);
    expect(isValidTimeRange({ day: 'monday' as Day, startTime: '08:00', endTime: '09:00' })).toBe(
      false
    );
  });
});

describe('conflicts', () => {
  const timetable = [
    block('algo', 'MONDAY', '10:00', '12:00', 'Algorithms'),
    block('db', 'MONDAY', '11:00', '13:00', 'Databases'),
    block('os', 'MONDAY', '14:00', '16:00', 'Operating Systems'),
    block('logic', 'TUESDAY', '10:00', '12:00', 'Logic'),
  ];

  it('lists the blocks a candidate overlaps, in input order', () => {
    const candidate = { day: 'MONDAY' as Day, startTime: '11:30', endTime: '14:30' };
    expect(ids(findConflicts(candidate, timetable))).toEqual(['algo', 'db', 'os']);
    expect(findConflicts({ day: 'MONDAY', startTime: '12:00', endTime: '13:00' }, [timetable[0]])).toEqual(
      []
    );
  });

  it('ignores the block being edited', () => {
    const edited = { day: 'MONDAY' as Day, startTime: '10:30', endTime: '11:30' };
    expect(ids(findConflicts(edited, timetable, { ignoreId: 'algo' }))).toEqual(['db']);
  });

  it('accepts a valid free slot and refuses an overlapping or malformed one', () => {
    expect(isConflictFree({ day: 'MONDAY', startTime: '13:00', endTime: '14:00' }, timetable)).toBe(
      true
    );
    expect(isConflictFree({ day: 'MONDAY', startTime: '12:30', endTime: '14:00' }, timetable)).toBe(
      false
    );
    expect(isConflictFree({ day: 'MONDAY', startTime: '18:00', endTime: '17:00' }, [])).toBe(false);
  });

  it('lists each overlapping pair once, in timetable order', () => {
    const pairs = findOverlappingPairs([
      ...timetable,
      block('seminar', 'MONDAY', '10:30', '11:30', 'Seminar'),
    ]);
    expect(pairs.map(([a, b]) => [a.id, b.id])).toEqual([
      ['algo', 'seminar'],
      ['algo', 'db'],
      ['seminar', 'db'],
    ]);
    expect(findOverlappingPairs([timetable[2], timetable[3]])).toEqual([]);
  });
});
