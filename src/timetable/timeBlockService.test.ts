import { generateClient } from 'aws-amplify/api';
import { parse, type OperationDefinitionNode } from 'graphql';
import {
  CREATE_TIME_BLOCK_MUTATION,
  DELETE_TIME_BLOCK_MUTATION,
  TIME_BLOCKS_BY_STUDENT_QUERY,
  TIME_BLOCKS_PAGE_SIZE,
  TimeBlockValidationError,
  UPDATE_TIME_BLOCK_MUTATION,
  createTimeBlockService,
  type GraphqlRequest,
  type GraphqlResponse,
} from './timeBlockService';
import { TIME_BLOCK_ERRORS, type TimeBlock, type TimeBlockInput } from './timeBlocks';

// `aws-amplify/api` runs initialization that jsdom/ts-jest cannot execute. The
// service only imports it lazily, but stub it (ts-jest hoists this call above
// the imports) so the default transport can be exercised without a backend.
jest.mock('aws-amplify/api', () => ({ generateClient: jest.fn() }));

/**
 * Task 8.1 — TimeBlock CRUD service (Requirements 11.1, 11.4).
 *
 * The AppSync requests the service sends for list / add / edit / delete and
 * the OCR batch import, with an injected GraphQL transport (or the Amplify
 * module stubbed), so no backend is touched.
 */

const STUDENT = 'student-1';

function stored(id: string, overrides: Partial<TimeBlock> = {}): TimeBlock {
  return {
    id,
    studentId: STUDENT,
    day: 'MONDAY',
    startTime: '10:00',
    endTime: '12:00',
    className: 'Algorithms',
    location: null,
    ...overrides,
  };
}

const VALID: TimeBlockInput = {
  day: 'MONDAY',
  startTime: '10:00',
  endTime: '12:00',
  className: 'Algorithms',
};

type Transport = jest.Mock<Promise<GraphqlResponse>, [GraphqlRequest]>;

function transport(): Transport {
  return jest.fn<Promise<GraphqlResponse>, [GraphqlRequest]>();
}

/** Answers mutations the way AppSync does: the stored record, echoing the input. */
function echoGraphql(): Transport {
  let created = 0;
  return jest.fn<Promise<GraphqlResponse>, [GraphqlRequest]>(async ({ query, variables }) => {
    const input = variables.input as Record<string, unknown>;
    if (query === CREATE_TIME_BLOCK_MUTATION) {
      created += 1;
      return { data: { createTimeBlock: { id: `tb-${created}`, ...input } } };
    }
    if (query === UPDATE_TIME_BLOCK_MUTATION) {
      return { data: { updateTimeBlock: { studentId: STUDENT, ...input } } };
    }
    if (query === DELETE_TIME_BLOCK_MUTATION) {
      return { data: { deleteTimeBlock: { id: input.id } } };
    }
    throw new Error('Unexpected query.');
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to reject.');
    },
    (reason: unknown) => reason
  );
}

describe('GraphQL documents', () => {
  it.each([
    ['TimeBlocksByStudent', TIME_BLOCKS_BY_STUDENT_QUERY],
    ['CreateTimeBlock', CREATE_TIME_BLOCK_MUTATION],
    ['UpdateTimeBlock', UPDATE_TIME_BLOCK_MUTATION],
    ['DeleteTimeBlock', DELETE_TIME_BLOCK_MUTATION],
  ])('%s parses as a single named operation', (name, document) => {
    const { definitions } = parse(document);
    expect(definitions).toHaveLength(1);
    expect((definitions[0] as OperationDefinitionNode).name?.value).toBe(name);
  });
});

describe('listTimeBlocks', () => {
  it('follows nextToken across pages and returns the blocks in timetable order', async () => {
    const tuesday = stored('b', { day: 'TUESDAY', startTime: '08:00', endTime: '10:00' });
    const mondayLate = stored('c', { startTime: '14:00', endTime: '16:00' });
    const mondayEarly = stored('a', { startTime: '08:00', endTime: '10:00' });
    const graphql = transport()
      .mockResolvedValueOnce({
        data: { timeBlocksByStudent: { items: [tuesday, null, mondayLate], nextToken: 'page-2' } },
      })
      .mockResolvedValueOnce({
        data: { timeBlocksByStudent: { items: [mondayEarly], nextToken: null } },
      });

    const blocks = await createTimeBlockService({ graphql }).listTimeBlocks(STUDENT);

    expect(blocks).toEqual([mondayEarly, mondayLate, tuesday]);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(1, {
      query: TIME_BLOCKS_BY_STUDENT_QUERY,
      variables: { studentId: STUDENT, limit: TIME_BLOCKS_PAGE_SIZE, nextToken: null },
    });
    expect(graphql).toHaveBeenNthCalledWith(2, {
      query: TIME_BLOCKS_BY_STUDENT_QUERY,
      variables: { studentId: STUDENT, limit: TIME_BLOCKS_PAGE_SIZE, nextToken: 'page-2' },
    });
  });

  it('returns an empty timetable for a student without blocks', async () => {
    const graphql = transport().mockResolvedValue({
      data: { timeBlocksByStudent: { items: [], nextToken: null } },
    });

    await expect(createTimeBlockService({ graphql }).listTimeBlocks(STUDENT)).resolves.toEqual([]);
  });

  it('rejects when the query returns no result', async () => {
    const graphql = transport().mockResolvedValue({ data: { timeBlocksByStudent: null } });

    await expect(createTimeBlockService({ graphql }).listTimeBlocks(STUDENT)).rejects.toThrow(
      'timeBlocksByStudent returned no result.'
    );
  });

  it('rejects a blank student id without calling the API', async () => {
    const graphql = transport();

    await expect(createTimeBlockService({ graphql }).listTimeBlocks(' ')).rejects.toThrow(
      'A student id is required.'
    );
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('addTimeBlock', () => {
  it('creates the normalized block for the student', async () => {
    const graphql = echoGraphql();

    const created = await createTimeBlockService({ graphql }).addTimeBlock(STUDENT, {
      day: 'Monday',
      startTime: '8:00',
      endTime: '9:30',
      className: '  Algorithms  ',
      location: ' ',
    });

    const expected = {
      studentId: STUDENT,
      day: 'MONDAY',
      startTime: '08:00',
      endTime: '09:30',
      className: 'Algorithms',
      location: null,
    };
    expect(graphql).toHaveBeenCalledWith({
      query: CREATE_TIME_BLOCK_MUTATION,
      variables: { input: expected },
    });
    expect(created).toEqual({ id: 'tb-1', ...expected });
  });

  it('rejects invalid input with its field errors and sends nothing', async () => {
    const graphql = echoGraphql();

    const error = await rejection(
      createTimeBlockService({ graphql }).addTimeBlock(STUDENT, {
        ...VALID,
        startTime: '12:00',
        endTime: '10:00',
        className: '',
      })
    );

    expect(error).toBeInstanceOf(TimeBlockValidationError);
    const { errors, issues, message } = error as TimeBlockValidationError;
    expect(errors).toEqual({
      endTime: TIME_BLOCK_ERRORS.endNotAfterStart,
      className: TIME_BLOCK_ERRORS.classNameRequired,
    });
    expect(issues).toEqual([{ index: 0, errors }]);
    expect(message).toBe('End time must be after start time. Class name is required.');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('rejects when createTimeBlock returns no record', async () => {
    const graphql = transport().mockResolvedValue({ data: { createTimeBlock: null } });

    await expect(createTimeBlockService({ graphql }).addTimeBlock(STUDENT, VALID)).rejects.toThrow(
      'createTimeBlock returned no record.'
    );
  });
});

describe('editTimeBlock', () => {
  it('replaces the editable fields only, clearing a blank location', async () => {
    const graphql = echoGraphql();
    const current = stored('tb-7', { location: 'Room 214' });

    const updated = await createTimeBlockService({ graphql }).editTimeBlock('tb-7', {
      ...current,
      startTime: '9:00',
      location: '',
    });

    const fields = {
      day: 'MONDAY',
      startTime: '09:00',
      endTime: '12:00',
      className: 'Algorithms',
      location: null,
    };
    // The stored block's id / studentId are not forwarded as editable fields.
    expect(graphql).toHaveBeenCalledWith({
      query: UPDATE_TIME_BLOCK_MUTATION,
      variables: { input: { id: 'tb-7', ...fields } },
    });
    expect(updated).toEqual({ id: 'tb-7', studentId: STUDENT, ...fields });
  });

  it('rejects an invalid edit without calling the API', async () => {
    const graphql = echoGraphql();

    const error = await rejection(
      createTimeBlockService({ graphql }).editTimeBlock('tb-7', { ...VALID, day: 'Someday' })
    );

    expect(error).toBeInstanceOf(TimeBlockValidationError);
    expect((error as TimeBlockValidationError).errors).toEqual({ day: TIME_BLOCK_ERRORS.dayInvalid });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('rejects a blank id without calling the API', async () => {
    const graphql = echoGraphql();

    await expect(createTimeBlockService({ graphql }).editTimeBlock('', VALID)).rejects.toThrow(
      'A time block id is required.'
    );
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('deleteTimeBlock', () => {
  it('deletes the block by id', async () => {
    const graphql = echoGraphql();

    await expect(
      createTimeBlockService({ graphql }).deleteTimeBlock('tb-7')
    ).resolves.toBeUndefined();
    expect(graphql).toHaveBeenCalledWith({
      query: DELETE_TIME_BLOCK_MUTATION,
      variables: { input: { id: 'tb-7' } },
    });
  });

  it('rejects when deleteTimeBlock returns no record', async () => {
    const graphql = transport().mockResolvedValue({ data: { deleteTimeBlock: null } });

    await expect(createTimeBlockService({ graphql }).deleteTimeBlock('tb-7')).rejects.toThrow(
      'deleteTimeBlock returned no record.'
    );
  });
});

describe('addTimeBlocks', () => {
  it('rejects the whole batch, listing every invalid entry, before writing anything', async () => {
    const graphql = echoGraphql();

    const error = await rejection(
      createTimeBlockService({ graphql }).addTimeBlocks(STUDENT, [
        VALID,
        { ...VALID, className: ' ' },
        VALID,
        { ...VALID, endTime: '09:00' },
      ])
    );

    expect(error).toBeInstanceOf(TimeBlockValidationError);
    expect((error as TimeBlockValidationError).issues).toEqual([
      { index: 1, errors: { className: TIME_BLOCK_ERRORS.classNameRequired } },
      { index: 3, errors: { endTime: TIME_BLOCK_ERRORS.endNotAfterStart } },
    ]);
    expect((error as Error).message).toBe(
      'Time block 2: Class name is required. Time block 4: End time must be after start time.'
    );
    expect(graphql).not.toHaveBeenCalled();
  });

  it('creates every block, in input order', async () => {
    const graphql = echoGraphql();

    const result = await createTimeBlockService({ graphql }).addTimeBlocks(STUDENT, [
      { day: 'tuesday', startTime: '8:00', endTime: '10:00', className: 'Logic' },
      { day: 'MONDAY', startTime: '12:00', endTime: '14:00', className: 'Databases', location: 'Room 5' },
    ]);

    expect(graphql.mock.calls.map(([request]) => request.variables.input)).toEqual([
      {
        studentId: STUDENT,
        day: 'TUESDAY',
        startTime: '08:00',
        endTime: '10:00',
        className: 'Logic',
        location: null,
      },
      {
        studentId: STUDENT,
        day: 'MONDAY',
        startTime: '12:00',
        endTime: '14:00',
        className: 'Databases',
        location: 'Room 5',
      },
    ]);
    expect(result.created.map((b) => [b.id, b.className])).toEqual([
      ['tb-1', 'Logic'],
      ['tb-2', 'Databases'],
    ]);
    expect(result.failed).toEqual([]);
  });

  it('keeps going past failed creates and returns them for a retry', async () => {
    const echo = echoGraphql();
    const throttled = new Error('Throttled');
    const graphql = transport()
      .mockImplementationOnce(echo)
      // Amplify rejects with the GraphQL response rather than an Error.
      .mockRejectedValueOnce({ data: null, errors: [{ message: 'Network error' }] })
      .mockImplementationOnce(echo)
      .mockRejectedValueOnce(throttled);

    const result = await createTimeBlockService({ graphql }).addTimeBlocks(STUDENT, [
      { ...VALID, className: 'Algorithms' },
      { ...VALID, className: 'Databases' },
      { ...VALID, className: 'Logic' },
      { ...VALID, className: 'Networks' },
    ]);

    expect(graphql).toHaveBeenCalledTimes(4);
    expect(result.created.map((b) => b.className)).toEqual(['Algorithms', 'Logic']);
    expect(result.failed.map(({ index, fields }) => [index, fields.className])).toEqual([
      [1, 'Databases'],
      [3, 'Networks'],
    ]);
    expect(result.failed[0].error).toEqual(new Error('Network error'));
    expect(result.failed[1].error).toBe(throttled);
  });

  it('does nothing for an empty batch', async () => {
    const graphql = echoGraphql();

    await expect(createTimeBlockService({ graphql }).addTimeBlocks(STUDENT, [])).resolves.toEqual({
      created: [],
      failed: [],
    });
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('default transport', () => {
  it('uses the Amplify GraphQL client, loaded on first use', async () => {
    const graphql = jest.fn().mockResolvedValue({ data: { deleteTimeBlock: { id: 'tb-1' } } });
    (generateClient as jest.Mock).mockReturnValue({ graphql });

    const service = createTimeBlockService();
    expect(generateClient).not.toHaveBeenCalled();

    await service.deleteTimeBlock('tb-1');

    expect(generateClient).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith({
      query: DELETE_TIME_BLOCK_MUTATION,
      variables: { input: { id: 'tb-1' } },
    });
  });
});
