/**
 * Bedrock Knowledge Base metadata sidecar for a Materials document (Tasks 4.6
 * and 4.9).
 *
 * For S3 data sources, Bedrock reads per-document metadata from an object named
 * `<document key>.metadata.json` stored next to the document. The trigger writes
 * one before it starts the sync, so every chunk of the document is tagged with
 * the attributes defined in `src/backend/shared/knowledgeBase/materialMetadata.ts`
 * (the retrieval side reads the same definitions):
 *
 *   - `studentId`  the verified owner (the user-pool `sub`). Every retrieval
 *                  filters on it (`retrieveForStudent`, task 4.9).
 *   - `folderPath` slash-separated folder path, e.g. "Data Structures/Week 3",
 *                  the same form as `FolderNode.path` and the upload's object
 *                  metadata. Files in the Materials root get "/", because
 *                  Bedrock STRING values must be at least one character long.
 *   - `fileName`   the original file name, so citations can render
 *                  "Data Structures > Week 3 > Sorting.pdf".
 *
 * The simplified attribute format stores the values for filtering and citation
 * without mixing them into the embeddings (`includeForEmbedding: false`).
 *
 * Bedrock limits every STRING value to 1 to 2048 characters and the file to
 * 10 KB. A sidecar outside those limits throws {@link SidecarError}, so the
 * file is marked FAILED instead of being indexed without its tags. Real
 * documents stay far below both: S3 keys are at most 1024 bytes, and even a
 * key made only of characters JSON escapes as `\u00XX` serializes to about 6 KB.
 */
import {
  toMetadataFolderPath,
  type MaterialMetadataAttributes,
} from '../shared/knowledgeBase/materialMetadata';
import { METADATA_SIDECAR_SUFFIX } from './s3Key';

export const SIDECAR_CONTENT_TYPE = 'application/json';

/** Bedrock's 10 KB limit for a `.metadata.json` file, read conservatively. */
export const SIDECAR_MAX_BYTES = 10_000;

/** Bedrock's maximum length of a STRING metadata value. */
export const METADATA_STRING_MAX_LENGTH = 2048;

/**
 * The metadata attached to every chunk of a Materials document. `folderPath`
 * is the key's folder path as parsed ("" for the root).
 */
export type MaterialMetadataTags = MaterialMetadataAttributes;

/** The JSON document Bedrock reads from `<document key>.metadata.json`. */
export interface MetadataSidecarDocument {
  metadataAttributes: MaterialMetadataTags;
}

/** The sidecar would be rejected by Bedrock, leaving the document untagged. */
export class SidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarError';
  }
}

/** Key of the sidecar that describes `objectKey` (same folder, suffix appended). */
export function sidecarKeyFor(objectKey: string): string {
  return `${objectKey}${METADATA_SIDECAR_SUFFIX}`;
}

export function buildSidecarDocument(tags: MaterialMetadataTags): MetadataSidecarDocument {
  const { studentId, folderPath, fileName } = tags;
  if (typeof studentId !== 'string' || studentId.trim() === '') {
    throw new SidecarError('studentId must be a non-blank string');
  }
  if (typeof folderPath !== 'string') {
    throw new SidecarError('folderPath must be a string');
  }
  if (typeof fileName !== 'string' || fileName === '') {
    throw new SidecarError('fileName must be a non-empty string');
  }
  const metadataAttributes: MaterialMetadataTags = {
    studentId,
    folderPath: toMetadataFolderPath(folderPath),
    fileName,
  };
  for (const [name, value] of Object.entries(metadataAttributes)) {
    if (value.length > METADATA_STRING_MAX_LENGTH) {
      throw new SidecarError(
        `${name} is ${value.length} characters long; Bedrock allows ${METADATA_STRING_MAX_LENGTH}`
      );
    }
  }
  return { metadataAttributes };
}

export function serializeSidecar(tags: MaterialMetadataTags): string {
  const body = JSON.stringify(buildSidecarDocument(tags));
  const bytes = utf8ByteLength(body);
  if (bytes > SIDECAR_MAX_BYTES) {
    throw new SidecarError(`the sidecar is ${bytes} bytes; Bedrock allows ${SIDECAR_MAX_BYTES}`);
  }
  return body;
}

/** Size of `value` encoded as UTF-8, in bytes. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}
