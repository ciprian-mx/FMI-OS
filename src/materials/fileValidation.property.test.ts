import fc from 'fast-check';
import { ALLOWED_EXTENSIONS, validateUpload } from './fileValidation';

/**
 * Feature: fmi-os, Property 8: File Format and Size Validation
 *
 * **Validates: Requirements 7.4, 7.5**
 *
 * For any file F submitted to the Materials upload system, F SHALL be accepted
 * iff F's extension is in {pdf, pptx, txt, md, docx, xlsx, png, jpg, jpeg} AND
 * F's size <= 20,971,520 bytes (20 MB). Any other file SHALL be rejected with
 * an error message specifying the allowed formats and the size limit.
 *
 * The oracle comes from the spec, not from the module under test: the
 * allow-list and the byte limit are restated literally below, and every
 * generated file name is assembled from parts, so its extension is known by
 * construction instead of being parsed with the module's own helpers.
 *
 * MIME types: Property 8 says nothing about them, but `validateUpload` also
 * rejects an allowed extension whose concrete MIME type is not an allowed
 * format (a disguised file; pinned by fileValidation.test.ts). That rule only
 * ever rejects more, never accepts more, so this file asserts:
 *   1. the exact iff, for files whose `type` is absent, empty, or the MIME type
 *      of an allowed format, and
 *   2. the reject direction for ANY `type`, so no declared MIME type can get a
 *      file with a bad extension or an oversized file accepted.
 *
 * Sizes are non-negative integers, as `File.size` always is. NaN and negative
 * sizes are covered by the example tests.
 */

/** Extensions Property 8 allows, restated from the spec. */
const SPEC_ALLOWED_EXTENSIONS: readonly string[] = [
  'pdf',
  'pptx',
  'txt',
  'md',
  'docx',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
];

/** Property 8's size limit: 20 MB. */
const SPEC_MAX_BYTES = 20_971_520;

/** Formats an "unsupported format" message must list (Requirement 7.5). */
const FORMAT_LABELS = ['PDF', 'PPTX', 'TXT', 'MD', 'DOCX', 'XLSX', 'PNG', 'JPG'];

/** Near misses of the allowed extensions (including legacy Office) and other common formats. */
const UNSUPPORTED_EXTENSIONS = [
  'pd', 'pdff', 'ppt', 'pptm', 'tx', 'txtx', 'mdx', 'doc', 'docm', 'xls', 'xlsm',
  'pn', 'pngx', 'jp', 'jpgx', 'jpegx', 'exe', 'zip', 'rar', '7z', 'odt', 'rtf',
  'csv', 'html', 'js', 'gif', 'bmp', 'svg', 'webp', 'heic', 'mp4',
];

/** MIME types browsers report for the allowed formats. */
const ALLOWED_FORMAT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
];

/** MIME types of formats Property 8 does not allow. */
const OTHER_MIME_TYPES = [
  'application/x-msdownload',
  'application/zip',
  'application/octet-stream',
  'application/msword',
  'text/html',
  'image/gif',
  'video/mp4',
];

/** A generated file name plus the extension it has by construction (null = none). */
interface NamedFile {
  name: string;
  extension: string | null;
}

const isAllowedBySpec = (extension: string | null): boolean =>
  extension !== null && SPEC_ALLOWED_EXTENSIONS.includes(extension.toLowerCase());

const isWithinLimit = (size: number): boolean => size <= SPEC_MAX_BYTES;

const listsAllowedFormats = (message: string): boolean =>
  FORMAT_LABELS.every((label) => new RegExp(`\\b${label}\\b`, 'i').test(message));

const namesSizeLimit = (message: string): boolean => /\b20\s?MB\b/i.test(message);

/** Extensions: allowed ones in random case, unsupported ones, and random strings. */
const extensionArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.mixedCase(fc.constantFrom(...SPEC_ALLOWED_EXTENSIONS)), weight: 6 },
  // The module's own allow-list: an entry the spec does not sanction fails the oracle.
  { arbitrary: fc.constantFrom(...ALLOWED_EXTENSIONS), weight: 1 },
  { arbitrary: fc.constantFrom(...UNSUPPORTED_EXTENSIONS), weight: 3 },
  {
    arbitrary: fc.mixedCase(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
        minLength: 1,
        maxLength: 6,
      })
    ),
    weight: 2,
  }
);

/** A non-blank, dot-free base name: ASCII, Unicode, or a realistic course-file name. */
const stemArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 24 }),
    fc.unicodeString({ minLength: 1, maxLength: 24 }),
    fc.constantFrom('Sorting', 'Curs 3 - Grafuri', 'Notițe săptămâna 3', 'lab_01 (final)')
  )
  .map((s) => s.replace(/\./g, '_'))
  .filter((s) => s.trim().length > 0);

const namedFileArb: fc.Arbitrary<NamedFile> = fc.oneof(
  // "stem.ext"
  {
    arbitrary: fc
      .tuple(stemArb, extensionArb)
      .map(([stem, ext]): NamedFile => ({ name: `${stem}.${ext}`, extension: ext })),
    weight: 5,
  },
  // "stem.a.b.ext": only the last segment counts ("notes.pdf.exe", "backup.exe.pdf").
  {
    arbitrary: fc
      .tuple(stemArb, fc.array(fc.oneof(stemArb, extensionArb), { minLength: 1, maxLength: 3 }), extensionArb)
      .map(([stem, inner, ext]): NamedFile => ({ name: [stem, ...inner, ext].join('.'), extension: ext })),
    weight: 2,
  },
  // No extension: "stem", "stem.", or a dot-file such as ".pdf" (as with Node's path.extname).
  { arbitrary: stemArb.map((stem): NamedFile => ({ name: stem, extension: null })), weight: 1 },
  { arbitrary: stemArb.map((stem): NamedFile => ({ name: `${stem}.`, extension: null })), weight: 1 },
  { arbitrary: extensionArb.map((ext): NamedFile => ({ name: `.${ext}`, extension: null })), weight: 1 }
);

/** Non-negative integer sizes, concentrated around the 20 MB boundary. */
const sizeArb: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: SPEC_MAX_BYTES }), weight: 2 },
  { arbitrary: fc.integer({ min: SPEC_MAX_BYTES - 1024, max: SPEC_MAX_BYTES + 1024 }), weight: 2 },
  { arbitrary: fc.integer({ min: SPEC_MAX_BYTES + 1, max: 2 * SPEC_MAX_BYTES }), weight: 1 },
  { arbitrary: fc.maxSafeNat(), weight: 1 },
  { arbitrary: fc.constantFrom(0, SPEC_MAX_BYTES - 1, SPEC_MAX_BYTES, SPEC_MAX_BYTES + 1), weight: 1 }
);

/** `type` values that name no other format: absent, empty, or an allowed format's MIME type. */
const neutralMimeArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constantFrom(...ALLOWED_FORMAT_MIME_TYPES)
);

/** Any `type` value, including other formats' MIME types and arbitrary strings. */
const anyMimeArb: fc.Arbitrary<string | undefined> = fc.oneof(
  neutralMimeArb,
  fc.constantFrom(...OTHER_MIME_TYPES),
  fc.string({ maxLength: 40 })
);

describe('Feature: fmi-os, Property 8: File Format and Size Validation (Validates: Requirements 7.4, 7.5)', () => {
  it('accepts a file iff its extension is allowed AND its size is at most 20,971,520 bytes', () => {
    let accepted = 0;
    let rejected = 0;

    fc.assert(
      fc.property(namedFileArb, sizeArb, neutralMimeArb, ({ name, extension }, size, type) => {
        const formatOk = isAllowedBySpec(extension);
        const sizeOk = isWithinLimit(size);
        const result = validateUpload({ name, size, type });

        expect(result.valid).toBe(formatOk && sizeOk);

        if (result.valid) {
          accepted += 1;
          expect(result.error).toBeUndefined();
          return;
        }

        rejected += 1;
        // The message states the rule that was broken; when both were, either one.
        const message = result.error ?? '';
        if (!formatOk && sizeOk) {
          expect(listsAllowedFormats(message)).toBe(true);
        } else if (formatOk && !sizeOk) {
          expect(namesSizeLimit(message)).toBe(true);
        } else {
          expect(listsAllowedFormats(message) || namesSizeLimit(message)).toBe(true);
        }
      }),
      { numRuns: 500 }
    );

    // Both sides of the iff were exercised.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it('rejects every file that breaks either rule, whatever MIME type it declares', () => {
    const nonCompliantArb = fc
      .tuple(namedFileArb, sizeArb, anyMimeArb)
      .filter(([{ extension }, size]) => !(isAllowedBySpec(extension) && isWithinLimit(size)));

    fc.assert(
      fc.property(nonCompliantArb, ([{ name }, size, type]) => {
        const result = validateUpload({ name, size, type });

        expect(result.valid).toBe(false);
        const message = result.error ?? '';
        expect(listsAllowedFormats(message) || namesSizeLimit(message)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });
});
