/**
 * Knowledge Base metadata contract for Materials documents (Tasks 4.6 / 4.9,
 * Requirements 7.9, 14.4).
 *
 * `materialIndexTrigger` writes these attributes into every document's
 * `<key>.metadata.json` sidecar, Bedrock copies them onto each chunk, and the
 * retrieval side (`retrieveForStudent`, the citation helpers) reads them back.
 * Both sides take the names and encodings from this module so they cannot
 * drift apart:
 *
 *   studentId   the verified owner (Cognito user-pool `sub`). The retrieval
 *               isolation filter `{ equals: { key: "studentId", ... } }`
 *               matches on it.
 *   folderPath  the slash-separated folder trail, e.g. "Data Structures/Week 3"
 *               (the `FolderNode.path` form). Files in the Materials root carry
 *               {@link ROOT_FOLDER_PATH} ("/"): Bedrock STRING attribute values
 *               must be 1 to 2048 characters long, so the root cannot be "".
 *               Readers also accept "" (sidecars written before task 4.9).
 *   fileName    the original file name, e.g. "Sorting.pdf".
 *
 * Citations render the trail as "Data Structures > Week 3 > Sorting.pdf".
 *
 * This module is bundled into `materialIndexTrigger`, so it must stay free of
 * retrieval code and of any `@aws-sdk/*` import.
 */

/** Custom metadata attributes attached to every chunk of a Materials document. */
export interface MaterialMetadataAttributes {
  studentId: string;
  folderPath: string;
  fileName: string;
}

/** Attribute names, type-checked against {@link MaterialMetadataAttributes}. */
export const MATERIAL_METADATA_KEYS: {
  readonly [K in keyof MaterialMetadataAttributes]: K;
} = Object.freeze({
  studentId: 'studentId',
  folderPath: 'folderPath',
  fileName: 'fileName',
});

/** Separator inside the `folderPath` attribute (and `FolderNode.path`). */
export const FOLDER_PATH_SEPARATOR = '/';

/** `folderPath` value of a file stored directly in the Materials root. */
export const ROOT_FOLDER_PATH = '/';

/** Separator of the human-readable citation path. */
export const DISPLAY_PATH_SEPARATOR = ' > ';

/** Metadata Bedrock adds to every chunk: the source document's S3 URI. */
export const BEDROCK_SOURCE_URI_KEY = 'x-amz-bedrock-kb-source-uri';

/**
 * Metadata Bedrock adds to PDF chunks (OpenSearch Serverless and Aurora vector
 * stores): the 1-based page the chunk came from.
 */
export const BEDROCK_PAGE_NUMBER_KEY = 'x-amz-bedrock-kb-document-page-number';

/** First key segment of the two Materials object-key layouts. */
export const MATERIALS_KEY_LAYOUTS: readonly string[] = ['private', 'students'];

/** Third key segment under which Materials objects live. */
export const MATERIALS_KEY_AREA = 'materials';

/**
 * Folder names of a slash-separated folder path, root first. Empty segments
 * (the root sentinel "/", "", doubled or trailing slashes) are dropped; every
 * other segment is kept verbatim.
 */
export function folderSegmentsOf(folderPath: string): string[] {
  return folderPath.split(FOLDER_PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * The `folderPath` attribute value for a folder path: the normalised slash
 * form, or {@link ROOT_FOLDER_PATH} for the Materials root. Never empty.
 */
export function toMetadataFolderPath(folderPath: string): string {
  const segments = folderSegmentsOf(folderPath);
  return segments.length === 0 ? ROOT_FOLDER_PATH : segments.join(FOLDER_PATH_SEPARATOR);
}

/** Folder trail for display, e.g. "Data Structures > Week 3" ("" for the root). */
export function formatFolderDisplayPath(folderSegments: readonly string[]): string {
  return folderSegments.filter((segment) => segment.length > 0).join(DISPLAY_PATH_SEPARATOR);
}

/** Full citation path, e.g. "Data Structures > Week 3 > Sorting.pdf". */
export function formatCitationPath(folderSegments: readonly string[], fileName: string): string {
  return [...folderSegments, fileName]
    .filter((part) => part.length > 0)
    .join(DISPLAY_PATH_SEPARATOR);
}

/** A Materials document's place in the folder hierarchy. */
export interface MaterialsDocumentPath {
  folderSegments: string[];
  fileName: string;
}

/**
 * Folder trail and file name of a Materials object key:
 *
 *   private/{cognito-identity-id}/materials/{folders...}/{fileName}
 *   students/{userId}/materials/{folders...}/{fileName}
 *
 * The same layouts `materialIndexTrigger/s3Key.ts` indexes. Returns `null` for
 * keys outside a Materials area and for folder markers (trailing "/").
 */
export function parseMaterialsObjectKey(key: string): MaterialsDocumentPath | null {
  const segments = key.split('/');
  const [layout, owner, area] = segments;
  if (
    layout === undefined ||
    !MATERIALS_KEY_LAYOUTS.includes(layout) ||
    !owner ||
    area !== MATERIALS_KEY_AREA
  ) {
    return null;
  }
  const rest = segments.slice(3);
  const fileName = rest.length > 0 ? rest[rest.length - 1] : '';
  if (fileName === '') {
    return null;
  }
  return {
    folderSegments: rest.slice(0, -1).filter((segment) => segment.length > 0),
    fileName,
  };
}

const S3_URI_PATTERN = /^s3:\/\/([^/]+)\/([\s\S]+)$/;

/**
 * Bucket and key of an `s3://bucket/key` URI, as Bedrock reports document
 * locations. The key is taken verbatim (not percent-decoded).
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = S3_URI_PATTERN.exec(uri);
  return match ? { bucket: match[1], key: match[2] } : null;
}

/** {@link parseMaterialsObjectKey} for an `s3://bucket/key` URI. */
export function parseMaterialsS3Uri(uri: string): MaterialsDocumentPath | null {
  const location = parseS3Uri(uri);
  return location ? parseMaterialsObjectKey(location.key) : null;
}
