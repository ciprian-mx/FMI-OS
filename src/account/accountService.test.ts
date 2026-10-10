/**
 * @jest-environment node
 */
// Node supplies real Web Crypto (getRandomValues + SubtleCrypto) and
// TextEncoder here; jsdom has no SubtleCrypto. `aws-amplify/api` is replaced by
// an inert stub so the default (lazily imported) transport can be exercised.
jest.mock('aws-amplify/api', () => ({ generateClient: jest.fn() }));

import { generateClient } from 'aws-amplify/api';
import {
  API_KEY_PREFIX,
  DISPLAY_NAME_ERRORS,
  MAX_DISPLAY_NAME_LENGTH,
  UPDATE_STUDENT_MUTATION,
  createAccountService,
  generateApiKey,
  hashApiKey,
  validateDisplayName,
  type GraphqlRequest,
  type GraphqlResponse,
} from './accountService';

/**
 * Task 3.5 — Account Center data layer (Requirements 6.2, 6.3).
 *
 * Display-name validation, API-key generation / hashing with the real Web
 * Crypto implementation, and the `updateStudent` calls the service makes. The
 * GraphQL transport is injected (or the Amplify module stubbed), so no backend
 * is touched.
 */

const KEY_PATTERN = /^fmios_[0-9a-f]{64}$/;

function fakeGraphql(
  response: GraphqlResponse = { data: { updateStudent: { id: 'student-1' } } }
) {
  return jest.fn<Promise<GraphqlResponse>, [GraphqlRequest]>().mockResolvedValue(response);
}

describe('validateDisplayName', () => {
  it('accepts a name and trims surrounding whitespace', () => {
    expect(validateDisplayName('  Ana Maria  ')).toEqual({ ok: true, value: 'Ana Maria' });
  });

  it.each(['', '   '])('rejects an empty name (%j)', (raw) => {
    expect(validateDisplayName(raw)).toEqual({ ok: false, error: DISPLAY_NAME_ERRORS.required });
  });

  it('accepts exactly the maximum length and rejects anything longer', () => {
    const longest = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH);
    expect(validateDisplayName(longest)).toEqual({ ok: true, value: longest });
    expect(validateDisplayName(`${longest}a`)).toEqual({
      ok: false,
      error: DISPLAY_NAME_ERRORS.tooLong,
    });
  });

  it.each(['Ana\nMaria', 'Ana\tMaria', 'Ana\u0000'])(
    'rejects control characters (%j)',
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({
        ok: false,
        error: DISPLAY_NAME_ERRORS.invalidCharacters,
      });
    }
  );
});

describe('API key material', () => {
  it('builds a prefixed hex key from 32 random bytes', () => {
    const random = {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab),
    } as unknown as Pick<Crypto, 'getRandomValues'>;

    expect(generateApiKey(random)).toBe(`${API_KEY_PREFIX}${'ab'.repeat(32)}`);
  });

  it('draws fresh CSPRNG bytes for every key by default', () => {
    const keys = Array.from({ length: 20 }, () => generateApiKey());

    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((key) => expect(key).toMatch(KEY_PATTERN));
  });

  it('hashes a key as hex SHA-256', async () => {
    await expect(hashApiKey('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('createAccountService', () => {
  it('saves the trimmed display name with updateStudent', async () => {
    const graphql = fakeGraphql();

    await createAccountService({ graphql }).updateDisplayName('student-1', '  Ana Maria ');

    expect(graphql).toHaveBeenCalledWith({
      query: UPDATE_STUDENT_MUTATION,
      variables: { input: { id: 'student-1', displayName: 'Ana Maria' } },
    });
  });

  it('rejects an invalid display name without calling the API', async () => {
    const graphql = fakeGraphql();

    await expect(
      createAccountService({ graphql }).updateDisplayName('student-1', '   ')
    ).rejects.toThrow(DISPLAY_NAME_ERRORS.required);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('regenerates a key: stores only its SHA-256 hash and returns the raw key', async () => {
    const graphql = fakeGraphql();

    const apiKey = await createAccountService({ graphql }).regenerateApiKey('student-1');

    expect(apiKey).toMatch(KEY_PATTERN);
    expect(graphql).toHaveBeenCalledTimes(1);
    const [request] = graphql.mock.calls[0];
    expect(request).toEqual({
      query: UPDATE_STUDENT_MUTATION,
      variables: { input: { id: 'student-1', apiKeyHash: await hashApiKey(apiKey) } },
    });
    expect(JSON.stringify(request)).not.toContain(apiKey);
  });

  it('deletes the key by clearing the stored hash', async () => {
    const graphql = fakeGraphql();

    await createAccountService({ graphql }).deleteApiKey('student-1');

    expect(graphql).toHaveBeenCalledWith({
      query: UPDATE_STUDENT_MUTATION,
      variables: { input: { id: 'student-1', apiKeyHash: null } },
    });
  });

  it('rejects when updateStudent returns no record', async () => {
    const graphql = fakeGraphql({ data: { updateStudent: null } });

    await expect(createAccountService({ graphql }).deleteApiKey('student-1')).rejects.toThrow(
      'updateStudent returned no record.'
    );
  });

  it('uses the Amplify GraphQL client by default, loaded on first use', async () => {
    const graphql = fakeGraphql();
    (generateClient as jest.Mock).mockReturnValue({ graphql });

    const service = createAccountService();
    expect(generateClient).not.toHaveBeenCalled();

    await service.deleteApiKey('student-1');

    expect(generateClient).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith({
      query: UPDATE_STUDENT_MUTATION,
      variables: { input: { id: 'student-1', apiKeyHash: null } },
    });
  });
});
