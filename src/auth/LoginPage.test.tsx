// Replace the real Amplify auth module (its import-time OAuth-listener setup
// breaks under jsdom/ts-jest). Tests inject a fake AuthClient, so inert stubs
// are sufficient.
jest.mock('aws-amplify/auth', () => ({
  signUp: jest.fn(),
  signIn: jest.fn(),
}));

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from './LoginPage';
import { AuthClient, GENERIC_AUTH_ERROR_MESSAGE } from './authService';

/**
 * Task 1.3 — LoginPage (Requirements 1.1, 1.3).
 *
 * Amplify auth is stubbed via an injected AuthClient; no live Cognito backend
 * is required.
 */

function makeClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    signUp: jest.fn().mockResolvedValue({ isSignUpComplete: true }),
    signIn: jest.fn().mockResolvedValue({ isSignedIn: true }),
    ...overrides,
  } as AuthClient;
}

describe('LoginPage', () => {
  it('authenticates and notifies on valid credentials', async () => {
    const user = userEvent.setup();
    const signIn = jest.fn().mockResolvedValue({ isSignedIn: true });
    const onLoggedIn = jest.fn();
    const client = makeClient({ signIn: signIn as AuthClient['signIn'] });

    render(<LoginPage authClient={client} onLoggedIn={onLoggedIn} />);

    await user.type(screen.getByLabelText(/university email/i), 'ana@s.unibuc.ro');
    await user.type(screen.getByLabelText(/password/i), 'Str0ng!pass');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn).toHaveBeenCalledWith({
      username: 'ana@s.unibuc.ro',
      password: 'Str0ng!pass',
    });
    expect(onLoggedIn).toHaveBeenCalledWith('ana@s.unibuc.ro');
  });

  it('shows the identical generic error for different Cognito failures', async () => {
    const errorNames = ['UserNotFoundException', 'NotAuthorizedException'];
    const messages: string[] = [];

    for (const name of errorNames) {
      const user = userEvent.setup();
      const signIn = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error(name), { name }));
      const onLoggedIn = jest.fn();
      const client = makeClient({ signIn: signIn as AuthClient['signIn'] });

      const { unmount } = render(
        <LoginPage authClient={client} onLoggedIn={onLoggedIn} />
      );

      await user.type(
        screen.getByLabelText(/university email/i),
        'ana@s.unibuc.ro'
      );
      await user.type(screen.getByLabelText(/password/i), 'whatever');
      await user.click(screen.getByRole('button', { name: /log in/i }));

      const errorEl = await screen.findByTestId('login-error');
      messages.push(errorEl.textContent ?? '');
      expect(onLoggedIn).not.toHaveBeenCalled();
      unmount();
    }

    // Every failure variant renders the exact same string (non-enumerating).
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(GENERIC_AUTH_ERROR_MESSAGE);
  });

  it('rejects an empty submission with the generic message, without calling Cognito', async () => {
    const user = userEvent.setup();
    const client = makeClient();

    render(<LoginPage authClient={client} />);

    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.getByTestId('login-error')).toHaveTextContent(
      GENERIC_AUTH_ERROR_MESSAGE
    );
    expect(client.signIn).not.toHaveBeenCalled();
  });
});
