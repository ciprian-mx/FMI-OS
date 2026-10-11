import fc from 'fast-check';
import {
  TEST_KNOWLEDGE_BASE_ID,
  materialChunk,
  rawRetrievalResult,
  recordingRuntimeSdk,
} from './__tests__/fakes';
import { createBedrockKnowledgeBaseRetriever } from './bedrockRetriever';
import { toCitation } from './citations';
import type { KnowledgeBaseResult } from './ports';
import { isStudentScopedFilter, type RetrievalFilter } from './retrievalFilter';
import { retrieveForStudent } from './retrieveForStudent';

/**
 * Task 4.9 — property tests for the shared Knowledge Base retrieval module.
 *
 * Feature: fmi-os, Property 2: Student Data Isolation (Knowledge Base layer).
 * For any student id and any caller filter, the request sent to Bedrock carries
 * `{ equals: { key: "studentId", value: studentId } }` as the filter or as the
 * first member of a top-level `andAll`; blank ids never reach Bedrock; and
 * whatever Bedrock returns, no chunk tagged with another (or no) student id is
 * handed back.
 *
 * Citation formatting: for any folder depth and any folder / file names
 * (Unicode, spaces, punctuation), the citation shows the full path
 * "A > B > file", whether the path comes from the sidecar metadata or from the
 * S3 URI fallback. (Property 9 itself is task 4.10.)
 *
 * **Validates: Requirements 1.5, 7.9, 14.4**
 */

const studentIdArb = fc.oneof(
  fc.uuid(),
  fc
    .stringOf(fc.oneof(fc.char(), fc.constantFrom('ă', 'ș', '中', '😀', ' ')), {
      minLength: 1,
      maxLength: 40,
    })
    .filter((id) => id.trim() !== '')
);

const blankIdArb = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\u00a0', '\u2003'), {
  maxLength: 6,
});

const ATTRIBUTE_OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEquals',
  'lessThan',
  'lessThanOrEquals',
  'in',
  'notIn',
  'startsWith',
  'listContains',
  'stringContains',
] as const;

const filterKeyArb = fc.oneof(
  fc.constantFrom('studentId', 'folderPath', 'fileName', 'x-amz-bedrock-kb-source-uri'),
  fc.string({ minLength: 1, maxLength: 12 })
);

const filterValueArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.uuid(),
  fc.integer(),
  fc.boolean(),
  fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), { maxLength: 4 })
);

const leafFilterArb: fc.Arbitrary<RetrievalFilter> = fc
  .record({ operator: fc.constantFrom(...ATTRIBUTE_OPERATORS), key: filterKeyArb, value: filterValueArb })
  .map(({ operator, key, value }) => ({ [operator]: { key, value } }) as unknown as RetrievalFilter);

/** Arbitrary filter trees, including clauses that name other students. */
const { filter: callerFilterArb } = fc.letrec<{ filter: RetrievalFilter; group: RetrievalFilter }>(
  (tie) => ({
    filter: fc.oneof({ maxDepth: 3 }, leafFilterArb, tie('group')),
    group: fc
      .record({
        operator: fc.constantFrom('andAll', 'orAll'),
        members: fc.array(tie('filter'), { minLength: 2, maxLength: 3 }),
      })
      .map(({ operator, members }) => ({ [operator]: members }) as unknown as RetrievalFilter),
  })
);

const optionalCallerFilterArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  callerFilterArb
);

function bedrockKnowledgeBase(respond?: Parameters<typeof recordingRuntimeSdk>[0]) {
  const { client, sdk } = recordingRuntimeSdk(respond);
  return {
    client,
    knowledgeBase: createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID }),
  };
}

describe('Feature: fmi-os, Property 2: Student Data Isolation (Knowledge Base retrieval)', () => {
  it('sends the studentId equality filter on every query, ANDed with any caller filter', async () => {
    await fc.assert(
      fc.asyncProperty(
        studentIdArb,
        optionalCallerFilterArb,
        fc.string({ maxLength: 40 }),
        async (studentId, callerFilter, query) => {
          const { client, knowledgeBase } = bedrockKnowledgeBase();

          await retrieveForStudent(knowledgeBase, { studentId, query, filter: callerFilter });

          expect(client.sent).toHaveLength(1);
          const sent = client.sent[0].input.retrievalConfiguration.vectorSearchConfiguration.filter;
          const isolation = { equals: { key: 'studentId', value: studentId } };
          expect(sent).toEqual(
            callerFilter === undefined || callerFilter === null
              ? isolation
              : { andAll: [isolation, callerFilter] }
          );
          expect(isStudentScopedFilter(sent, studentId)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('never queries Bedrock for a blank student id', async () => {
    await fc.assert(
      fc.asyncProperty(blankIdArb, optionalCallerFilterArb, async (studentId, callerFilter) => {
        const { client, knowledgeBase } = bedrockKnowledgeBase();

        await expect(
          retrieveForStudent(knowledgeBase, { studentId, query: 'heaps', filter: callerFilter })
        ).rejects.toMatchObject({ name: 'RetrievalRequestError', reason: 'invalid-student-id' });
        expect(client.sent).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('never returns a chunk tagged with another student, whatever Bedrock returns', async () => {
    const scenarioArb = studentIdArb.chain((studentId) => {
      const foreignTagArb = fc.oneof(
        fc.uuid(),
        fc.string({ maxLength: 10 }),
        fc.constantFrom(
          studentId.toUpperCase(),
          studentId.toLowerCase(),
          ` ${studentId}`,
          `${studentId} `,
          `${studentId}\n`
        ),
        fc.constantFrom<unknown>(undefined, null, 0, true, [studentId], { value: studentId })
      );
      return fc.record({
        studentId: fc.constant(studentId),
        tags: fc.array(
          fc.oneof(
            { weight: 1, arbitrary: fc.constant<unknown>(studentId) },
            { weight: 2, arbitrary: foreignTagArb }
          ),
          { maxLength: 12 }
        ),
      });
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ studentId, tags }) => {
        const returned: KnowledgeBaseResult[] = tags.map((tag, index) => ({
          text: `chunk ${index}`,
          s3Uri: null,
          score: index,
          metadata: tag === undefined ? { fileName: `${index}.pdf` } : { studentId: tag, fileName: `${index}.pdf` },
        }));
        // Bedrock (mis-configured) ignores the filter and returns everything.
        const { knowledgeBase } = bedrockKnowledgeBase(() => ({
          retrievalResults: returned.map(rawRetrievalResult),
        }));

        const retrieval = await retrieveForStudent(knowledgeBase, { studentId, query: 'notes' });

        const own = returned.filter((result) => result.metadata.studentId === studentId);
        expect(retrieval.results.every((result) => result.metadata.studentId === studentId)).toBe(true);
        expect(retrieval.results).toEqual(own);
        expect(retrieval.droppedCount).toBe(returned.length - own.length);
      }),
      { numRuns: 200 }
    );
  });
});

const SPECIAL_CHARACTERS = [
  ' ', '>', '<', '%', '+', ':', '#', '?', '&', '=', '"', "'", '\\', '.', ',', ';', '!', '(',
  ')', '[', ']', '{', '}', '~', '`', '|', '*', '^', '$', '@', '\t', '\u00a0',
];
const UNICODE_CHARACTERS = ['ă', 'â', 'î', 'ș', 'ț', 'é', 'ß', 'Ω', 'Ж', '中', '文', 'ع', '😀', '🧮'];

/** A folder or file name: non-empty, never containing the "/" separator. */
const nameArb = fc.stringOf(
  fc
    .oneof(fc.constantFrom(...SPECIAL_CHARACTERS, ...UNICODE_CHARACTERS), fc.char(), fc.fullUnicode())
    .filter((character) => character !== '/'),
  { minLength: 1, maxLength: 16 }
);

const documentArb = fc.record({
  studentId: fc.uuid(),
  layout: fc.constantFrom('private' as const, 'students' as const),
  folderSegments: fc.array(nameArb, { maxLength: 8 }),
  fileName: nameArb,
});

describe('Task 4.9: citation paths for arbitrary folder hierarchies', () => {
  it('cites "Folder > ... > file" from the metadata and from the S3 URI fallback alike', () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const tagged = materialChunk(document);
        const untagged = materialChunk({ ...document, withoutSidecar: true });
        const sourceUriOnly: KnowledgeBaseResult = { ...untagged, s3Uri: null };

        for (const result of [tagged, untagged, sourceUriOnly]) {
          const citation = toCitation(result);
          expect(citation).not.toBeNull();
          expect(citation?.displayPath).toBe([...document.folderSegments, document.fileName].join(' > '));
          expect(citation?.folderPath).toBe(document.folderSegments.join(' > '));
          expect(citation?.folderSegments).toEqual(document.folderSegments);
          expect(citation?.sourceDocumentName).toBe(document.fileName);
        }
      }),
      { numRuns: 300 }
    );
  });
});
