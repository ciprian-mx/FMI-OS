import { FakeRetrievalPort, RecordingRetrievalLogger, materialChunk } from './__tests__/fakes';
import { RetrievalRequestError } from './errors';
import type { KnowledgeBaseResult } from './ports';
import { isResultOwnedBy, retrieveForStudent, type StudentRetrievalRequest } from './retrieveForStudent';

/**
 * Task 4.9 — student-scoped Knowledge Base retrieval: the enforced isolation
 * filter, request validation and the defensive post-filter.
 *
 * Validates: Requirements 1.5, 7.9, 14.4
 */

const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const OTHER = '9e8d7c6b-1111-4222-8333-444455556666';
const ISOLATION = { equals: { key: 'studentId', value: STUDENT } };

async function reasonOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return error instanceof RetrievalRequestError ? error.reason : `unexpected: ${String(error)}`;
  }
  return undefined;
}

describe('retrieveForStudent — request', () => {
  it('sends the query with the isolation filter and the requested options', async () => {
    const port = new FakeRetrievalPort();

    await retrieveForStudent(port, {
      studentId: STUDENT,
      query: 'quick sort complexity',
      numberOfResults: 20,
      searchType: 'HYBRID',
      nextToken: 'page-2',
    });

    expect(port.requests).toEqual([
      {
        studentId: STUDENT,
        queryText: 'quick sort complexity',
        filter: ISOLATION,
        numberOfResults: 20,
        searchType: 'HYBRID',
        nextToken: 'page-2',
      },
    ]);
  });

  it('ANDs a caller filter with the isolation clause', async () => {
    const port = new FakeRetrievalPort();
    const folderFilter = { startsWith: { key: 'folderPath', value: 'Data Structures/' } };

    await retrieveForStudent(port, { studentId: STUDENT, query: 'heaps', filter: folderFilter });

    expect(port.requests[0].filter).toEqual({ andAll: [ISOLATION, folderFilter] });
  });

  it('ignores unknown request fields, so nothing can override the scope', async () => {
    const port = new FakeRetrievalPort();
    const sneaky = {
      studentId: STUDENT,
      query: 'heaps',
      filter: undefined,
      retrievalConfiguration: { vectorSearchConfiguration: { filter: { equals: { key: 'studentId', value: OTHER } } } },
      skipIsolation: true,
    } as unknown as StudentRetrievalRequest;

    await retrieveForStudent(port, sneaky);

    expect(port.requests).toEqual([{ studentId: STUDENT, queryText: 'heaps', filter: ISOLATION }]);
  });

  it.each([[''], ['   '], [undefined], [null], [7]])(
    'rejects the student id %p without querying',
    async (studentId) => {
      const port = new FakeRetrievalPort([materialChunk({ studentId: STUDENT })]);

      await expect(
        reasonOf(() =>
          retrieveForStudent(port, { studentId: studentId as string, query: 'heaps' })
        )
      ).resolves.toBe('invalid-student-id');
      expect(port.requests).toEqual([]);
    }
  );

  it.each([
    ['numberOfResults 0', { numberOfResults: 0 }],
    ['numberOfResults 101', { numberOfResults: 101 }],
    ['a fractional numberOfResults', { numberOfResults: 2.5 }],
    ['an unknown search type', { searchType: 'KEYWORD' }],
    ['an empty page token', { nextToken: '' }],
    ['a non-string query', { query: 42 }],
  ])('rejects %s without querying', async (_label, override) => {
    const port = new FakeRetrievalPort();
    const request = { studentId: STUDENT, query: 'heaps', ...override } as unknown as StudentRetrievalRequest;

    await expect(reasonOf(() => retrieveForStudent(port, request))).resolves.toBe('invalid-request');
    expect(port.requests).toEqual([]);
  });

  it('rejects a malformed caller filter without querying', async () => {
    const port = new FakeRetrievalPort();
    const request = {
      studentId: STUDENT,
      query: 'heaps',
      filter: { andAll: [ISOLATION] },
    } as unknown as StudentRetrievalRequest;

    await expect(reasonOf(() => retrieveForStudent(port, request))).resolves.toBe('invalid-filter');
    expect(port.requests).toEqual([]);
  });

  it('propagates Knowledge Base errors', async () => {
    const port = new FakeRetrievalPort();
    port.error = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

    await expect(retrieveForStudent(port, { studentId: STUDENT, query: 'heaps' })).rejects.toThrow(
      'Rate exceeded'
    );
  });
});

describe('retrieveForStudent — post-filter', () => {
  const own = materialChunk({ studentId: STUDENT, folderSegments: ['Data Structures'], fileName: 'Heaps.pdf' });
  const ownSecond = materialChunk({ studentId: STUDENT, fileName: 'Syllabus.pdf' });
  const foreign = materialChunk({ studentId: OTHER, fileName: 'Their notes.pdf' });
  const untagged = materialChunk({ studentId: null, fileName: 'Untagged.pdf' });
  const nonString: KnowledgeBaseResult = {
    ...own,
    metadata: { ...own.metadata, studentId: [STUDENT] },
  };
  const nearMiss: KnowledgeBaseResult = {
    ...own,
    metadata: { ...own.metadata, studentId: ` ${STUDENT}` },
  };

  it('returns the student’s chunks in order with the page token', async () => {
    const port = new FakeRetrievalPort([own, ownSecond], 'next-page');

    const retrieval = await retrieveForStudent(port, { studentId: STUDENT, query: 'heaps' });

    expect(retrieval).toEqual({
      studentId: STUDENT,
      results: [own, ownSecond],
      nextToken: 'next-page',
      droppedCount: 0,
    });
  });

  it('drops chunks of other students, untagged chunks and non-matching tags, and logs only counts', async () => {
    const port = new FakeRetrievalPort([foreign, own, untagged, nonString, ownSecond, nearMiss]);
    const logger = new RecordingRetrievalLogger();

    const retrieval = await retrieveForStudent(port, { studentId: STUDENT, query: 'notes' }, { logger });

    expect(retrieval.results).toEqual([own, ownSecond]);
    expect(retrieval.droppedCount).toBe(4);
    expect(logger.warnings).toEqual([
      {
        message: 'Dropped Knowledge Base results outside the student scope',
        fields: { studentId: STUDENT, droppedCount: 4, returnedCount: 6 },
      },
    ]);
    expect(JSON.stringify(logger.warnings)).not.toContain(OTHER);
  });

  it('does not warn when nothing was dropped', async () => {
    const logger = new RecordingRetrievalLogger();

    await retrieveForStudent(new FakeRetrievalPort([own]), { studentId: STUDENT, query: 'x' }, { logger });

    expect(logger.warnings).toEqual([]);
  });

  it('isResultOwnedBy never matches a blank id', () => {
    const blankTagged: KnowledgeBaseResult = { ...own, metadata: { studentId: '' } };
    expect(isResultOwnedBy(blankTagged, '')).toBe(false);
    expect(isResultOwnedBy(own, STUDENT)).toBe(true);
    expect(isResultOwnedBy(own, OTHER)).toBe(false);
  });
});
