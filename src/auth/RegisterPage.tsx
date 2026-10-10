import React, { useState } from 'react';
import {
  allowedDomainsMessage,
  validateUniversityEmail,
} from './universityEmail';
import {
  AuthClient,
  GENERIC_AUTH_ERROR_MESSAGE,
  registerStudent,
} from './authService';

/**
 * Registration page (Task 1.3, Requirements 1.1 & 1.3).
 *
 * Flow:
 *  1. Student enters a university email + password.
 *  2. Client-side the email domain is validated with the SHARED
 *     `validateUniversityEmail` utility — the same rule the Cognito pre-sign-up
 *     Lambda enforces, so the two never drift. (No domain rule is duplicated
 *     here.)
 *  3. On a valid domain, `registerStudent` calls Cognito via Amplify Auth.
 *  4. Any Cognito failure surfaces as a single GENERIC message so registration
 *     cannot be used to probe which emails already exist (Requirement 1.3).
 *
 * The component is self-contained and exportable: routing (task 1.5) can mount
 * it directly, and `onRegistered`/`onNavigateToLogin` let a parent wire the
 * post-registration transition (e.g. to the boot animation or login screen)
 * without this component knowing about the router.
 */
export interface RegisterPageProps {
  /** Called after a successful Cognito sign-up. */
  onRegistered?: (email: string) => void;
  /** Invoked when the student chooses to go to the login screen instead. */
  onNavigateToLogin?: () => void;
  /**
   * Optional auth client override, primarily for tests. Production uses the
   * default Amplify-backed client inside `registerStudent`.
   */
  authClient?: AuthClient;
}

type Status = 'idle' | 'submitting';

const RegisterPage: React.FC<RegisterPageProps> = ({
  onRegistered,
  onNavigateToLogin,
  authClient,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');

  const isSubmitting = status === 'submitting';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    // Shared university-domain gate (client side). Server side enforces the
    // identical rule in the Cognito pre-sign-up Lambda.
    const emailCheck = validateUniversityEmail(email);
    if (!emailCheck.valid) {
      setError(emailCheck.error ?? allowedDomainsMessage());
      return;
    }

    if (password.length === 0) {
      // Keep this generic too — do not hint at password policy specifics here;
      // Cognito's own policy enforcement is reflected via the generic result.
      setError(GENERIC_AUTH_ERROR_MESSAGE);
      return;
    }

    setStatus('submitting');
    const result = await registerStudent(email, password, authClient);
    setStatus('idle');

    if (result.success) {
      onRegistered?.(email);
      return;
    }

    setError(result.error ?? GENERIC_AUTH_ERROR_MESSAGE);
  };

  return (
    <section className="auth-page" data-testid="register-page">
      <h1>Create your FMI OS account</h1>
      <p className="auth-page__hint">{allowedDomainsMessage()}</p>

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <label className="auth-form__field">
          <span>University email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isSubmitting}
            required
          />
        </label>

        <label className="auth-form__field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isSubmitting}
            required
          />
        </label>

        {error !== null && (
          <p className="auth-form__error" role="alert" data-testid="register-error">
            {error}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      {onNavigateToLogin && (
        <button
          type="button"
          className="auth-page__link"
          onClick={onNavigateToLogin}
          disabled={isSubmitting}
        >
          Already have an account? Log in
        </button>
      )}
    </section>
  );
};

export default RegisterPage;
