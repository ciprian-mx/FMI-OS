/**
 * Thin, mockable abstraction over Amplify Auth (Cognito) for registration and
 * login.
 *
 * Task 1.3 (Requirements 1.1, 1.3): the registration and login pages talk to
 * Cognito exclusively through this module. Isolating the Amplify calls here
 * gives us two things:
 *
 *  1. A single seam the UI tests can mock (no live Cognito backend exists yet —
 *     `src/aws-exports.ts` is a placeholder, see amplifyConfig.ts).
 *  2. A single place that converts every Cognito failure into a GENERIC,
 *     non-enumerating error message. The UI must never reveal whether a given
 *     email exists or which field was wrong (Requirement 1.3), so the raw
 *     Amplify/Cognito error is deliberately swallowed and replaced here.
 *
 * The registration email-domain rule is NOT duplicated here; callers validate
 * the university domain up front via the shared `validateUniversityEmail`
 * utility (src/auth/universityEmail.ts).
 */
import { signIn, signUp } from 'aws-amplify/auth';

/**
 * The single generic authentication error surfaced to the user for ANY
 * credential/authentication failure. Identical for login and registration so
 * the UI never leaks which field (or whether an account) was the cause.
 *
 * Requirement 1.3: "display a generic error message without revealing which
 * field caused the failure."
 */
export const GENERIC_AUTH_ERROR_MESSAGE = 'Email or password is incorrect.';

/** Structured outcome of a sign-up or sign-in attempt. */
export interface AuthActionResult {
  /** True when the underlying Amplify call resolved successfully. */
  success: boolean;
  /**
   * Present only when `success` is false. Always the generic, non-enumerating
   * message so the caller can render it directly without further processing.
   */
  error?: string;
}

/**
 * Minimal surface of the Amplify auth calls this module depends on. Declaring
 * it lets tests inject fakes without importing the real SDK and keeps the
 * production wiring (the default argument below) in one spot.
 */
export interface AuthClient {
  signUp: typeof signUp;
  signIn: typeof signIn;
}

const defaultClient: AuthClient = { signUp, signIn };

/**
 * Registers a new student with Cognito using their university email as the
 * username.
 *
 * Domain validation is the caller's responsibility (shared
 * `validateUniversityEmail`); this function assumes the email already passed
 * that gate and focuses on the Cognito call plus generic error handling.
 *
 * Any failure — email already taken, weak password, network error, Cognito
 * policy rejection — collapses to {@link GENERIC_AUTH_ERROR_MESSAGE} so the UI
 * cannot be used to enumerate accounts.
 */
export async function registerStudent(
  email: string,
  password: string,
  client: AuthClient = defaultClient
): Promise<AuthActionResult> {
  try {
    await client.signUp({
      username: email,
      password,
      options: {
        userAttributes: { email },
      },
    });
    return { success: true };
  } catch {
    return { success: false, error: GENERIC_AUTH_ERROR_MESSAGE };
  }
}

/**
 * Authenticates an existing student against Cognito.
 *
 * As with registration, every failure path — wrong password, unknown user,
 * unconfirmed account, throttling, network error — returns the same generic
 * message, so an attacker cannot distinguish "no such user" from "wrong
 * password" (Requirement 1.3).
 */
export async function loginStudent(
  email: string,
  password: string,
  client: AuthClient = defaultClient
): Promise<AuthActionResult> {
  try {
    await client.signIn({ username: email, password });
    return { success: true };
  } catch {
    return { success: false, error: GENERIC_AUTH_ERROR_MESSAGE };
  }
}
