import { decodeS3EventKey, parseMaterialKey, parseS3EventKey } from './s3Key';

/**
 * Task 4.6 — S3 key parsing for the materialIndexTrigger.
 *
 * Validates: Requirements 7.6
 */

const IDENTITY = 'eu-central-1:7d3c1f3e-1111-4222-8333-444455556666';
const USER = '1f0c3a52-aaaa-4bbb-8ccc-ddddeeeeffff';

describe('decodeS3EventKey', () => {
  it('decodes form-encoded keys: "+" is a space, %2B a plus, %3A a colon', () => {
    expect(decodeS3EventKey('private/eu-central-1%3Aabc/materials/C%2B%2B+Notes/Week+3.pdf')).toBe(
      'private/eu-central-1:abc/materials/C++ Notes/Week 3.pdf'
    );
  });

  it('decodes UTF-8 escapes (Romanian folder names)', () => {
    expect(decodeS3EventKey('students/u/materials/S%C4%83pt%C4%83m%C3%A2na+3/curs.pdf')).toBe(
      'students/u/materials/Săptămâna 3/curs.pdf'
    );
  });

  it('returns null for malformed escape sequences', () => {
    expect(decodeS3EventKey('private/id/materials/bad%E0%A4%A.pdf')).toBeNull();
  });
});

describe('parseMaterialKey — recognised layouts', () => {
  it('parses the private/{identityId}/materials layout the upload helper writes', () => {
    const result = parseMaterialKey(`private/${IDENTITY}/materials/Data Structures/Week 3/Sorting.pdf`);
    expect(result).toEqual({
      ok: true,
      value: {
        key: `private/${IDENTITY}/materials/Data Structures/Week 3/Sorting.pdf`,
        layout: 'private',
        ownerSegment: IDENTITY,
        folderSegments: ['Data Structures', 'Week 3'],
        folderPath: 'Data Structures/Week 3',
        fileName: 'Sorting.pdf',
      },
    });
  });

  it('parses the students/{userId}/materials layout from the design', () => {
    const result = parseMaterialKey(`students/${USER}/materials/Algebra/notes.md`);
    expect(result.ok && result.value).toEqual(
      expect.objectContaining({
        layout: 'students',
        ownerSegment: USER,
        folderPath: 'Algebra',
        fileName: 'notes.md',
      })
    );
  });

  it('keeps deeply nested folder paths intact', () => {
    const result = parseMaterialKey(`private/${IDENTITY}/materials/A/B/C/D/E/file.txt`);
    expect(result.ok && result.value.folderSegments).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(result.ok && result.value.folderPath).toBe('A/B/C/D/E');
  });

  it('gives root-level files an empty folder path', () => {
    const result = parseMaterialKey(`private/${IDENTITY}/materials/syllabus.pdf`);
    expect(result.ok && result.value).toEqual(
      expect.objectContaining({ folderSegments: [], folderPath: '', fileName: 'syllabus.pdf' })
    );
  });

  it('drops empty segments from doubled slashes but keeps the key verbatim', () => {
    const key = `private/${IDENTITY}/materials//Week 3//a.pdf`;
    const result = parseMaterialKey(key);
    expect(result.ok && result.value).toEqual(
      expect.objectContaining({ key, folderPath: 'Week 3', fileName: 'a.pdf' })
    );
  });
});

describe('parseMaterialKey — ignored keys', () => {
  it.each([
    ['its own metadata sidecar', `private/${IDENTITY}/materials/Week 3/Sorting.pdf.metadata.json`, 'metadata-sidecar'],
    ['a sidecar in the root folder', `students/${USER}/materials/a.txt.metadata.json`, 'metadata-sidecar'],
    ['a folder marker', `private/${IDENTITY}/materials/Week 3/`, 'folder-marker'],
    ['the materials prefix itself', `private/${IDENTITY}/materials/`, 'folder-marker'],
    ['another app area', `private/${IDENTITY}/timetables/week.png`, 'outside-materials'],
    ['the public prefix', 'public/materials/x.pdf', 'outside-materials'],
    ['a protected prefix', `protected/${IDENTITY}/materials/x.pdf`, 'outside-materials'],
    ['an empty owner segment', 'private//materials/x.pdf', 'outside-materials'],
    ['a key too short to hold a file', `private/${IDENTITY}`, 'outside-materials'],
    ['a case-mismatched prefix', `Private/${IDENTITY}/materials/x.pdf`, 'outside-materials'],
  ])('ignores %s', (_label, key, reason) => {
    expect(parseMaterialKey(key)).toEqual({ ok: false, reason });
  });
});

describe('parseS3EventKey', () => {
  it('decodes before parsing, so encoded keys resolve to the stored key', () => {
    const result = parseS3EventKey(
      'private/eu-central-1%3A7d3c1f3e-1111-4222-8333-444455556666/materials/Data+Structures/Week+3/Sorting+%281%29.pdf'
    );
    expect(result.ok && result.value).toEqual(
      expect.objectContaining({
        key: `private/${IDENTITY}/materials/Data Structures/Week 3/Sorting (1).pdf`,
        ownerSegment: IDENTITY,
        folderPath: 'Data Structures/Week 3',
        fileName: 'Sorting (1).pdf',
      })
    );
  });

  it('ignores an encoded sidecar key', () => {
    expect(parseS3EventKey('private/id/materials/Week+3/a.pdf.metadata.json')).toEqual({
      ok: false,
      reason: 'metadata-sidecar',
    });
  });

  it('reports malformed encodings', () => {
    expect(parseS3EventKey('private/id/materials/%ZZ.pdf')).toEqual({
      ok: false,
      reason: 'invalid-key-encoding',
    });
  });
});
