import {
  TEST_KNOWLEDGE_BASE_ID,
  materialChunk,
  rawRetrievalResult,
  recordingRuntimeSdk,
} from './__tests__/fakes';
import { createBedrockKnowledgeBaseRetriever } from './bedrockRetriever';
import { toCitations } from './citations';
import { RetrievalRequestError } from './errors';
import type { KnowledgeBaseRetrieveRequest } from './ports';
import { retrieveForStudent } from './retrieveForStudent';

/**
 * Task 4.9 — the Bedrock Agent Runtime `Retrieve` adapter, exercised with a
 * fake client and command class: request shape, response mapping and the
 * refusal of unscoped requests.
 *
 * Validates: Requirements 1.5, 7.9, 14.4
 */

const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const OTHER = '9e8d7c6b-1111-4222-8333-444455556666';
const ISOLATION = { equals: { key: 'studentId', value: STUDENT } };

function scopedRequest(overrides: Partial<KnowledgeBaseRetrieveRequest> = {}): KnowledgeBaseRetrieveRequest {
  return { studentId: STUDENT, queryText: 'heaps', filter: ISOLATION, ...overrides };
}

describe('createBedrockKnowledgeBaseRetriever', () => {
  it('sends a RetrieveCommand with the filter in vectorSearchConfiguration', async () => {
    const { client, sdk } = recordingRuntimeSdk();
    const knowledgeBase = createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID });

    await knowledgeBase.retrieve(
      scopedRequest({ numberOfResults: 20, searchType: 'SEMANTIC', nextToken: 'tok' })
    );

    expect(client.sent).toEqual([
      {
        name: 'RetrieveCommand',
        input: {
          knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID,
          retrievalQuery: { text: 'heaps' },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              filter: ISOLATION,
              numberOfResults: 20,
              overrideSearchType: 'SEMANTIC',
            },
          },
          nextToken: 'tok',
        },
      },
    ]);
  });

  it('omits the optional fields it was not given', async () => {
    const { client, sdk } = recordingRuntimeSdk();

    await createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID }).retrieve(
      scopedRequest()
    );

    expect(client.sent[0].input).toEqual({
      knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: 'heaps' },
      retrievalConfiguration: { vectorSearchConfiguration: { filter: ISOLATION } },
    });
  });

  it('maps the response into results with text, S3 URI, score and metadata', async () => {
    const chunk = materialChunk({
      studentId: STUDENT,
      folderSegments: ['Data Structures'],
      fileName: 'Heaps.pdf',
      score: 0.9,
    });
    const { sdk } = recordingRuntimeSdk(() => ({
      retrievalResults: [
        rawRetrievalResult(chunk),
        { content: { type: 'IMAGE', byteContent: 'AAAA' }, location: { type: 'WEB' }, metadata: 'not-an-object' },
        null,
      ],
      nextToken: 'next',
    }));

    const response = await createBedrockKnowledgeBaseRetriever(sdk, {
      knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID,
    }).retrieve(scopedRequest());

    expect(response).toEqual({
      results: [
        chunk,
        { text: '', s3Uri: null, score: null, metadata: {} },
        { text: '', s3Uri: null, score: null, metadata: {} },
      ],
      nextToken: 'next',
    });
  });

  it('tolerates an empty response', async () => {
    const { sdk } = recordingRuntimeSdk(() => undefined);

    await expect(
      createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID }).retrieve(scopedRequest())
    ).resolves.toEqual({ results: [], nextToken: null });
  });

  it.each([
    ['no filter', { filter: undefined }],
    ['another student’s clause', { filter: { equals: { key: 'studentId', value: OTHER } } }],
    ['a filter without the clause', { filter: { equals: { key: 'fileName', value: 'a.pdf' } } }],
    ['the clause under orAll', { filter: { orAll: [ISOLATION, { equals: { key: 'fileName', value: 'a' } }] } }],
    ['a blank student id', { studentId: ' ', filter: { equals: { key: 'studentId', value: ' ' } } }],
  ])('refuses to send a request with %s', async (_label, overrides) => {
    const { client, sdk } = recordingRuntimeSdk();
    const knowledgeBase = createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID });

    const attempt = knowledgeBase.retrieve(scopedRequest(overrides as Partial<KnowledgeBaseRetrieveRequest>));

    await expect(attempt).rejects.toBeInstanceOf(RetrievalRequestError);
    await expect(attempt).rejects.toMatchObject({ reason: 'unscoped-filter' });
    expect(client.sent).toEqual([]);
  });

  it('propagates SDK errors', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const { sdk } = recordingRuntimeSdk(() => throttled);

    await expect(
      createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID }).retrieve(scopedRequest())
    ).rejects.toBe(throttled);
  });

  it.each([[''], ['KB123'], ['KB12345678-extra'], ['arn:aws:bedrock:eu-central-1:123456789012:knowledge-base/KB12345678']])(
    'rejects the knowledge base id %p',
    (knowledgeBaseId) => {
      const { sdk } = recordingRuntimeSdk();
      expect(() => createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId })).toThrow(
        'knowledgeBaseId must be a 10-character alphanumeric Bedrock id'
      );
    }
  );
});

describe('retrieveForStudent over the Bedrock adapter', () => {
  it('sends the scoped filter to Bedrock, drops foreign chunks and cites the rest', async () => {
    const own = materialChunk({ studentId: STUDENT, folderSegments: ['Data Structures', 'Week 3'], fileName: 'Sorting.pdf' });
    const foreign = materialChunk({ studentId: OTHER, folderSegments: ['Secret'], fileName: 'Theirs.pdf' });
    const { client, sdk } = recordingRuntimeSdk(() => ({
      retrievalResults: [rawRetrievalResult(foreign), rawRetrievalResult(own)],
    }));
    const knowledgeBase = createBedrockKnowledgeBaseRetriever(sdk, { knowledgeBaseId: TEST_KNOWLEDGE_BASE_ID });

    const retrieval = await retrieveForStudent(knowledgeBase, {
      studentId: STUDENT,
      query: 'sorting',
      numberOfResults: 20,
      filter: { startsWith: { key: 'folderPath', value: 'Data Structures' } },
    });

    expect(client.sent[0].input.retrievalConfiguration.vectorSearchConfiguration.filter).toEqual({
      andAll: [ISOLATION, { startsWith: { key: 'folderPath', value: 'Data Structures' } }],
    });
    expect(retrieval.droppedCount).toBe(1);
    expect(toCitations(retrieval.results).map((citation) => citation.displayPath)).toEqual([
      'Data Structures > Week 3 > Sorting.pdf',
    ]);
  });
});
