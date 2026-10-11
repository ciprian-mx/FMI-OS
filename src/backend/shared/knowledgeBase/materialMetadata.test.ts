import {
  MATERIAL_METADATA_KEYS,
  ROOT_FOLDER_PATH,
  folderSegmentsOf,
  formatCitationPath,
  formatFolderDisplayPath,
  parseMaterialsObjectKey,
  parseMaterialsS3Uri,
  parseS3Uri,
  toMetadataFolderPath,
} from './materialMetadata';

/**
 * Task 4.9 — the Knowledge Base metadata contract shared by ingestion
 * (materialIndexTrigger sidecar) and retrieval (citations).
 *
 * Validates: Requirements 7.9, 14.4
 */

const IDENTITY = 'eu-central-1:7d3c1f3e-1111-4222-8333-444455556666';

describe('Materials metadata attributes', () => {
  it('names the attributes the sidecar writes and the isolation filter reads', () => {
    expect(MATERIAL_METADATA_KEYS).toEqual({
      studentId: 'studentId',
      folderPath: 'folderPath',
      fileName: 'fileName',
    });
  });

  it('stores the Materials root as "/" because Bedrock string values cannot be empty', () => {
    expect(ROOT_FOLDER_PATH).toBe('/');
    expect(toMetadataFolderPath('')).toBe('/');
    expect(toMetadataFolderPath('/')).toBe('/');
  });

  it('keeps nested folder paths in slash form, normalising stray slashes only', () => {
    expect(toMetadataFolderPath('Data Structures/Week 3')).toBe('Data Structures/Week 3');
    expect(toMetadataFolderPath('/Data Structures//Week 3/')).toBe('Data Structures/Week 3');
    expect(toMetadataFolderPath(' Spaced /x')).toBe(' Spaced /x');
  });

  it('splits folder paths into segments, treating "" and "/" as the root', () => {
    expect(folderSegmentsOf('Data Structures/Week 3')).toEqual(['Data Structures', 'Week 3']);
    expect(folderSegmentsOf('')).toEqual([]);
    expect(folderSegmentsOf('/')).toEqual([]);
  });
});

describe('citation display paths', () => {
  it('joins folders and file name with " > "', () => {
    expect(formatCitationPath(['Data Structures', 'Week 3'], 'Sorting.pdf')).toBe(
      'Data Structures > Week 3 > Sorting.pdf'
    );
    expect(formatFolderDisplayPath(['Data Structures', 'Week 3'])).toBe('Data Structures > Week 3');
  });

  it('shows only the file name for root files', () => {
    expect(formatCitationPath([], 'Syllabus.pdf')).toBe('Syllabus.pdf');
    expect(formatFolderDisplayPath([])).toBe('');
  });

  it('keeps Unicode, spaces and punctuation verbatim', () => {
    expect(formatCitationPath(['Structuri de date', 'Săptămâna 3 (curs)'], 'Sortare #1.pdf')).toBe(
      'Structuri de date > Săptămâna 3 (curs) > Sortare #1.pdf'
    );
  });
});

describe('parseMaterialsObjectKey / parseMaterialsS3Uri', () => {
  it('reads folders and file name from the private/ layout', () => {
    expect(
      parseMaterialsS3Uri(`s3://bucket/private/${IDENTITY}/materials/Data Structures/Week 3/Sorting.pdf`)
    ).toEqual({ folderSegments: ['Data Structures', 'Week 3'], fileName: 'Sorting.pdf' });
  });

  it('reads the students/ layout and root-level files', () => {
    expect(parseMaterialsObjectKey('students/sub-1/materials/Syllabus.pdf')).toEqual({
      folderSegments: [],
      fileName: 'Syllabus.pdf',
    });
  });

  it('drops empty segments like the trigger does', () => {
    expect(parseMaterialsObjectKey(`private/${IDENTITY}/materials/A//B/x.md`)).toEqual({
      folderSegments: ['A', 'B'],
      fileName: 'x.md',
    });
  });

  it.each([
    ['another app area', `private/${IDENTITY}/timetables/week.png`],
    ['the public prefix', 'public/materials/x.pdf'],
    ['an empty owner', 'private//materials/x.pdf'],
    ['a folder marker', `private/${IDENTITY}/materials/Week 3/`],
    ['a case-mismatched area', `private/${IDENTITY}/Materials/x.pdf`],
  ])('rejects %s', (_label, key) => {
    expect(parseMaterialsObjectKey(key)).toBeNull();
  });

  it('parses s3:// URIs and rejects anything else', () => {
    expect(parseS3Uri('s3://my-bucket/a/b c.pdf')).toEqual({ bucket: 'my-bucket', key: 'a/b c.pdf' });
    expect(parseS3Uri('https://my-bucket.s3.amazonaws.com/a.pdf')).toBeNull();
    expect(parseS3Uri('s3://my-bucket/')).toBeNull();
    expect(parseMaterialsS3Uri('not a uri')).toBeNull();
  });
});
