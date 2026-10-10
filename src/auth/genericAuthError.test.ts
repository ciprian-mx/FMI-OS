// The real `aws-amplify/auth` ESM entry runs OAuth-listener setup at import
// time, which the jsdom/ts-jest environment cannot execute. These tests inject
// a fake AuthClient and never touch the real SDK, so we replace the module with
// inert stubs to keep the import side-effect-free. (Same pattern as
// authService.test.ts.)
jest.mock('aws-amplify/auth', () => ({
  signUp: jest.fn(),
  signIn: jest.fn(),
}));

import fc from 'fast-check';

import {
  AuthClient,
  GENERIC_AUTH_ERROR_MESSAGE,
  loginStudent,
  registerStudent,
} from './authService';

/**
 * Feature: fmi-os
 * Property 1: Generic Authentication Error Messages
 *
 * Task 1.4 — Validates: Requirements 1.3
 *
 * For ANY authentication failure — wrong password, unknown user, unconfirmed
 * account, throttling, network error, or an entirely unrecognized failure —
 * the error surfaced to the user must be the SAME single generic message. The
 * UI must never reveal which field was wrong or whether the account exists, so
 * the system cannot be used to enumerate accounts.
 *
 * We assert this universally: across arbitrary (email, password) pairs and
 * arbitrary rejection reasons injected into the AuthClient seam, the set of
 * distinct messages surfaced by loginStudent / registerStudent collapses to
 * size 1, equal to GENERIC_AUTH_ERROR_MESSAGE.
 */

/**
 * A grab-bag of realistic Cognito failure identifiers plus adversarial inputs:
 * known exception names, throttling, network errors, and arbitrary random
 * strings — all of which must collapse to the identical generic message.
 */
const COGNITO_ERROR_NAMES = [
  'UserNotFoundException',
  'NotAuthorizedException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
  'UsernameExistsException',
  'TooManyRequestsException',
  'LimitExceededException',
  'InvalidParameterException',
  'InvalidPasswordException',
  'CodeMismatchException',
  'ExpiredCodeException',
  'NetworkError',
];

/** Arbitrary that produces a rejection reason an AuthClient call might throw. */
const rejectionArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  // Known / arbitrary error names attached as an Error with a `name`, mirroring
  // how the AWS SDK surfaces Cognito exceptions.
  fc
    .oneof(fc.constantFrom(...COGNITO_ERROR_NAMES), fc.string())
    .map((name) =>
      Object.assign(new Error(`${name}: synthetic failure`), { name })
    ),
  // A plain Error with an arbitrary message and no special name.
  fc.string().map((message) => new Error(message)),
  // Non-Error rejection values (SDKs and runtimes sometimes reject with these).
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
  fc.record({ code: fc.string(), message: fc.string() })
);

/** Credentials generator — any non-empty-ish email/password strings. */
const credentialsArbitrary = fc.record({
  email: fc.string(),
  password: fc.string(),
});

const ITERATIONS = 200;

describe('Property 1: Generic Authentication Error Messages (Requirements 1.3)', () => {
  it('loginStudent surfaces the identical generic message for ANY failure', async () => {
    const surfacedMessages = new Set<string | undefined>();

    await fc.assert(
      fc.asyncProperty(
        credentialsArbitrary,
        rejectionArbitrary,
        async ({ email, password }, reason) => {
          const client: AuthClient = {
            signUp: jest.fn() as AuthClient['signUp'],
            signIn: jest
              .fn()
              .mockRejectedValue(reason) as AuthClient['signIn'],
          };

          const result = await loginStudent(email, password, client);

          surfacedMessages.add(result.error);

          // Never a success on a failure path, and always the generic message —
          // never one that reveals the field or the account's existence.
          expect(result.success).toBe(false);
          expect(result.error).toBe(GENERIC_AUTH_ERROR_MESSAGE);
        }
      ),
      { numRuns: ITERATIONS }
    );

    // The non-enumeration invariant restated as a set: exactly one distinct
    // message ever reaches the user.
    expect(surfacedMessages.size).toBe(1);
    expect([...surfacedMessages]).toEqual([GENERIC_AUTH_ERROR_MESSAGE]);
  });

  it('registerStudent surfaces the identical generic message for ANY failure', async () => {
    const surfacedMessages = new Set<string | undefined>();

    await fc.assert(
      fc.asyncProperty(
        credentialsArbitrary,
        rejectionArbitrary,
        async ({ email, password }, reason) => {
          const client: AuthClient = {
            signUp: jest
              .fn()
              .mockRejectedValue(reason) as AuthClient['signUp'],
            signIn: jest.fn() as AuthClient['signIn'],
          };

          const result = await registerStudent(email, password, client);

          surfacedMessages.add(result.error);

          expect(result.success).toBe(false);
          expect(result.error).toBe(GENERIC_AUTH_ERROR_MESSAGE);
        }
      ),
      { numRuns: ITERATIONS }
    );

    expect(surfacedMessages.size).toBe(1);
    expect([...surfacedMessages]).toEqual([GENERIC_AUTH_ERROR_MESSAGE]);
  });

  it('login and registration failures are mutually indistinguishable', async () => {
    // Cross-surface invariant: an attacker cannot tell a failed login apart
    // from a failed registration either, so the two surfaces must agree on the
    // one generic message for any pair of (possibly different) failures.
    const surfacedMessages = new Set<string | undefined>();

    await fc.assert(
      fc.asyncProperty(
        credentialsArbitrary,
        rejectionArbitrary,
        rejectionArbitrary,
        async ({ email, password }, loginReason, registerReason) => {
          const loginResult = await loginStudent(email, password, {
            signUp: jest.fn() as AuthClient['signUp'],
            signIn: jest
              .fn()
              .mockRejectedValue(loginReason) as AuthClient['signIn'],
          });
          const registerResult = await registerStudent(email, password, {
            signUp: jest
              .fn()
              .mockRejectedValue(registerReason) as AuthClient['signUp'],
            signIn: jest.fn() as AuthClient['signIn'],
          });

          surfacedMessages.add(loginResult.error);
          surfacedMessages.add(registerResult.error);

          expect(loginResult.error).toBe(registerResult.error);
        }
      ),
      { numRuns: ITERATIONS }
    );

    expect(surfacedMessages.size).toBe(1);
    expect([...surfacedMessages]).toEqual([GENERIC_AUTH_ERROR_MESSAGE]);
  });
});
