// The real `aws-amplify/auth` ESM entry runs OAuth-listener setup at import
// time, which the jsdom/ts-jest environment cannot execute. These tests inject
// a fake AuthClient and never touch the real SDK, so we replace the module with
// inert stubs to keep the import side-effect-free.
jest.mock('aws-amplify/auth', () => ({
  signUp: jest.fn(),
  signIn: jest.fn(),
}));

import {
  AuthClient,
  GENERIC_AUTH_ERROR_MESSAGE,
  loginStudent,
  registerStudent,
} from './authService';

/**
 * Task 1.3 — auth service seam (Requirements 1.1, 1.3).
 *
 * These unit tests exercise the generic error handling and the success path by
 * injecting a fake AuthClient, so no live Cognito backend is required. The
 * dedicated property test over arbitrary credential pairs lives in task 1.4.
 */

function makeClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    signUp: jest.fn().mockResolvedValue({ isSignUpComplete: true }),
    signIn: jest.fn().mockResolvedValue({ isSignedIn: true }),
    ...overrides,
  } as AuthClient;
}

describe('registerStudent', () => {
  it('returns success and calls signUp with the email as username', async () => {
    const signUp = jest.fn().mockResolvedValue({ isSignUpComplete: true });
    const client = makeClient({ signUp: signUp as AuthClient['signUp'] });

    const result = await registerStudent('ana@s.unibuc.ro', 'Str0ng!pass', client);

    expect(result).toEqual({ success: true });
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'ana@s.unibuc.ro',
        password: 'Str0ng!pass',
      })
    );
  });

  it('returns the generic error when Cognito rejects (e.g. UsernameExistsException)', async () => {
    const signUp = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('User already exists'), {
          name: 'UsernameExistsException',
        })
      );
    const client = makeClient({ signUp: signUp as AuthClient['signUp'] });

    const result = await registerStudent('ana@s.unibuc.ro', 'pw', client);

    expect(result).toEqual({
      success: false,
      error: GENERIC_AUTH_ERROR_MESSAGE,
    });
  });
});

describe('loginStudent', () => {
  it('returns success when signIn resolves', async () => {
    const signIn = jest.fn().mockResolvedValue({ isSignedIn: true });
    const client = makeClient({ signIn: signIn as AuthClient['signIn'] });

    const result = await loginStudent('ana@s.unibuc.ro', 'Str0ng!pass', client);

    expect(result).toEqual({ success: true });
    expect(signIn).toHaveBeenCalledWith({
      username: 'ana@s.unibuc.ro',
      password: 'Str0ng!pass',
    });
  });

  it.each([
    ['unknown user', 'UserNotFoundException'],
    ['wrong password', 'NotAuthorizedException'],
    ['unconfirmed account', 'UserNotConfirmedException'],
  ])(
    'returns the identical generic error for %s',
    async (_label, errorName) => {
      const signIn = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error(errorName), { name: errorName })
        );
      const client = makeClient({ signIn: signIn as AuthClient['signIn'] });

      const result = await loginStudent('ana@s.unibuc.ro', 'pw', client);

      expect(result).toEqual({
        success: false,
        error: GENERIC_AUTH_ERROR_MESSAGE,
      });
    }
  );
});
