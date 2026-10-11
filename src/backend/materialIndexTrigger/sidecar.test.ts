import fc from 'fast-check';
import { toCitation } from '../shared/knowledgeBase/citations';
import { studentIsolationFilter } from '../shared/knowledgeBase/retrievalFilter';
import { isResultOwnedBy } from '../shared/knowledgeBase/retrieveForStudent';
import {
  METADATA_STRING_MAX_LENGTH,
  SIDECAR_MAX_BYTES,
  SidecarError,
  buildSidecarDocument,
  serializeSidecar,
  sidecarKeyFor,
  utf8ByteLength,
  type MaterialMetadataTags,
} from './sidecar';

/**
 * Tasks 4.6 / 4.9 — Bedrock Knowledge Base metadata sidecar: every indexed
 * Materials document is tagged with `{studentId, folderPath, fileName}` within
 * Bedrock's metadata limits, and the shared retrieval module reads those tags
 * back (isolation filter, post-filter, citation path).
 *
 * Validates: Requirements 7.6, 7.9, 14.4
 */

const STUDENT = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';

describe('Knowledge Base metadata sidecar', () => {
  it('lives next to the document with the .metadata.json suffix Bedrock expects', () => {
    expect(sidecarKeyFor('private/id/materials/Week 3/Sorting.pdf')).toBe(
      'private/id/materials/Week 3/Sorting.pdf.metadata.json'
    );
  });

  it('tags the document with {studentId, folderPath, fileName}', () => {
    const body = serializeSidecar({
      studentId: 'sub-1',
      folderPath: 'Data Structures/Week 3',
      fileName: 'Sorting.pdf',
    });
    expect(JSON.parse(body)).toEqual({
      metadataAttributes: {
        studentId: 'sub-1',
        folderPath: 'Data Structures/Week 3',
        fileName: 'Sorting.pdf',
      },
    });
  });

  it('stores root files with folderPath "/" (Bedrock rejects empty strings) and keeps non-ASCII names', () => {
    expect(
      buildSidecarDocument({ studentId: 'sub-1', folderPath: '', fileName: 'Săptămâna 1.pdf' })
    ).toEqual({
      metadataAttributes: { studentId: 'sub-1', folderPath: '/', fileName: 'Săptămâna 1.pdf' },
    });
  });

  it.each([
    ['a blank studentId', { studentId: '  ', folderPath: 'A', fileName: 'a.pdf' }],
    ['an empty fileName', { studentId: STUDENT, folderPath: 'A', fileName: '' }],
    ['a non-string folderPath', { studentId: STUDENT, folderPath: undefined, fileName: 'a.pdf' }],
    [
      `a value over ${METADATA_STRING_MAX_LENGTH} characters`,
      { studentId: STUDENT, folderPath: 'a'.repeat(METADATA_STRING_MAX_LENGTH + 1), fileName: 'a.pdf' },
    ],
  ])('refuses %s, so the file fails instead of being indexed untagged', (_label, tags) => {
    expect(() => serializeSidecar(tags as unknown as MaterialMetadataTags)).toThrow(SidecarError);
  });

  it(`refuses a sidecar over ${SIDECAR_MAX_BYTES} bytes`, () => {
    // 2048 control characters are a legal value but JSON-escape to 6 bytes each.
    const tags = { studentId: STUDENT, folderPath: '\u0001'.repeat(2048), fileName: 'a.pdf' };
    expect(() => buildSidecarDocument(tags)).not.toThrow();
    expect(() => serializeSidecar(tags)).toThrow(SidecarError);
  });

  it('keeps even a worst-case 1024-byte S3 key under the size limit', () => {
    const prefix = 'private/eu-central-1:7d3c1f3e-1111-4222-8333-444455556666/materials/';
    const fileName = '\u0001'.repeat(100);
    const folderPath = '\u0001'.repeat(1024 - utf8ByteLength(prefix) - fileName.length - 1);
    expect(utf8ByteLength(`${prefix}${folderPath}/${fileName}`)).toBe(1024);

    const body = serializeSidecar({ studentId: STUDENT, folderPath, fileName });

    expect(utf8ByteLength(body)).toBeLessThanOrEqual(SIDECAR_MAX_BYTES);
  });

  it('counts UTF-8 bytes', () => {
    expect(['a', 'é', '中', '😀'].map(utf8ByteLength)).toEqual([1, 2, 3, 4]);
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 40 }), (value) => {
        const oracle = encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, '_').length;
        expect(utf8ByteLength(value)).toBe(oracle);
      }),
      { numRuns: 100 }
    );
  });
});

const nameArb = fc
  .stringOf(
    fc.oneof(fc.constantFrom(' ', '>', '%', '+', ':', '#', 'ă', 'ș', '中', '😀'), fc.char(), fc.fullUnicode()),
    { minLength: 1, maxLength: 24 }
  )
  .map((name) => name.replace(/\//g, '_'));

describe('sidecar → retrieval round trip (property)', () => {
  it('tags every document so the isolation filter, the post-filter and citations read it back', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(nameArb, { maxLength: 8 }),
        nameArb,
        (studentId, folderSegments, fileName) => {
          // `folderPath` exactly as the trigger passes it: the key's folders joined by "/".
          const body = serializeSidecar({ studentId, folderPath: folderSegments.join('/'), fileName });
          const { metadataAttributes } = JSON.parse(body) as {
            metadataAttributes: Record<string, unknown>;
          };

          expect(Object.keys(metadataAttributes)).toEqual(['studentId', 'folderPath', 'fileName']);
          for (const value of Object.values(metadataAttributes)) {
            expect(typeof value).toBe('string');
            expect((value as string).length).toBeGreaterThanOrEqual(1);
            expect((value as string).length).toBeLessThanOrEqual(METADATA_STRING_MAX_LENGTH);
          }
          expect(utf8ByteLength(body)).toBeLessThanOrEqual(SIDECAR_MAX_BYTES);

          const isolation = studentIsolationFilter(studentId);
          expect(metadataAttributes[isolation.equals.key]).toBe(isolation.equals.value);

          const chunk = { text: 'chunk', s3Uri: null, score: null, metadata: metadataAttributes };
          expect(isResultOwnedBy(chunk, studentId)).toBe(true);
          expect(toCitation(chunk)?.displayPath).toBe([...folderSegments, fileName].join(' > '));
        }
      ),
      { numRuns: 200 }
    );
  });
});
