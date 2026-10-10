/**
 * Materials file-upload orchestration (Task 4.5, Requirements 7.3 / 7.4 / 7.5 / 7.7).
 *
 * This module wires together the three concerns of putting a file into the
 * student's hierarchical Materials Knowledge Base:
 *
 *   1. **Validate** the candidate against the shared ingest rules
 *      (`validateUpload` — allowed formats + 20 MB limit, task 4.3). An invalid
 *      file is rejected *before* any S3 write or DynamoDB record is created.
 *   2. **Place** the object inside the student's per-student S3 prefix. Per
 *      task 1.7 and `amplify/backend/storage/fmiosStorage/README.md`, every
 *      student's objects live under `private/{cognito-identity-id}/...`; the
 *      upload helper writes materials at
 *      `private/{identity-id}/materials/{folderPath}/{fileName}`. The identity-id
 *      segment is supplied by Amplify's `private` access level at upload time,
 *      so the storage seam receives the *relative* key
 *      `materials/{folderPath}/{fileName}` and resolves the full key via the
 *      `path` callback (`({ identityId }) => ...`). The absolute key is recorded
 *      on the `MaterialFile` so the `materialIndexTrigger` Lambda (task 4.6) can
 *      recover `{studentId, folderPath}` from the object key.
 *   3. **Record** a `MaterialFile` row (via the AppSync `createMaterialFile`
 *      mutation) with `indexingStatus = PENDING`, so the UI tree view (task 4.2)
 *      can show the file immediately with a Pending indexing badge while the KB
 *      ingestion job (task 4.6) runs asynchronously.
 *
 * Like `src/auth/authService.ts`, the two side-effecting dependencies — the
 * Amplify Storage upload and the AppSync mutation — are hidden behind small,
 * structurally-typed seams ({@link StorageUploader}, {@link MaterialFileCreator})
 * injected via a {@link UploadMaterialDeps} bag. No live AWS backend exists yet,
 * so the default implementations lazily import `aws-amplify/storage` /
 * `aws-amplify/api` only when actually invoked; nothing runs at import time, and
 * every unit test supplies mocks instead. The orchestration itself
 * ({@link uploadMaterial}) is pure control flow and fully testable without a DOM
 * or a network.
 */
import {
  FolderNode,
  PATH_SEPARATOR,
  indexById,
} from './folderHierarchy';
import type { IndexingStatus, MaterialFile } from './MaterialsApp';
import { validateUpload, type UploadCandidate } from './fileValidation';

/** Prefix (under the per-student private root) where Materials objects live. */
export const MATERIALS_KEY_PREFIX = 'materials';

/** The initial indexing status for a freshly uploaded, not-yet-indexed file. */
export const INITIAL_INDEXING_STATUS: IndexingStatus = 'PENDING';

/**
 * A browser `File` structurally satisfies this: it has `name`, `size`, an
 * optional `type`, and is itself acceptable as upload `data`. Declaring the
 * minimal shape keeps the orchestration testable with plain objects (no real
 * `File`/DOM required).
 */
export interface UploadFile extends UploadCandidate {
  /** The file name including extension, e.g. "Sorting.pdf". */
  name: string;
  /** Size in bytes. */
  size: number;
  /** MIME type when the browser determined one. */
  type?: string;
}

/**
 * The relative S3 object key for a file inside a folder, i.e. everything the
 * caller controls *below* the per-student `private/{identity-id}/` root that
 * Amplify prepends. Shape: `materials/{folderPath}/{fileName}` where
 * `folderPath` uses "/" separators (empty for the Knowledge Base root).
 */
export function buildMaterialsKey(folderPath: string, fileName: string): string {
  const segments = [MATERIALS_KEY_PREFIX];
  const trimmedPath = folderPath.trim();
  if (trimmedPath.length > 0) {
    segments.push(trimmedPath);
  }
  segments.push(fileName);
  return segments.join('/');
}

/**
 * The payload passed to the {@link StorageUploader}. `key` is the relative key
 * (see {@link buildMaterialsKey}); `data` is the file; `contentType` and
 * `metadata` mirror what the real `uploadData` call needs so the KB ingestion
 * Lambda can read `{studentId, folderPath}` back off the object.
 */
export interface StorageUploadRequest {
  /** Relative key under the per-student private root. */
  key: string;
  /** The file bytes (a browser `File` satisfies this). */
  data: UploadFile;
  /** MIME content type, when known. */
  contentType?: string;
  /** Object metadata tags carried into Bedrock KB ingestion. */
  metadata: Record<string, string>;
}

/**
 * The result of a storage upload. `fullKey` is the absolute S3 key *including*
 * the resolved `private/{identity-id}/` prefix, which the default implementation
 * reconstructs from the task's reported path. It is persisted as the
 * `MaterialFile.s3Key` so the index trigger can locate the object.
 */
export interface StorageUploadResult {
  /** The absolute object key (with the per-student private prefix). */
  fullKey: string;
}

/**
 * Seam over the Amplify Storage upload. Injected so tests mock it and the
 * production default (below) can lazily bind to `aws-amplify/storage`.
 */
export interface StorageUploader {
  upload(request: StorageUploadRequest): Promise<StorageUploadResult>;
}

/** The subset of `MaterialFile` fields the caller supplies to create a row. */
export interface CreateMaterialFileInput {
  studentId: string;
  folderId: string;
  name: string;
  size: number;
  format: string;
  uploadDate: string;
  indexingStatus: IndexingStatus;
  s3Key: string;
  /** Display folder path (uses " > " separators), e.g. "Data Structures > Week 3". */
  folderPath: string;
}

/**
 * Seam over the AppSync `createMaterialFile` mutation. Returns the created
 * record (echoing the input plus the server-assigned `id`).
 */
export interface MaterialFileCreator {
  create(input: CreateMaterialFileInput): Promise<MaterialFile>;
}

/** Injectable dependency bag for {@link uploadMaterial}. */
export interface UploadMaterialDeps {
  storage: StorageUploader;
  materialFiles: MaterialFileCreator;
  /** Clock seam so tests can pin `uploadDate`. Defaults to `Date.now`. */
  now?: () => Date;
}

/** Arguments describing *what* to upload and *where*. */
export interface UploadMaterialArgs {
  /** The file to upload. */
  file: UploadFile;
  /**
   * Target folder id. `null` (or {@link ROOT}) uploads into the Knowledge Base
   * root — the file is placed directly under `materials/` with an empty path.
   */
  folderId: string | null;
  /** The owning student (used for the record and object metadata). */
  studentId: string;
  /** Flat adjacency-list of the student's folders (task 4.1 shape). */
  folders: readonly FolderNode[];
}

/** A successful upload: the created, PENDING-indexing record. */
export interface UploadMaterialSuccess {
  ok: true;
  file: MaterialFile;
}

/** A rejected upload: a structured, user-renderable reason. */
export interface UploadMaterialFailure {
  ok: false;
  error: string;
}

export type UploadMaterialResult =
  | UploadMaterialSuccess
  | UploadMaterialFailure;

/**
 * Converts a materialized folder path (slash-separated, as stored on
 * `FolderNode.path`) into the human-readable, citation-style display path that
 * `MaterialFile.folderPath` carries (e.g. "Data Structures > Week 3"). An empty
 * input (Knowledge Base root) yields an empty string.
 */
export function toDisplayPath(materializedPath: string): string {
  const trimmed = materializedPath.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed
    .split(PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(' > ');
}

/**
 * Resolves the target folder's materialized path from the flat folder list.
 * Returns the empty string for the Knowledge Base root (`folderId === null`).
 * Throws when a non-null `folderId` does not exist or belongs to another
 * student — a programming / data-integrity error the caller surfaces as a
 * rejected upload.
 */
export function resolveFolderPath(
  folderId: string | null,
  studentId: string,
  folders: readonly FolderNode[]
): string {
  if (folderId === null) {
    return '';
  }
  const folder = indexById(folders).get(folderId);
  if (!folder) {
    throw new Error('Target folder does not exist.');
  }
  if (folder.studentId !== studentId) {
    throw new Error('Target folder belongs to another student.');
  }
  return folder.path;
}

/**
 * Uploads a single file into a Materials folder.
 *
 * Flow (short-circuiting on the first failure):
 *   1. `validateUpload(file)` — reject invalid format / oversize *before* any
 *      side effect (Requirements 7.4, 7.5).
 *   2. Resolve the target folder's materialized path (Requirement 7.3).
 *   3. Compute the relative S3 key `materials/{folderPath}/{fileName}` and
 *      upload via the storage seam with `{studentId, folderPath}` metadata.
 *   4. Create the `MaterialFile` record with `indexingStatus = PENDING`
 *      (Requirement 7.7) and the *absolute* `s3Key` returned by the upload.
 *
 * The storage upload always runs before the record creation so the object
 * exists by the time the row (and thus the KB ingestion) references it. Returns
 * a structured {@link UploadMaterialResult} rather than throwing on the expected
 * validation / resolution failures, so callers can render `error` directly;
 * unexpected storage / mutation rejections propagate so the UI can offer retry.
 */
export async function uploadMaterial(
  args: UploadMaterialArgs,
  deps: UploadMaterialDeps
): Promise<UploadMaterialResult> {
  const { file, folderId, studentId, folders } = args;

  // 1. Validate before any side effect.
  const validation = validateUpload(file);
  if (!validation.valid) {
    return { ok: false, error: validation.error ?? 'Invalid file.' };
  }

  // 2. Resolve the target folder's materialized path.
  let materializedPath: string;
  try {
    materializedPath = resolveFolderPath(folderId, studentId, folders);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not resolve folder.',
    };
  }

  const displayPath = toDisplayPath(materializedPath);
  const relativeKey = buildMaterialsKey(materializedPath, file.name);

  // 3. Upload the object. The folder path carried in metadata uses the
  // slash-separated materialized form so the index trigger can parse it off the
  // key / tags; the record keeps the human-readable display path.
  const uploadResult = await deps.storage.upload({
    key: relativeKey,
    data: file,
    contentType: file.type,
    metadata: { studentId, folderPath: materializedPath },
  });

  // 4. Create the MaterialFile record (indexing starts out PENDING).
  const now = (deps.now ?? (() => new Date()))();
  const created = await deps.materialFiles.create({
    studentId,
    folderId: folderId ?? '',
    name: file.name,
    size: file.size,
    format: file.type ?? '',
    uploadDate: now.toISOString(),
    indexingStatus: INITIAL_INDEXING_STATUS,
    s3Key: uploadResult.fullKey,
    folderPath: displayPath,
  });

  return { ok: true, file: created };
}

/* -------------------------------------------------------------------------- *
 * Default (production) seam implementations.
 *
 * These bind to the real Amplify SDK, but ONLY via lazy dynamic `import()`
 * inside the method bodies — never at module load. That keeps importing this
 * file side-effect-free under jsdom/ts-jest (the `aws-amplify/storage` and
 * `aws-amplify/api` ESM entries run initialization that the test environment
 * cannot execute), exactly the hazard the auth modules guard against. Unit
 * tests inject mocks and never reach this code; it exists so the real
 * MaterialsApp wiring (a later task) can call `uploadMaterial(args,
 * createDefaultUploadDeps())` with no further plumbing.
 * -------------------------------------------------------------------------- */

/**
 * The slice of a generated GraphQL client this module uses. Declared locally so
 * we need not depend on code-generated types that do not exist yet.
 */
interface GraphqlClientLike {
  graphql(options: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<{ data?: Record<string, unknown> }>;
}

/**
 * The `createMaterialFile` mutation document. Kept inline (rather than importing
 * a generated `src/graphql/mutations` that does not exist yet) so this module is
 * self-contained; it can be swapped for the generated document when the API is
 * pushed. Requests exactly the fields that back {@link MaterialFile}.
 */
export const CREATE_MATERIAL_FILE_MUTATION = /* GraphQL */ `
  mutation CreateMaterialFile($input: CreateMaterialFileInput!) {
    createMaterialFile(input: $input) {
      id
      studentId
      folderId
      name
      size
      format
      uploadDate
      indexingStatus
      s3Key
      folderPath
    }
  }
`;

/**
 * Production {@link StorageUploader} backed by Amplify Storage `uploadData`.
 *
 * Uses the v6 `path` form with the per-student `private/{identity-id}/` token so
 * the object lands inside the IAM-enforced prefix from task 1.7. The absolute
 * key (with the resolved identity id) is read back off the completed task's
 * `path` and returned as `fullKey`.
 */
export function createDefaultStorageUploader(): StorageUploader {
  return {
    async upload(request: StorageUploadRequest): Promise<StorageUploadResult> {
      const { uploadData } = await import('aws-amplify/storage');
      const task = uploadData({
        // Resolve the full key inside the student's private prefix. Amplify
        // substitutes the signed-in student's Cognito identity id.
        path: ({ identityId }: { identityId?: string }) =>
          `private/${identityId}/${request.key}`,
        data: request.data as unknown as Blob,
        options: {
          contentType: request.contentType,
          metadata: request.metadata,
        },
      });
      const result = await task.result;
      return { fullKey: result.path };
    },
  };
}

/**
 * Production {@link MaterialFileCreator} backed by the AppSync
 * `createMaterialFile` mutation via a generated Amplify GraphQL client.
 */
export function createDefaultMaterialFileCreator(): MaterialFileCreator {
  return {
    async create(input: CreateMaterialFileInput): Promise<MaterialFile> {
      const { generateClient } = await import('aws-amplify/api');
      const client = generateClient() as unknown as GraphqlClientLike;
      const response = await client.graphql({
        query: CREATE_MATERIAL_FILE_MUTATION,
        variables: { input },
      });
      const created = response.data?.createMaterialFile as
        | MaterialFile
        | undefined;
      if (!created) {
        throw new Error('createMaterialFile returned no record.');
      }
      return created;
    },
  };
}

/**
 * Convenience factory assembling the production {@link UploadMaterialDeps} from
 * the default seams. The real UI wiring calls
 * `uploadMaterial(args, createDefaultUploadDeps())`.
 */
export function createDefaultUploadDeps(): UploadMaterialDeps {
  return {
    storage: createDefaultStorageUploader(),
    materialFiles: createDefaultMaterialFileCreator(),
  };
}
