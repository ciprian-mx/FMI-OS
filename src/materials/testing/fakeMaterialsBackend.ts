/**
 * In-memory stand-in for the Materials stores (AppSync rows + S3 objects) used
 * by the `folderService` tests (Task 4.1). Not imported by the app.
 *
 * - The `byStudent` lists return the rows whose `studentId` matches, like the
 *   DynamoDB GSI; `listFoldersByParent` returns every student's children of the
 *   parent (no owner filter), so the service's own filtering is exercised.
 *   `leakForeignRows` makes the `byStudent` lists return every row, to model a
 *   misconfigured API.
 * - `copy` fails when the source object is missing (S3 `NoSuchKey`); `remove`
 *   and the deletes are idempotent; updates of missing rows fail (AppSync's
 *   conditional update).
 * - Every write and object call gets an ordinal. Calls whose ordinal is in
 *   `failAt`, or that `failWhen` matches, throw instead of taking effect.
 *   `trace` lists the calls that took effect, `failedCalls` the injected
 *   failures.
 */
import type { FolderNode } from '../folderHierarchy';
import type {
  CreateFolderNodeInput,
  MaterialsDataStore,
  MaterialsObjectStore,
  UpdateFolderNodeInput,
  UpdateMaterialFileInput,
} from '../folderService';
import type { MaterialFile } from '../MaterialsApp';

export interface BackendSnapshot {
  folders: FolderNode[];
  files: MaterialFile[];
  objects: [string, string][];
}

export class FakeMaterialsBackend implements MaterialsDataStore, MaterialsObjectStore {
  readonly folders = new Map<string, FolderNode>();

  readonly files = new Map<string, MaterialFile>();

  /** S3 key -> object content. */
  readonly objects = new Map<string, string>();

  /** Side effects that took effect, in order. */
  readonly trace: string[] = [];

  /** Calls that failed because of an injected fault. */
  readonly failedCalls: string[] = [];

  /** Inputs of the successful updates, in order. */
  readonly folderUpdates: UpdateFolderNodeInput[] = [];

  readonly fileUpdates: UpdateMaterialFileInput[] = [];

  readonly folderCreates: CreateFolderNodeInput[] = [];

  /** Ordinals (0-based, over every write / object call) that fail. */
  failAt = new Set<number>();

  /** Fails every call whose trace entry it matches. */
  failWhen: ((entry: string) => boolean) | null = null;

  leakForeignRows = false;

  private calls = 0;

  private createdFolders = 0;

  addFolder(folder: FolderNode): this {
    this.folders.set(folder.id, { ...folder });
    return this;
  }

  /** Adds the row and, unless `withObject` is false, its object. */
  addFile(file: MaterialFile, withObject = true): this {
    this.files.set(file.id, { ...file });
    if (withObject) {
      this.objects.set(file.s3Key, `content of ${file.id}`);
    }
    return this;
  }

  /** Clears the fault injection and restarts the call ordinals. */
  clearFaults(): void {
    this.failAt = new Set();
    this.failWhen = null;
    this.calls = 0;
  }

  /** A sorted, deep copy of the whole state, for comparisons. */
  snapshot(): BackendSnapshot {
    return {
      folders: [...this.folders.values()].map((folder) => ({ ...folder })).sort(byId),
      files: [...this.files.values()].map((file) => ({ ...file })).sort(byId),
      objects: [...this.objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  }

  /* ------------------------------ data store ------------------------------ */

  async listFoldersByStudent(studentId: string): Promise<FolderNode[]> {
    return [...this.folders.values()]
      .filter((folder) => this.leakForeignRows || folder.studentId === studentId)
      .map((folder) => ({ ...folder }));
  }

  async listFoldersByParent(parentId: string): Promise<FolderNode[]> {
    return [...this.folders.values()]
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => ({ ...folder }));
  }

  async listFilesByStudent(studentId: string): Promise<MaterialFile[]> {
    return [...this.files.values()]
      .filter((file) => this.leakForeignRows || file.studentId === studentId)
      .map((file) => ({ ...file }));
  }

  async createFolder(input: CreateFolderNodeInput): Promise<FolderNode> {
    this.call(`createFolder ${input.name}`);
    this.createdFolders += 1;
    const folder: FolderNode = {
      id: `created-${this.createdFolders}`,
      studentId: input.studentId,
      name: input.name,
      parentId: input.parentId ?? null,
      path: input.path,
      createdDate: input.createdDate,
    };
    this.folderCreates.push({ ...input });
    this.folders.set(folder.id, folder);
    return { ...folder };
  }

  async updateFolder(input: UpdateFolderNodeInput): Promise<FolderNode> {
    this.call(`updateFolder ${input.id}`);
    const folder = this.folders.get(input.id);
    if (!folder) {
      throw new Error(`ConditionalCheckFailedException: folder ${input.id}`);
    }
    Object.assign(folder, definedFields({ name: input.name, parentId: input.parentId, path: input.path }));
    this.folderUpdates.push({ ...input });
    return { ...folder };
  }

  async deleteFolder(id: string): Promise<void> {
    this.call(`deleteFolder ${id}`);
    this.folders.delete(id);
  }

  async updateFile(input: UpdateMaterialFileInput): Promise<MaterialFile> {
    this.call(`updateFile ${input.id}`);
    const file = this.files.get(input.id);
    if (!file) {
      throw new Error(`ConditionalCheckFailedException: file ${input.id}`);
    }
    Object.assign(
      file,
      definedFields({
        name: input.name,
        folderId: input.folderId,
        folderPath: input.folderPath,
        s3Key: input.s3Key,
        indexingStatus: input.indexingStatus,
      })
    );
    this.fileUpdates.push({ ...input });
    return { ...file };
  }

  async deleteFile(id: string): Promise<void> {
    this.call(`deleteFile ${id}`);
    this.files.delete(id);
  }

  /* ----------------------------- object store ----------------------------- */

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    this.call(`copy ${sourceKey} -> ${destinationKey}`, () => {
      if (!this.objects.has(sourceKey)) {
        throw new Error(`NoSuchKey: ${sourceKey}`);
      }
    });
    this.objects.set(destinationKey, this.objects.get(sourceKey) as string);
  }

  async remove(key: string): Promise<void> {
    this.call(`remove ${key}`);
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    this.call(`exists ${key}`);
    return this.objects.has(key);
  }

  /** Counts the call, throws an injected fault or a precondition error, else records it. */
  private call(entry: string, precondition?: () => void): void {
    const ordinal = this.calls;
    this.calls += 1;
    if (this.failAt.has(ordinal) || (this.failWhen !== null && this.failWhen(entry))) {
      this.failedCalls.push(entry);
      throw new Error(`Injected failure: ${entry}`);
    }
    precondition?.();
    this.trace.push(entry);
  }
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The fields of a partial update that are set (`null` counts: it clears `parentId`). */
function definedFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
