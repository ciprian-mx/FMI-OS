import React, { useState } from 'react';
import {
  AuthClient,
  GENERIC_AUTH_ERROR_MESSAGE,
  loginStudent,
} from './authService';

/**
 * Login page (Task 1.3, Requirements 1.1 & 1.3).
 *
 * Authenticates the student against Cognito via Amplify Auth (through the
 * `loginStudent` seam). On ANY authentication failure the component shows a
 * single generic message — "Email or password is incorrect." — never revealing
 * whether the email exists or which field was wrong (Requirement 1.3).
 *
 * Unlike registration, login does NOT apply the university-domain check: a
 * non-university email simply cannot have an account, so it fails
 * authentication and collapses into the same generic error. Re-checking the
 * domain here would leak information (distinguishing "wrong domain" from "wrong
 * credentials"), which is exactly what Requirement 1.3 forbids.
 *
 * The component is self-contained and exportable so routing (task 1.5) can
 * mount it and wire the post-login transition via `onLoggedIn`.
 */
export interface LoginPageProps {
  /** Called after a successful Cognito sign-in. */
  onLoggedIn?: (email: string) => void;
  /** Invoked when the student chooses to go to the registration screen. */
  onNavigateToRegister?: () => void;
  /**
   * Optional auth client override, primarily for tests. Production uses the
   * default Amplify-backed client inside `loginStudent`.
   */
  authClient?: AuthClient;
}

type Status = 'idle' | 'submitting';

const LoginPage: React.FC<LoginPageProps> = ({
  onLoggedIn,
  onNavigateToRegister,
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

    // Guard against empty submissions with the SAME generic message used for a
    // rejected authentication, so an observer cannot distinguish "field blank"
    // from "credentials wrong".
    if (email.length === 0 || password.length === 0) {
      setError(GENERIC_AUTH_ERROR_MESSAGE);
      return;
    }

    setStatus('submitting');
    const result = await loginStudent(email, password, authClient);
    setStatus('idle');

    if (result.success) {
      onLoggedIn?.(email);
      return;
    }

    setError(result.error ?? GENERIC_AUTH_ERROR_MESSAGE);
  };

  return (
    <section className="auth-page" data-testid="login-page">
      <h1>Log in to FMI OS</h1>

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
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isSubmitting}
            required
          />
        </label>

        {error !== null && (
          <p className="auth-form__error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>

      {onNavigateToRegister && (
        <button
          type="button"
          className="auth-page__link"
          onClick={onNavigateToRegister}
          disabled={isSubmitting}
        >
          Need an account? Register
        </button>
      )}
    </section>
  );
};

export default LoginPage;
