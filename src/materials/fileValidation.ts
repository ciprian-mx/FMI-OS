/**
 * Materials file-upload validation utility (Task 4.3, Requirements 7.4 / 7.5).
 *
 * Before a file is uploaded into the Materials hierarchy (task 4.5) it must be
 * screened against the Knowledge-Base ingest rules the design doc fixes:
 *
 *   • its extension / format must be one of the accepted document and image
 *     types (PDF, PPTX, TXT, MD, DOCX, XLSX, PNG, JPG/JPEG), and
 *   • it must not exceed the 20 MB per-file size limit.
 *
 * A file that fails either check is rejected with a human-readable reason that
 * names the allowed formats and the size limit (Requirement 7.5), so the
 * MaterialsApp upload flow can surface the exact message to the student.
 *
 * Like the sibling helpers in `src/auth/` and `src/materials/folderHierarchy.ts`,
 * this module is deliberately pure and framework-agnostic. Rather than depend on
 * the browser `File` type it accepts the minimal {@link UploadCandidate} shape
 * (`name`, `size`, optional `type`), which a real `File` structurally satisfies.
 * That keeps the rules trivially unit- and property-testable without a DOM, and
 * exports the allow-list and limit as named constants so the UI, the upload
 * mutation, and the tests all share a single source of truth.
 */

/**
 * The minimal, structurally-typed view of an upload the validator needs. A
 * browser `File` (which has `name: string`, `size: number`, `type: string`)
 * satisfies this shape directly, so callers can pass a real `File` without any
 * adaptation while tests construct plain objects.
 */
export interface UploadCandidate {
  /** The file name, including its extension (e.g. "Sorting.pdf"). */
  name: string;
  /** The file size in bytes. */
  size: number;
  /** The MIME type, when the browser could determine one (may be ""/undefined). */
  type?: string;
}

/** Structured outcome of an upload validation check. */
export interface ValidationResult {
  valid: boolean;
  /** Present only when `valid` is false; a human-readable reason. */
  error?: string;
}

/**
 * Lower-cased file extensions accepted for Materials uploads (Requirement 7.4).
 * `jpeg` is included alongside `jpg` since both denote the same JPEG image
 * format. This is the single source of truth for the allowed formats.
 */
export const ALLOWED_EXTENSIONS: readonly string[] = [
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

/**
 * MIME types that correspond to the {@link ALLOWED_EXTENSIONS}. Used as a
 * secondary, best-effort signal: a file whose extension is allowed is accepted
 * regardless of MIME, but when a non-empty `type` is present it must be one of
 * these (guarding against, e.g., an executable renamed to `.pdf`). Browsers do
 * not always populate `type`, so an empty / unknown MIME is never on its own a
 * reason to reject an otherwise-valid extension.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'text/plain', // txt
  'text/markdown', // md
  'text/x-markdown', // md (alternate)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'image/png',
  'image/jpeg',
];

/** Maximum accepted file size in bytes: 20 MB (Requirement 7.5). */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** Human-readable size limit (e.g. for error messages): "20 MB". */
export const MAX_FILE_SIZE_LABEL = '20 MB';

/**
 * Human-readable summary of the accepted formats, suitable for surfacing in UI
 * error messages. Derived from {@link ALLOWED_EXTENSIONS} so it never drifts
 * from the rule. `jpeg` is folded into `JPG` to avoid a redundant entry.
 */
export function allowedFormatsMessage(
  extensions: readonly string[] = ALLOWED_EXTENSIONS
): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const ext of extensions) {
    // Collapse the jpg/jpeg pair into a single "JPG" label.
    const canonical = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    labels.push(canonical.toUpperCase());
  }
  return labels.join(', ');
}

/**
 * Extracts the lower-cased extension of a file name, or `null` when the name
 * has no usable extension.
 *
 * The extension is the text after the final dot. A name with no dot, a name
 * that ends in a dot (empty extension), or a dot-file with no other dot (e.g.
 * ".gitignore") yields `null`. Any surrounding whitespace is trimmed first.
 */
export function extractExtension(name: string): string | null {
  if (typeof name !== 'string') {
    return null;
  }
  const trimmed = name.trim();
  const lastDot = trimmed.lastIndexOf('.');
  // No dot, leading-dot-only name (".gitignore"), or trailing dot => no ext.
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return null;
  }
  return trimmed.slice(lastDot + 1).toLowerCase();
}

/**
 * True when `extension` is one of the {@link ALLOWED_EXTENSIONS}
 * (case-insensitive).
 */
export function isAllowedExtension(
  extension: string | null,
  allowed: readonly string[] = ALLOWED_EXTENSIONS
): boolean {
  if (!extension) {
    return false;
  }
  const lower = extension.toLowerCase();
  return allowed.some((e) => e.toLowerCase() === lower);
}

/**
 * True when `mimeType` is one of the {@link ALLOWED_MIME_TYPES}. An empty,
 * missing, or unknown MIME type returns `false`; callers treat an absent MIME
 * as "no signal" rather than a rejection (see {@link validateUpload}).
 */
export function isAllowedMimeType(
  mimeType: string | undefined | null,
  allowed: readonly string[] = ALLOWED_MIME_TYPES
): boolean {
  if (!mimeType) {
    return false;
  }
  // MIME types may carry parameters (e.g. "text/plain; charset=utf-8"); compare
  // only the type/subtype portion, case-insensitively.
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return allowed.some((m) => m.toLowerCase() === base);
}

/**
 * Validates a file for upload into the Materials Knowledge Base.
 *
 * A candidate is accepted iff:
 *   1. its extension is in {@link ALLOWED_EXTENSIONS}, and
 *   2. if a non-empty MIME `type` is present, that MIME is in
 *      {@link ALLOWED_MIME_TYPES} (an absent / empty MIME is not a rejection,
 *      since browsers do not reliably populate it), and
 *   3. its `size` is a non-negative number not exceeding
 *      {@link MAX_FILE_SIZE_BYTES} (20 MB).
 *
 * The format check runs before the size check so an unsupported file reports
 * the format problem first. Returns a structured result rather than throwing so
 * callers can render the `error` string directly (Requirement 7.5).
 */
export function validateUpload(file: UploadCandidate): ValidationResult {
  const unsupportedFormatError = `Unsupported file format. Allowed formats: ${allowedFormatsMessage()}.`;

  const extension = extractExtension(file.name);
  if (!isAllowedExtension(extension)) {
    return { valid: false, error: unsupportedFormatError };
  }

  // The MIME type is a secondary guard: only reject when the browser supplied a
  // concrete, non-empty type that is *not* on the allow-list (e.g. a disguised
  // file). A missing / empty MIME is accepted on the strength of the extension.
  if (file.type && file.type.trim().length > 0 && !isAllowedMimeType(file.type)) {
    return { valid: false, error: unsupportedFormatError };
  }

  if (typeof file.size !== 'number' || Number.isNaN(file.size) || file.size < 0) {
    return { valid: false, error: 'File size could not be determined.' };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File exceeds the ${MAX_FILE_SIZE_LABEL} size limit.`,
    };
  }

  return { valid: true };
}
