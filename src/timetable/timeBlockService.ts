/**
 * Timetable persistence: CRUD over the `TimeBlock` model
 * (Task 8.1, Requirements 11.1 / 11.4).
 *
 * The {@link TimeBlockService} seam wraps the AppSync operations generated for
 * `TimeBlock` in `amplify/backend/api/fmios/schema.graphql`:
 *
 *   • {@link TimeBlockService.listTimeBlocks}  — every block of a student, across
 *     all pages of `timeBlocksByStudent`, in timetable order;
 *   • {@link TimeBlockService.addTimeBlock}    — `createTimeBlock`;
 *   • {@link TimeBlockService.editTimeBlock}   — `updateTimeBlock`;
 *   • {@link TimeBlockService.deleteTimeBlock} — `deleteTimeBlock`;
 *   • {@link TimeBlockService.addTimeBlocks}   — batch create, for the OCR
 *     import (task 8.2) that saves a whole extracted timetable at once.
 *
 * Every write is validated and normalized with `validateTimeBlockInput`
 * (`./timeBlocks`) first, and invalid input is rejected with a
 * {@link TimeBlockValidationError} before any request is sent. The validation
 * stays pure and shared with the OCR Lambda and the grid UI.
 *
 * Schema. No change was needed. `TimeBlock` keeps its owner `@auth` rule and
 * its `byStudent` index without a sort key. A `day` sort key would order blocks
 * by enum name (FRIDAY, MONDAY, SATURDAY, …) rather than by weekday, and a
 * student has a few dozen blocks at most, so
 * {@link TimeBlockService.listTimeBlocks} fetches every page and sorts on the
 * client with `sortTimeBlocks`.
 *
 * Isolation. Pass the signed-in student's Cognito `sub` as `studentId`, as for
 * every model. The owner rule stamps `owner` from the caller's token and
 * filters every read and write by it, so no `studentId` argument can reach
 * another student's timetable (Requirement 1.5).
 *
 * Like `src/account/accountService.ts`, the default transport loads
 * `aws-amplify/api` lazily inside the request path, never at module load, so
 * importing this module is side-effect free under jsdom/ts-jest. Tests inject a
 * fake transport through {@link TimeBlockServiceDeps}.
 */
import {
  sortTimeBlocks,
  validateTimeBlockInput,
  type TimeBlock,
  type TimeBlockErrors,
  type TimeBlockFields,
  type TimeBlockInput,
} from './timeBlocks';

/* -------------------------------------------------------------------------- *
 * GraphQL documents
 *
 * Kept inline, like `UPDATE_STUDENT_MUTATION`, because no generated
 * `src/graphql` documents exist yet. Each requests the fields of `TimeBlock`.
 * -------------------------------------------------------------------------- */

const TIME_BLOCK_SELECTION = `
      id
      studentId
      day
      startTime
      endTime
      className
      location`;

/** Lists one page of a student's blocks through the `byStudent` index. */
export const TIME_BLOCKS_BY_STUDENT_QUERY = /* GraphQL */ `
  query TimeBlocksByStudent($studentId: ID!, $limit: Int, $nextToken: String) {
    timeBlocksByStudent(studentId: $studentId, limit: $limit, nextToken: $nextToken) {
      items {${TIME_BLOCK_SELECTION}
      }
      nextToken
    }
  }
`;

export const CREATE_TIME_BLOCK_MUTATION = /* GraphQL */ `
  mutation CreateTimeBlock($input: CreateTimeBlockInput!) {
    createTimeBlock(input: $input) {${TIME_BLOCK_SELECTION}
    }
  }
`;

export const UPDATE_TIME_BLOCK_MUTATION = /* GraphQL */ `
  mutation UpdateTimeBlock($input: UpdateTimeBlockInput!) {
    updateTimeBlock(input: $input) {${TIME_BLOCK_SELECTION}
    }
  }
`;

export const DELETE_TIME_BLOCK_MUTATION = /* GraphQL */ `
  mutation DeleteTimeBlock($input: DeleteTimeBlockInput!) {
    deleteTimeBlock(input: $input) {
      id
    }
  }
`;

/** Page size requested from `timeBlocksByStudent` (the AppSync default). */
export const TIME_BLOCKS_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- *
 * Errors and results
 * -------------------------------------------------------------------------- */

/** The field errors of one invalid input. `index` is its position in the request (0 for single writes). */
export interface TimeBlockValidationIssue {
  index: number;
  errors: TimeBlockErrors;
}

/** The messages of one input's field errors, in field order. */
function fieldMessages(errors: TimeBlockErrors): string {
  return Object.values(errors).join(' ');
}

/**
 * Rejected input: nothing was sent to the API. `issues` lists every invalid
 * input with its field errors, ready to render next to the matching form fields
 * or OCR rows.
 */
export class TimeBlockValidationError extends Error {
  readonly issues: readonly TimeBlockValidationIssue[];

  constructor(issues: readonly TimeBlockValidationIssue[], message?: string) {
    super(
      message ??
        issues
          .map(({ index, errors }) => `Time block ${index + 1}: ${fieldMessages(errors)}`)
          .join(' ')
    );
    this.name = 'TimeBlockValidationError';
    this.issues = issues;
  }

  /** The field errors of the first invalid input; the whole story for a single add or edit. */
  get errors(): TimeBlockErrors {
    return this.issues[0]?.errors ?? {};
  }
}

/** A batch entry that passed validation but whose create request failed. */
export interface TimeBlockBatchFailure {
  /** Position of the entry in the batch. */
  index: number;
  /** The normalized fields that were not saved, ready for a retry. */
  fields: TimeBlockFields;
  error: Error;
}

/** Outcome of {@link TimeBlockService.addTimeBlocks}. */
export interface TimeBlockBatchResult {
  /** The blocks that were created, in input order. */
  created: TimeBlock[];
  /** The entries whose create failed, in input order. Empty when all were saved. */
  failed: TimeBlockBatchFailure[];
}

/* -------------------------------------------------------------------------- *
 * Service seam
 * -------------------------------------------------------------------------- */

/**
 * Timetable CRUD. Methods reject with {@link TimeBlockValidationError} on
 * invalid input (before any request) and pass transport failures through, so
 * the UI can offer a retry.
 */
export interface TimeBlockService {
  /** Every block of the student, across all result pages, sorted Monday → Sunday and by time. */
  listTimeBlocks(studentId: string): Promise<TimeBlock[]>;
  /** Validates `input` and creates a block for the student. Resolves with the stored block. */
  addTimeBlock(studentId: string, input: TimeBlockInput): Promise<TimeBlock>;
  /**
   * Validates `input` and replaces all editable fields of block `id`. A blank
   * `location` clears it. Resolves with the stored block.
   */
  editTimeBlock(id: string, input: TimeBlockInput): Promise<TimeBlock>;
  /** Deletes block `id`. */
  deleteTimeBlock(id: string): Promise<void>;
  /**
   * Batch create. Validates every input first and rejects the whole batch with
   * a {@link TimeBlockValidationError} listing each invalid entry, with nothing
   * written. Otherwise creates the blocks one at a time, in input order, and
   * keeps going past a failed request, so a flaky connection saves as much of
   * the timetable as possible. The failed entries come back for a retry.
   */
  addTimeBlocks(
    studentId: string,
    inputs: readonly TimeBlockInput[]
  ): Promise<TimeBlockBatchResult>;
}

/** A GraphQL request as sent through the {@link GraphqlRequester} seam. */
export interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** The slice of a GraphQL response this module reads. */
export interface GraphqlResponse {
  data?: Record<string, unknown> | null;
}

/** Sends one GraphQL operation. Defaults to a lazily created Amplify client. */
export type GraphqlRequester = (request: GraphqlRequest) => Promise<GraphqlResponse>;

/** Injectable dependencies for {@link createTimeBlockService}. */
export interface TimeBlockServiceDeps {
  /** GraphQL transport. Defaults to Amplify's `generateClient().graphql`. */
  graphql?: GraphqlRequester;
}

interface GraphqlClientLike {
  graphql(request: GraphqlRequest): Promise<GraphqlResponse>;
}

/** Production transport; binds to Amplify only when a request is made. */
const amplifyGraphql: GraphqlRequester = async (request) => {
  const { generateClient } = await import('aws-amplify/api');
  const client = generateClient() as unknown as GraphqlClientLike;
  return client.graphql(request);
};

/** The page shape of `timeBlocksByStudent` (a `ModelTimeBlockConnection`). */
interface TimeBlockConnection {
  items?: Array<TimeBlock | null> | null;
  nextToken?: string | null;
}

function requireId(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`A ${label} is required.`);
  }
}

/** The record a mutation returned under `field`; rejects when there is none. */
function expectRecord(response: GraphqlResponse, field: string): TimeBlock {
  const record = response.data?.[field] as TimeBlock | null | undefined;
  if (!record) {
    throw new Error(`${field} returned no record.`);
  }
  return record;
}

/** Validated fields for a single write, or a {@link TimeBlockValidationError}. */
function validateOrThrow(input: TimeBlockInput): TimeBlockFields {
  const result = validateTimeBlockInput(input);
  if (!result.ok) {
    throw new TimeBlockValidationError(
      [{ index: 0, errors: result.errors }],
      fieldMessages(result.errors)
    );
  }
  return result.value;
}

/**
 * An `Error` for any rejection value. Amplify's GraphQL client rejects with the
 * response object (`{ errors: [{ message }] }`) rather than an `Error`, so its
 * messages are carried over.
 */
function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const errors = (reason as { errors?: unknown } | null | undefined)?.errors;
  const messages = Array.isArray(errors)
    ? errors
        .map((entry) => (entry as { message?: unknown } | null)?.message)
        .filter((message): message is string => typeof message === 'string' && message.length > 0)
    : [];
  if (messages.length > 0) {
    return new Error(messages.join(' '));
  }
  return new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'The time block could not be saved.'
  );
}

/**
 * Builds a {@link TimeBlockService}. With no arguments it is the production
 * implementation (Amplify GraphQL); tests inject `deps`.
 */
export function createTimeBlockService(deps: TimeBlockServiceDeps = {}): TimeBlockService {
  const graphql = deps.graphql ?? amplifyGraphql;

  const create = async (studentId: string, fields: TimeBlockFields): Promise<TimeBlock> => {
    const response = await graphql({
      query: CREATE_TIME_BLOCK_MUTATION,
      variables: { input: { studentId, ...fields } },
    });
    return expectRecord(response, 'createTimeBlock');
  };

  return {
    async listTimeBlocks(studentId) {
      requireId(studentId, 'student id');
      const blocks: TimeBlock[] = [];
      let nextToken: string | null = null;
      do {
        const response = await graphql({
          query: TIME_BLOCKS_BY_STUDENT_QUERY,
          variables: { studentId, limit: TIME_BLOCKS_PAGE_SIZE, nextToken },
        });
        const page = response.data?.timeBlocksByStudent as TimeBlockConnection | null | undefined;
        if (!page) {
          throw new Error('timeBlocksByStudent returned no result.');
        }
        for (const item of page.items ?? []) {
          if (item) {
            blocks.push(item);
          }
        }
        nextToken = page.nextToken ?? null;
      } while (nextToken);
      return sortTimeBlocks(blocks);
    },

    async addTimeBlock(studentId, input) {
      requireId(studentId, 'student id');
      return create(studentId, validateOrThrow(input));
    },

    async editTimeBlock(id, input) {
      requireId(id, 'time block id');
      const fields = validateOrThrow(input);
      const response = await graphql({
        query: UPDATE_TIME_BLOCK_MUTATION,
        variables: { input: { id, ...fields } },
      });
      return expectRecord(response, 'updateTimeBlock');
    },

    async deleteTimeBlock(id) {
      requireId(id, 'time block id');
      const response = await graphql({
        query: DELETE_TIME_BLOCK_MUTATION,
        variables: { input: { id } },
      });
      if (!response.data?.deleteTimeBlock) {
        throw new Error('deleteTimeBlock returned no record.');
      }
    },

    async addTimeBlocks(studentId, inputs) {
      requireId(studentId, 'student id');

      const valid: TimeBlockFields[] = [];
      const issues: TimeBlockValidationIssue[] = [];
      inputs.forEach((input, index) => {
        const result = validateTimeBlockInput(input);
        if (result.ok) {
          valid.push(result.value);
        } else {
          issues.push({ index, errors: result.errors });
        }
      });
      if (issues.length > 0) {
        throw new TimeBlockValidationError(issues);
      }

      const created: TimeBlock[] = [];
      const failed: TimeBlockBatchFailure[] = [];
      for (let index = 0; index < valid.length; index += 1) {
        try {
          created.push(await create(studentId, valid[index]));
        } catch (reason) {
          failed.push({ index, fields: valid[index], error: toError(reason) });
        }
      }
      return { created, failed };
    },
  };
}
