/**
 * S3 object-key parsing for the `materialIndexTrigger` (Task 4.6).
 *
 * Two layouts are recognised:
 *
 *   private/{cognito-identity-id}/materials/{folderPath...}/{fileName}
 *     What the upload helper actually writes (task 4.5) inside the
 *     IAM-enforced per-student prefix (task 1.7).
 *   students/{userId}/materials/{folderPath...}/{fileName}
 *     The layout sketched in design.md.
 *
 * S3 event notifications deliver keys URL-encoded the HTML-form way: a space
 * becomes `+`, a literal plus `%2B`, the `:` of a Cognito identity id `%3A`.
 * {@link decodeS3EventKey} undoes that; everything else works on the decoded
 * key, which is exactly the key S3 stores and `MaterialFile.s3Key` records.
 *
 * Keys are opaque strings to S3, so no path normalisation is applied: a `..`
 * segment is just a folder name and cannot escape the owner prefix, which is
 * matched positionally.
 */

/** Third key segment under which Materials objects live. */
export const MATERIALS_SEGMENT = 'materials';

/** Suffix of the Bedrock Knowledge Base metadata sidecar written next to a document. */
export const METADATA_SIDECAR_SUFFIX = '.metadata.json';

export type MaterialKeyLayout = 'private' | 'students';

const LAYOUTS: readonly string[] = ['private', 'students'];

/** A Materials object key broken into its parts. */
export interface MaterialObjectKey {
  /** The decoded key, verbatim. */
  key: string;
  layout: MaterialKeyLayout;
  /** Cognito identity id (`private`) or user id (`students`). */
  ownerSegment: string;
  /** Folder names between `materials/` and the file name (empty segments dropped). */
  folderSegments: string[];
  /** `folderSegments.join('/')`, e.g. "Data Structures/Week 3"; empty for the root. */
  folderPath: string;
  fileName: string;
}

/** Why a key is not a Materials document the trigger should index. */
export type KeyIgnoreReason =
  | 'invalid-key-encoding'
  | 'outside-materials'
  | 'folder-marker'
  | 'metadata-sidecar';

export type MaterialKeyParseResult =
  | { ok: true; value: MaterialObjectKey }
  | { ok: false; reason: KeyIgnoreReason };

/**
 * Decodes an S3 event-notification key (`+` is a space, `%XX` escapes).
 * Returns `null` for malformed escape sequences.
 */
export function decodeS3EventKey(rawKey: string): string | null {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** True for `<document>.metadata.json` sidecars (written by the trigger itself). */
export function isMetadataSidecarKey(key: string): boolean {
  return key.endsWith(METADATA_SIDECAR_SUFFIX);
}

/** Parses an already-decoded object key. */
export function parseMaterialKey(key: string): MaterialKeyParseResult {
  const segments = key.split('/');
  const [layout, ownerSegment, materials] = segments;
  if (!isLayout(layout) || !ownerSegment || materials !== MATERIALS_SEGMENT) {
    return { ok: false, reason: 'outside-materials' };
  }

  const rest = segments.slice(3);
  const fileName = rest.length > 0 ? rest[rest.length - 1] : '';
  if (fileName === '') {
    // `.../materials/` or `.../materials/Week 3/`: a console "folder" object.
    return { ok: false, reason: 'folder-marker' };
  }
  if (isMetadataSidecarKey(fileName)) {
    // Our own sidecar: processing it would re-trigger indexing forever.
    return { ok: false, reason: 'metadata-sidecar' };
  }

  const folderSegments = rest.slice(0, -1).filter((segment) => segment.length > 0);
  return {
    ok: true,
    value: {
      key,
      layout,
      ownerSegment,
      folderSegments,
      folderPath: folderSegments.join('/'),
      fileName,
    },
  };
}

/** Decodes and parses the key exactly as an S3 event notification delivers it. */
export function parseS3EventKey(rawKey: string): MaterialKeyParseResult {
  const key = decodeS3EventKey(rawKey);
  if (key === null) {
    return { ok: false, reason: 'invalid-key-encoding' };
  }
  return parseMaterialKey(key);
}

function isLayout(value: string | undefined): value is MaterialKeyLayout {
  return value !== undefined && LAYOUTS.includes(value);
}
