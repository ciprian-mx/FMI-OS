import { TEST_BUCKET, TEST_IDENTITY_ID, materialChunk } from './__tests__/fakes';
import { resolveDocumentPath, toCitation, toCitations } from './citations';
import type { KnowledgeBaseResult } from './ports';

/**
 * Task 4.9 — folder-path citations built from Knowledge Base results.
 *
 * Validates: Requirements 7.9, 14.4
 */

const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';
const URI = `s3://${TEST_BUCKET}/private/${TEST_IDENTITY_ID}/materials/Data Structures/Week 3/Sorting.pdf`;

function chunk(metadata: Record<string, unknown>, s3Uri: string | null = URI, text = 'Quick sort'): KnowledgeBaseResult {
  return { text, s3Uri, score: 0.42, metadata };
}

describe('toCitation — from the sidecar metadata', () => {
  it('cites the full folder path, e.g. "Data Structures > Week 3 > Sorting.pdf"', () => {
    const result = materialChunk({
      studentId: STUDENT,
      folderSegments: ['Data Structures', 'Week 3'],
      fileName: 'Sorting.pdf',
      text: 'Quick sort runs in O(n log n) on average.',
      score: 0.87,
    });

    expect(toCitation(result)).toEqual({
      sourceDocumentName: 'Sorting.pdf',
      folderPath: 'Data Structures > Week 3',
      folderSegments: ['Data Structures', 'Week 3'],
      displayPath: 'Data Structures > Week 3 > Sorting.pdf',
      section: '',
      excerpt: 'Quick sort runs in O(n log n) on average.',
      s3Uri: URI,
      score: 0.87,
    });
  });

  it('cites root files by name, whether the root is stored as "/" or as a legacy ""', () => {
    for (const folderPath of ['/', '']) {
      const citation = toCitation(chunk({ studentId: STUDENT, folderPath, fileName: 'Syllabus.pdf' }));
      expect(citation).toEqual(
        expect.objectContaining({ displayPath: 'Syllabus.pdf', folderPath: '', folderSegments: [] })
      );
    }
  });

  it('prefers the metadata over the S3 key (the sidecar is authoritative)', () => {
    const citation = toCitation(chunk({ studentId: STUDENT, folderPath: 'Algorithms', fileName: 'Greedy.pdf' }));
    expect(citation?.displayPath).toBe('Algorithms > Greedy.pdf');
  });

  it('takes the file name from the URI when only fileName is missing', () => {
    const citation = toCitation(chunk({ studentId: STUDENT, folderPath: 'Data Structures/Week 3' }));
    expect(citation?.displayPath).toBe('Data Structures > Week 3 > Sorting.pdf');
  });
});

describe('toCitation — S3 URI fallback', () => {
  it('parses the location URI when the metadata has no folderPath', () => {
    expect(resolveDocumentPath(chunk({ studentId: STUDENT }))).toEqual({
      folderSegments: ['Data Structures', 'Week 3'],
      fileName: 'Sorting.pdf',
      source: 's3-uri',
    });
    expect(toCitation(chunk({ studentId: STUDENT, fileName: 'Other.pdf' }))?.displayPath).toBe(
      'Data Structures > Week 3 > Sorting.pdf'
    );
  });

  it('uses Bedrock’s x-amz-bedrock-kb-source-uri when the result has no S3 location', () => {
    const citation = toCitation(
      chunk({ studentId: STUDENT, 'x-amz-bedrock-kb-source-uri': 's3://b/students/sub-1/materials/Algebra/Groups.md' }, null)
    );
    expect(citation).toEqual(
      expect.objectContaining({
        displayPath: 'Algebra > Groups.md',
        s3Uri: 's3://b/students/sub-1/materials/Algebra/Groups.md',
      })
    );
  });

  it('builds the same citation from a sidecar-less chunk as from a tagged one', () => {
    const spec = { studentId: STUDENT, folderSegments: ['Analiză', 'Curs 2'], fileName: 'Serii.pdf' };
    const tagged = toCitation(materialChunk(spec));
    const untagged = toCitation(materialChunk({ ...spec, withoutSidecar: true }));
    expect(untagged).toEqual(tagged);
  });

  it.each([
    ['a non-Materials key', chunk({ studentId: STUDENT }, `s3://${TEST_BUCKET}/private/${TEST_IDENTITY_ID}/timetables/week.png`)],
    ['no location at all', chunk({ studentId: STUDENT }, null)],
    [
      'a web source',
      chunk({ studentId: STUDENT, 'x-amz-bedrock-kb-source-uri': 'https://example.com/notes' }, null),
    ],
    ['folderPath without any file name', chunk({ studentId: STUDENT, folderPath: 'A' }, 's3://b/other/x.pdf')],
  ])('gives no citation for %s', (_label, result) => {
    expect(toCitation(result)).toBeNull();
  });

  it('toCitations keeps resolvable chunks in order and skips the rest', () => {
    const first = materialChunk({ studentId: STUDENT, folderSegments: ['A'], fileName: '1.pdf' });
    const unknown = chunk({ studentId: STUDENT }, null);
    const second = materialChunk({ studentId: STUDENT, fileName: '2.pdf' });
    expect(toCitations([first, unknown, second]).map((citation) => citation.displayPath)).toEqual([
      'A > 1.pdf',
      '2.pdf',
    ]);
  });
});

describe('toCitation — section and excerpt', () => {
  it('names the PDF page Bedrock reports', () => {
    const base = { studentId: STUDENT, folderPath: 'A', fileName: 'a.pdf' };
    expect(toCitation(chunk({ ...base, 'x-amz-bedrock-kb-document-page-number': 3 }))?.section).toBe('Page 3');
    expect(toCitation(chunk({ ...base, 'x-amz-bedrock-kb-document-page-number': '12' }))?.section).toBe('Page 12');
    expect(toCitation(chunk({ ...base, 'x-amz-bedrock-kb-document-page-number': 'n/a' }))?.section).toBe('');
  });

  it('collapses whitespace and shortens long chunks on a character boundary', () => {
    const base = { studentId: STUDENT, folderPath: 'A', fileName: 'a.pdf' };
    expect(toCitation(chunk(base, URI, '  line one\n\n line\ttwo  '))?.excerpt).toBe('line one line two');
    expect(toCitation(chunk(base, URI, 'abcdef'), { excerptMaxLength: 4 })?.excerpt).toBe('abc…');
    expect(toCitation(chunk(base, URI, '😀😀😀😀'), { excerptMaxLength: 3 })?.excerpt).toBe('😀😀…');
    expect(toCitation(chunk(base, URI, 'abc'), { excerptMaxLength: 0 })?.excerpt).toBe('');
  });

  it('rejects a negative or fractional excerpt length', () => {
    const result = chunk({ studentId: STUDENT, folderPath: 'A', fileName: 'a.pdf' });
    expect(() => toCitation(result, { excerptMaxLength: -1 })).toThrow(RangeError);
    expect(() => toCitations([result], { excerptMaxLength: 1.5 })).toThrow(RangeError);
  });
});
