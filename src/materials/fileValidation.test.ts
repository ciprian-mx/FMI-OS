import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  UploadCandidate,
  allowedFormatsMessage,
  extractExtension,
  isAllowedExtension,
  isAllowedMimeType,
  validateUpload,
} from './fileValidation';

/**
 * Task 4.3 — Materials file-upload validation utility.
 *
 * Example-based unit tests pinning the accepted formats, the 20 MB size limit,
 * and the structured valid/invalid result with a human-readable reason. The
 * universal "accepted iff allowed format AND size <= 20MB" property is covered
 * separately by the Property 8 test (task 4.4).
 *
 * Validates: Requirements 7.4, 7.5
 */

function candidate(
  name: string,
  size: number,
  type?: string
): UploadCandidate {
  return { name, size, type };
}

describe('extractExtension', () => {
  it('returns the lower-cased extension after the final dot', () => {
    expect(extractExtension('Sorting.pdf')).toBe('pdf');
    expect(extractExtension('REPORT.PDF')).toBe('pdf');
    expect(extractExtension('archive.tar.gz')).toBe('gz');
  });

  it('trims surrounding whitespace before extracting', () => {
    expect(extractExtension('  notes.md  ')).toBe('md');
  });

  it('returns null when there is no usable extension', () => {
    expect(extractExtension('README')).toBeNull();
    expect(extractExtension('trailing.')).toBeNull();
    expect(extractExtension('.gitignore')).toBeNull();
    expect(extractExtension('')).toBeNull();
  });
});

describe('isAllowedExtension', () => {
  it('accepts every allowed extension case-insensitively', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(isAllowedExtension(ext)).toBe(true);
      expect(isAllowedExtension(ext.toUpperCase())).toBe(true);
    }
  });

  it('rejects unknown extensions and null', () => {
    expect(isAllowedExtension('exe')).toBe(false);
    expect(isAllowedExtension('zip')).toBe(false);
    expect(isAllowedExtension(null)).toBe(false);
  });
});

describe('isAllowedMimeType', () => {
  it('accepts allowed MIME types, ignoring parameters and case', () => {
    expect(isAllowedMimeType('application/pdf')).toBe(true);
    expect(isAllowedMimeType('text/plain; charset=utf-8')).toBe(true);
    expect(isAllowedMimeType('IMAGE/PNG')).toBe(true);
  });

  it('rejects unknown or empty MIME types', () => {
    expect(isAllowedMimeType('application/x-msdownload')).toBe(false);
    expect(isAllowedMimeType('')).toBe(false);
    expect(isAllowedMimeType(undefined)).toBe(false);
  });
});

describe('validateUpload', () => {
  it('accepts a file for every allowed extension at a safe size', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      const result = validateUpload(candidate(`file.${ext}`, 1024));
      expect(result).toEqual({ valid: true });
    }
  });

  it('accepts a file exactly at the 20 MB boundary', () => {
    const result = validateUpload(candidate('big.pdf', MAX_FILE_SIZE_BYTES));
    expect(result.valid).toBe(true);
  });

  it('accepts a valid extension when the MIME type is empty/absent', () => {
    expect(validateUpload(candidate('notes.md', 10, '')).valid).toBe(true);
    expect(validateUpload(candidate('notes.md', 10)).valid).toBe(true);
  });

  it('accepts when a correct MIME type accompanies the extension', () => {
    expect(validateUpload(candidate('slide.pptx', 10, ALLOWED_MIME_TYPES[1])).valid).toBe(
      true
    );
    expect(validateUpload(candidate('photo.png', 10, 'image/png')).valid).toBe(true);
  });

  it('rejects an unsupported extension with a format message', () => {
    const result = validateUpload(candidate('malware.exe', 10));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported file format');
    expect(result.error).toContain('PDF');
  });

  it('rejects a file with no extension', () => {
    const result = validateUpload(candidate('README', 10));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported file format');
  });

  it('rejects a disguised file whose concrete MIME is not allowed', () => {
    const result = validateUpload(
      candidate('definitely.pdf', 10, 'application/x-msdownload')
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported file format');
  });

  it('rejects a file one byte over the 20 MB limit', () => {
    const result = validateUpload(candidate('toobig.pdf', MAX_FILE_SIZE_BYTES + 1));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('20 MB');
  });

  it('rejects a file with an invalid size value', () => {
    expect(validateUpload(candidate('x.pdf', Number.NaN)).valid).toBe(false);
    expect(validateUpload(candidate('x.pdf', -1)).valid).toBe(false);
  });

  it('reports the format problem before the size problem', () => {
    // Oversized AND unsupported: the format message should win.
    const result = validateUpload(candidate('huge.exe', MAX_FILE_SIZE_BYTES + 1));
    expect(result.error).toContain('Unsupported file format');
  });

  it('a real File shape structurally satisfies UploadCandidate', () => {
    // Mimic the browser File fields the validator reads.
    const fileLike = { name: 'lecture.docx', size: 2048, type: ALLOWED_MIME_TYPES[5] };
    expect(validateUpload(fileLike).valid).toBe(true);
  });
});

describe('allowedFormatsMessage', () => {
  it('lists formats upper-cased and folds jpeg into JPG', () => {
    const message = allowedFormatsMessage();
    expect(message).toContain('PDF');
    expect(message).toContain('JPG');
    expect(message).not.toContain('JPEG');
  });
});
