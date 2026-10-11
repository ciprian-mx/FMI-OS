/**
 * Folder-path citations for Knowledge Base results (Task 4.9, Requirements
 * 7.9, 14.4).
 *
 * Turns a retrieved chunk into a citation naming the full Materials path,
 * "Data Structures > Week 3 > Sorting.pdf", never only a file name or S3 key.
 *
 * The path comes from the chunk's `folderPath` and `fileName` metadata
 * (written by `materialIndexTrigger`). When `folderPath` is missing, e.g. for
 * a document indexed without a sidecar, folders and file name are parsed from
 * the document's S3 URI (`location.s3Location.uri`, else Bedrock's
 * `x-amz-bedrock-kb-source-uri` metadata). A chunk whose path cannot be
 * determined yields no citation rather than a path-less one.
 *
 * Run results through `retrieveForStudent` first: these helpers do not check
 * ownership.
 */
import {
  BEDROCK_PAGE_NUMBER_KEY,
  BEDROCK_SOURCE_URI_KEY,
  MATERIAL_METADATA_KEYS,
  folderSegmentsOf,
  formatCitationPath,
  formatFolderDisplayPath,
  parseMaterialsS3Uri,
  type MaterialsDocumentPath,
} from './materialMetadata';
import type { KnowledgeBaseResult } from './ports';

/** Default maximum excerpt length, in characters (code points). */
export const DEFAULT_EXCERPT_MAX_LENGTH = 300;

/**
 * A citation of Materials content. A superset of the design's `Citation`
 * (`sourceDocumentName`, `folderPath`, `section`, `excerpt`), so it can be
 * returned as-is in `GusQueryOutput.citations`.
 */
export interface MaterialCitation {
  /** File name, e.g. "Sorting.pdf". */
  sourceDocumentName: string;
  /** Folder trail in display form, e.g. "Data Structures > Week 3" ("" for the root). */
  folderPath: string;
  /** Folder names from the root down, e.g. ["Data Structures", "Week 3"]. */
  folderSegments: string[];
  /** Full display path, e.g. "Data Structures > Week 3 > Sorting.pdf". */
  displayPath: string;
  /** Location inside the document, e.g. "Page 3"; "" when unknown. */
  section: string;
  /** The chunk text with whitespace collapsed, shortened to the excerpt length. */
  excerpt: string;
  /** `s3://bucket/key` of the source document, when known. */
  s3Uri: string | null;
  /** Relevance score, when reported. */
  score: number | null;
}

export interface CitationOptions {
  /** Maximum excerpt length in characters; defaults to {@link DEFAULT_EXCERPT_MAX_LENGTH}. */
  excerptMaxLength?: number;
}

/** Where a document's path was read from. */
export type DocumentPathSource = 'metadata' | 's3-uri';

export interface ResolvedDocumentPath extends MaterialsDocumentPath {
  source: DocumentPathSource;
}

/**
 * The folder trail and file name of a chunk's document, or `null` when neither
 * the metadata nor the S3 URI identifies a Materials document.
 *
 * With `folderPath` metadata present, the file name is the `fileName`
 * metadata (else the URI's). Without it, both come from the URI.
 */
export function resolveDocumentPath(
  result: Pick<KnowledgeBaseResult, 'metadata' | 's3Uri'>
): ResolvedDocumentPath | null {
  const metadata = metadataOf(result);
  const uri = sourceUriOf(result, metadata);
  const fromUri = uri === null ? null : parseMaterialsS3Uri(uri);

  const folderPath = metadata[MATERIAL_METADATA_KEYS.folderPath];
  if (typeof folderPath === 'string') {
    const fileName = nonEmptyString(metadata[MATERIAL_METADATA_KEYS.fileName]) ?? fromUri?.fileName;
    if (fileName === undefined) {
      return null;
    }
    return { folderSegments: folderSegmentsOf(folderPath), fileName, source: 'metadata' };
  }
  if (fromUri !== null) {
    return { folderSegments: fromUri.folderSegments, fileName: fromUri.fileName, source: 's3-uri' };
  }
  return null;
}

/** The citation for one chunk, or `null` when its document path is unknown. */
export function toCitation(
  result: KnowledgeBaseResult,
  options: CitationOptions = {}
): MaterialCitation | null {
  return buildCitation(result, excerptMaxLengthOf(options));
}

/** Citations for the chunks whose document path is known, in input order. */
export function toCitations(
  results: readonly KnowledgeBaseResult[],
  options: CitationOptions = {}
): MaterialCitation[] {
  const excerptMaxLength = excerptMaxLengthOf(options);
  const citations: MaterialCitation[] = [];
  for (const result of results) {
    const citation = buildCitation(result, excerptMaxLength);
    if (citation !== null) {
      citations.push(citation);
    }
  }
  return citations;
}

function buildCitation(
  result: KnowledgeBaseResult,
  excerptMaxLength: number
): MaterialCitation | null {
  const path = resolveDocumentPath(result);
  if (path === null) {
    return null;
  }
  const metadata = metadataOf(result);
  return {
    sourceDocumentName: path.fileName,
    folderPath: formatFolderDisplayPath(path.folderSegments),
    folderSegments: [...path.folderSegments],
    displayPath: formatCitationPath(path.folderSegments, path.fileName),
    section: sectionOf(metadata),
    excerpt: excerptOf(typeof result.text === 'string' ? result.text : '', excerptMaxLength),
    s3Uri: sourceUriOf(result, metadata),
    score: typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : null,
  };
}

function excerptMaxLengthOf(options: CitationOptions): number {
  const value = options.excerptMaxLength ?? DEFAULT_EXCERPT_MAX_LENGTH;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('excerptMaxLength must be a non-negative integer');
  }
  return value;
}

function metadataOf(result: Pick<KnowledgeBaseResult, 'metadata'>): Readonly<Record<string, unknown>> {
  const metadata = result?.metadata;
  return typeof metadata === 'object' && metadata !== null ? metadata : {};
}

function sourceUriOf(
  result: Pick<KnowledgeBaseResult, 's3Uri'>,
  metadata: Readonly<Record<string, unknown>>
): string | null {
  return nonEmptyString(result?.s3Uri) ?? nonEmptyString(metadata[BEDROCK_SOURCE_URI_KEY]) ?? null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** "Page N" from Bedrock's page-number metadata (number or numeric string). */
function sectionOf(metadata: Readonly<Record<string, unknown>>): string {
  const raw = metadata[BEDROCK_PAGE_NUMBER_KEY];
  const page =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(page) && page > 0 ? `Page ${page}` : '';
}

/** Whitespace collapsed; cut on a code-point boundary with a trailing ellipsis. */
function excerptOf(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const characters = Array.from(collapsed);
  if (characters.length <= maxLength) {
    return collapsed;
  }
  if (maxLength === 0) {
    return '';
  }
  return `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}
