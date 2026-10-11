/**
 * Test doubles for the shared Knowledge Base retrieval module (Task 4.9).
 * The retrieval Lambdas' tests (ragOrchestrator, fileSearchHandler, ...) can
 * reuse them. Lives under `__tests__/` so no function build deploys it.
 */
import type { CommandClass } from '../../awsSdk';
import type { BedrockAgentRuntimeSdk, RetrieveCommandInput } from '../bedrockRetriever';
import {
  BEDROCK_SOURCE_URI_KEY,
  MATERIAL_METADATA_KEYS,
  toMetadataFolderPath,
} from '../materialMetadata';
import type {
  KnowledgeBaseResult,
  KnowledgeBaseRetrievalPort,
  KnowledgeBaseRetrieveRequest,
  KnowledgeBaseRetrieveResponse,
  RetrievalLogger,
} from '../ports';

export const TEST_KNOWLEDGE_BASE_ID = 'KB12345678';
export const TEST_BUCKET = 'fmios-materials-storage-dev';
export const TEST_IDENTITY_ID = 'eu-central-1:7d3c1f3e-1111-4222-8333-444455556666';

/**
 * A port that records every request and returns scripted results. Like a
 * mis-configured vector store, it ignores the filter, so tests can check the
 * post-filter on its own.
 */
export class FakeRetrievalPort implements KnowledgeBaseRetrievalPort {
  readonly requests: KnowledgeBaseRetrieveRequest[] = [];

  error: Error | null = null;

  constructor(
    public results: KnowledgeBaseResult[] = [],
    public nextToken: string | null = null
  ) {}

  async retrieve(request: KnowledgeBaseRetrieveRequest): Promise<KnowledgeBaseRetrieveResponse> {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return {
      results: this.results.map((result) => ({ ...result, metadata: { ...result.metadata } })),
      nextToken: this.nextToken,
    };
  }
}

export interface LoggedWarning {
  message: string;
  fields?: Record<string, unknown>;
}

export class RecordingRetrievalLogger implements RetrievalLogger {
  readonly warnings: LoggedWarning[] = [];

  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push({ message, fields });
  }
}

export interface MaterialChunkSpec {
  /** Value of the `studentId` attribute; `null` leaves the attribute out. */
  studentId: string | null;
  folderSegments?: string[];
  fileName?: string;
  text?: string;
  score?: number | null;
  /** Key layout of the source document (default `private`). */
  layout?: 'private' | 'students';
  /** Second key segment (default: the identity id, or `studentId` for `students`). */
  owner?: string;
  /** Only Bedrock's own metadata, as for a document indexed without a sidecar. */
  withoutSidecar?: boolean;
  extraMetadata?: Record<string, unknown>;
}

/** The S3 key a Materials document of `spec` lives under. */
export function materialKey(spec: MaterialChunkSpec): string {
  const layout = spec.layout ?? 'private';
  const owner = spec.owner ?? (layout === 'students' ? spec.studentId ?? 'nobody' : TEST_IDENTITY_ID);
  return [layout, owner, 'materials', ...(spec.folderSegments ?? []), spec.fileName ?? 'Sorting.pdf'].join(
    '/'
  );
}

/**
 * A retrieved chunk of a Materials document, with the metadata the
 * `materialIndexTrigger` sidecar gives it plus Bedrock's source URI.
 */
export function materialChunk(spec: MaterialChunkSpec): KnowledgeBaseResult {
  const folderSegments = spec.folderSegments ?? [];
  const fileName = spec.fileName ?? 'Sorting.pdf';
  const s3Uri = `s3://${TEST_BUCKET}/${materialKey(spec)}`;
  const metadata: Record<string, unknown> = { [BEDROCK_SOURCE_URI_KEY]: s3Uri };
  if (!spec.withoutSidecar) {
    if (spec.studentId !== null) {
      metadata[MATERIAL_METADATA_KEYS.studentId] = spec.studentId;
    }
    metadata[MATERIAL_METADATA_KEYS.folderPath] = toMetadataFolderPath(folderSegments.join('/'));
    metadata[MATERIAL_METADATA_KEYS.fileName] = fileName;
  }
  return {
    text: spec.text ?? `Notes from ${fileName}`,
    s3Uri,
    score: spec.score === undefined ? 0.5 : spec.score,
    metadata: { ...metadata, ...spec.extraMetadata },
  };
}

export interface SentRetrieveCommand {
  name: string;
  input: RetrieveCommandInput;
}

/** A Bedrock Agent Runtime client whose `send` records commands and answers via `respond`. */
export class RecordingRuntimeClient {
  readonly sent: SentRetrieveCommand[] = [];

  constructor(private readonly respond: (input: RetrieveCommandInput) => unknown) {}

  async send(command: unknown): Promise<unknown> {
    const { commandName, input } = command as { commandName: string; input: RetrieveCommandInput };
    this.sent.push({ name: commandName, input });
    const answer = this.respond(input);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
}

/** A fake SDK bag for `createBedrockKnowledgeBaseRetriever`. */
export function recordingRuntimeSdk(
  respond: (input: RetrieveCommandInput) => unknown = () => ({ retrievalResults: [] })
): { client: RecordingRuntimeClient; sdk: BedrockAgentRuntimeSdk } {
  const client = new RecordingRuntimeClient(respond);
  const RetrieveCommand: CommandClass<RetrieveCommandInput> = class {
    readonly commandName = 'RetrieveCommand';

    constructor(readonly input: RetrieveCommandInput) {}
  };
  return { client, sdk: { client, RetrieveCommand } };
}

/** A raw Bedrock `retrievalResults` entry for a chunk (the SDK's response shape). */
export function rawRetrievalResult(chunk: KnowledgeBaseResult): Record<string, unknown> {
  return {
    content: { type: 'TEXT', text: chunk.text },
    location: chunk.s3Uri ? { type: 'S3', s3Location: { uri: chunk.s3Uri } } : { type: 'WEB' },
    metadata: { ...chunk.metadata },
    ...(chunk.score === null ? {} : { score: chunk.score }),
  };
}
