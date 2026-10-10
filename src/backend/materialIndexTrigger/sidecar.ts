/**
 * Bedrock Knowledge Base metadata sidecar for a Materials document (Task 4.6).
 *
 * For S3 data sources, Bedrock reads per-document metadata from an object named
 * `<document key>.metadata.json` stored next to the document. The trigger writes
 * one before it starts the sync, so every chunk of the document is tagged with:
 *
 *   - `studentId`  the verified owner (the user-pool `sub`); the retrieval-time
 *                  isolation filter (task 4.9) matches on it.
 *   - `folderPath` slash-separated folder path, e.g. "Data Structures/Week 3"
 *                  (empty for the Knowledge Base root), the same form as
 *                  `FolderNode.path` and the upload's object metadata.
 *   - `fileName`   the original file name, so citations can render
 *                  "Data Structures > Week 3 > Sorting.pdf".
 *
 * The simplified attribute format stores the values for filtering and citation
 * without mixing them into the embeddings. S3 keys are at most 1024 bytes, so
 * the document stays far below Bedrock's 10 KB sidecar limit.
 */
import { METADATA_SIDECAR_SUFFIX } from './s3Key';

export const SIDECAR_CONTENT_TYPE = 'application/json';

/** The metadata attached to every chunk of a Materials document. */
export interface MaterialMetadataTags {
  studentId: string;
  folderPath: string;
  fileName: string;
}

/** The JSON document Bedrock reads from `<document key>.metadata.json`. */
export interface MetadataSidecarDocument {
  metadataAttributes: MaterialMetadataTags;
}

/** Key of the sidecar that describes `objectKey` (same folder, suffix appended). */
export function sidecarKeyFor(objectKey: string): string {
  return `${objectKey}${METADATA_SIDECAR_SUFFIX}`;
}

export function buildSidecarDocument(tags: MaterialMetadataTags): MetadataSidecarDocument {
  return {
    metadataAttributes: {
      studentId: tags.studentId,
      folderPath: tags.folderPath,
      fileName: tags.fileName,
    },
  };
}

export function serializeSidecar(tags: MaterialMetadataTags): string {
  return JSON.stringify(buildSidecarDocument(tags));
}
