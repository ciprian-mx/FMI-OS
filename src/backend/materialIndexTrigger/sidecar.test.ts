import { buildSidecarDocument, serializeSidecar, sidecarKeyFor } from './sidecar';

/**
 * Task 4.6 — Bedrock Knowledge Base metadata sidecar.
 *
 * Validates: Requirements 7.6
 */

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

  it('keeps an empty folder path for root files and preserves non-ASCII names', () => {
    expect(
      buildSidecarDocument({ studentId: 'sub-1', folderPath: '', fileName: 'Săptămâna 1.pdf' })
    ).toEqual({
      metadataAttributes: { studentId: 'sub-1', folderPath: '', fileName: 'Săptămâna 1.pdf' },
    });
  });
});
