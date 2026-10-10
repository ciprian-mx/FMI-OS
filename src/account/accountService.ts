/**
 * Account Center data layer (Task 3.5, Requirements 6.2 / 6.3).
 *
 * The Account Center panel (`src/components/AccountCenter.tsx`) lets a student
 * edit their display name and manage the Bedrock API key that powers Gus. This
 * module holds everything about those operations that is not UI:
 *
 *   • {@link AuthenticatedStudent} — the profile the panel renders;
 *   • {@link validateDisplayName} — the shared display-name rule, applied by the
 *     panel before saving and again by the service (defence in depth);
 *   • {@link generateApiKey} / {@link hashApiKey} — API-key material helpers;
 *   • {@link AccountService} — the injectable seam over the profile and API-key
 *     mutations, with {@link createAccountService} as the production default.
 *
 * API-key model. The `Student` GraphQL model stores only `apiKeyHash`; the raw
 * key is never persisted (design.md — Security Considerations: "Bedrock API
 * keys hashed in DynamoDB; regeneration invalidates old key immediately").
 * Consequently:
 *   - regenerating creates a fresh high-entropy key, stores its SHA-256 hash
 *     (overwriting — and therefore immediately invalidating — the previous
 *     hash) and returns the raw key exactly once, so the panel can show it;
 *   - an existing key can never be displayed again, only reported as present;
 *   - deleting clears the hash.
 * The key carries 256 bits of CSPRNG entropy, so an unsalted SHA-256 digest is
 * sufficient at rest (the usual approach for API tokens); a slow password hash
 * would add nothing.
 *
 * Like `src/materials/uploadMaterial.ts`, the default implementation reaches
 * Amplify only through a lazy `import('aws-amplify/api')` inside the request
 * path — never at module load — so importing this module (as the panel does) is
 * side-effect free under jsdom/ts-jest. No `regenerateApiKey` Lambda exists yet,
 * so the default generates the key in the browser with the Web Crypto CSPRNG
 * and writes only its hash through the owner-scoped `updateStudent` mutation; a
 * server-side implementation can later replace it behind the same interface.
 */

/* -------------------------------------------------------------------------- *
 * Profile
 * -------------------------------------------------------------------------- */

/**
 * The signed-in student as the Account Center sees them. Derived from the
 * owner-scoped `Student` record (`amplify/backend/api/fmios/schema.graphql`).
 */
export interface AuthenticatedStudent {
  /** The student's `Student` record id. */
  id: string;
  /** University email address. Shown read-only. */
  email: string;
  /** Editable display name; `null` / absent until the student sets one. */
  displayName?: string | null;
  /**
   * Whether a Bedrock API key is configured, i.e. the `Student` record has an
   * `apiKeyHash`. The hash itself stays out of the UI, and the raw key cannot be
   * recovered after it is first shown.
   */
  hasApiKey: boolean;
}

/** Longest display name accepted, in UTF-16 code units (matches `maxLength`). */
export const MAX_DISPLAY_NAME_LENGTH = 50;

/** The user-facing display-name validation messages. */
export const DISPLAY_NAME_ERRORS = {
  required: "Display name can't be empty.",
  tooLong: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
  invalidCharacters: "Display name can't contain line breaks or control characters.",
} as const;

/** Outcome of {@link validateDisplayName}. */
export type DisplayNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** True when `value` contains a C0/C1 control character (tab, newline, DEL…). */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates and normalizes a display name. Surrounding whitespace is trimmed;
 * the result must be non-empty, at most {@link MAX_DISPLAY_NAME_LENGTH}
 * characters, and free of control characters. On success `value` is the
 * trimmed name to persist.
 */
export function validateDisplayName(raw: string): DisplayNameValidation {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: DISPLAY_NAME_ERRORS.required };
  }
  if (hasControlCharacters(value)) {
    return { ok: false, error: DISPLAY_NAME_ERRORS.invalidCharacters };
  }
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, error: DISPLAY_NAME_ERRORS.tooLong };
  }
  return { ok: true, value };
}

/* -------------------------------------------------------------------------- *
 * API key material
 * -------------------------------------------------------------------------- */

/** Prefix that makes FMI OS keys recognisable (e.g. to secret scanners). */
export const API_KEY_PREFIX = 'fmios_';

/** Bytes of CSPRNG output per key: 256 bits of entropy. */
export const API_KEY_RANDOM_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The ambient Web Crypto implementation; throws where none exists. */
function ambientCrypto(): Crypto {
  if (typeof crypto === 'undefined') {
    throw new Error('Web Crypto is not available in this environment.');
  }
  return crypto;
}

/**
 * Generates a new raw API key: {@link API_KEY_PREFIX} followed by
 * {@link API_KEY_RANDOM_BYTES} CSPRNG bytes as lowercase hex (70 characters in
 * total). `random` defaults to the ambient Web Crypto; inject one in tests.
 */
export function generateApiKey(
  random: Pick<Crypto, 'getRandomValues'> = ambientCrypto()
): string {
  const bytes = new Uint8Array(API_KEY_RANDOM_BYTES);
  random.getRandomValues(bytes);
  return `${API_KEY_PREFIX}${toHex(bytes)}`;
}

/**
 * The at-rest form of an API key: the lowercase hex SHA-256 digest of its UTF-8
 * bytes. `subtle` defaults to the ambient Web Crypto, which browsers only
 * expose in secure contexts (HTTPS / localhost).
 */
export async function hashApiKey(
  apiKey: string,
  subtle: Pick<SubtleCrypto, 'digest'> = ambientCrypto().subtle
): Promise<string> {
  if (!subtle) {
    throw new Error('SubtleCrypto is unavailable; a secure context is required.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return toHex(new Uint8Array(digest));
}

/* -------------------------------------------------------------------------- *
 * Service seam
 * -------------------------------------------------------------------------- */

/**
 * Profile and API-key operations behind the Account Center. Every method
 * rejects on failure so the panel can show a retryable error.
 */
export interface AccountService {
  /** Persists a new display name (validated and trimmed). */
  updateDisplayName(studentId: string, displayName: string): Promise<void>;
  /**
   * Replaces the student's API key, immediately invalidating the previous one,
   * and resolves with the new raw key. This is the only time the raw key is
   * available; only its hash is stored.
   */
  regenerateApiKey(studentId: string): Promise<string>;
  /** Removes the student's API key (clears the stored hash). */
  deleteApiKey(studentId: string): Promise<void>;
}

/** A GraphQL request as sent through the {@link GraphqlRequester} seam. */
export interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** The slice of a GraphQL response this module reads. */
export interface GraphqlResponse {
  data?: Record<string, unknown> | null;
}

/** Sends one GraphQL operation. Defaults to a lazily created Amplify client. */
export type GraphqlRequester = (request: GraphqlRequest) => Promise<GraphqlResponse>;

/** Injectable dependencies for {@link createAccountService}. */
export interface AccountServiceDeps {
  /** GraphQL transport. Defaults to Amplify's `generateClient().graphql`. */
  graphql?: GraphqlRequester;
  /** Raw key generator. Defaults to {@link generateApiKey}. */
  generateKey?: () => string;
  /** Key hasher. Defaults to {@link hashApiKey}. */
  hashKey?: (apiKey: string) => Promise<string>;
}

/**
 * The owner-scoped `updateStudent` mutation (generated by the `@model` on
 * `Student`). Kept inline, like `CREATE_MATERIAL_FILE_MUTATION`, because no
 * generated `src/graphql` documents exist yet.
 */
export const UPDATE_STUDENT_MUTATION = /* GraphQL */ `
  mutation UpdateStudent($input: UpdateStudentInput!) {
    updateStudent(input: $input) {
      id
    }
  }
`;

interface GraphqlClientLike {
  graphql(request: GraphqlRequest): Promise<GraphqlResponse>;
}

/** Production transport; binds to Amplify only when a request is made. */
const amplifyGraphql: GraphqlRequester = async (request) => {
  const { generateClient } = await import('aws-amplify/api');
  const client = generateClient() as unknown as GraphqlClientLike;
  return client.graphql(request);
};

/**
 * Builds an {@link AccountService}. With no arguments it is the production
 * implementation (Amplify GraphQL + Web Crypto); tests inject `deps`.
 */
export function createAccountService(deps: AccountServiceDeps = {}): AccountService {
  const graphql = deps.graphql ?? amplifyGraphql;
  const generateKey = deps.generateKey ?? (() => generateApiKey());
  const hashKey = deps.hashKey ?? ((apiKey: string) => hashApiKey(apiKey));

  const updateStudent = async (input: Record<string, unknown>): Promise<void> => {
    const response = await graphql({ query: UPDATE_STUDENT_MUTATION, variables: { input } });
    if (!response.data?.updateStudent) {
      throw new Error('updateStudent returned no record.');
    }
  };

  return {
    async updateDisplayName(studentId, displayName) {
      const result = validateDisplayName(displayName);
      if (!result.ok) {
        throw new Error(result.error);
      }
      await updateStudent({ id: studentId, displayName: result.value });
    },

    async regenerateApiKey(studentId) {
      const apiKey = generateKey();
      const apiKeyHash = await hashKey(apiKey);
      // Only the hash leaves the browser; overwriting it revokes the old key.
      await updateStudent({ id: studentId, apiKeyHash });
      return apiKey;
    },

    async deleteApiKey(studentId) {
      await updateStudent({ id: studentId, apiKeyHash: null });
    },
  };
}
