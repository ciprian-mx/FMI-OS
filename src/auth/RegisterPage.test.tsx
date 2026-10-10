// Replace the real Amplify auth module (its import-time OAuth-listener setup
// breaks under jsdom/ts-jest). Tests inject a fake AuthClient, so inert stubs
// are sufficient.
jest.mock('aws-amplify/auth', () => ({
  signUp: jest.fn(),
  signIn: jest.fn(),
}));

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RegisterPage from './RegisterPage';
import { AuthClient, GENERIC_AUTH_ERROR_MESSAGE } from './authService';
import { allowedDomainsMessage } from './universityEmail';

/**
 * Task 1.3 — RegisterPage (Requirements 1.1, 1.3).
 *
 * The Amplify auth calls are stubbed via an injected AuthClient, so these tests
 * run with no live Cognito backend.
 */

function makeClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    signUp: jest.fn().mockResolvedValue({ isSignUpComplete: true }),
    signIn: jest.fn().mockResolvedValue({ isSignedIn: true }),
    ...overrides,
  } as AuthClient;
}

describe('RegisterPage', () => {
  it('rejects a non-university email without calling Cognito', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<RegisterPage authClient={client} />);

    await user.type(screen.getByLabelText(/university email/i), 'ana@gmail.com');
    await user.type(screen.getByLabelText(/password/i), 'Str0ng!pass');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(screen.getByTestId('register-error')).toHaveTextContent(
      allowedDomainsMessage()
    );
    expect(client.signUp).not.toHaveBeenCalled();
  });

  it('calls Cognito and notifies on a valid university email', async () => {
    const user = userEvent.setup();
    const signUp = jest.fn().mockResolvedValue({ isSignUpComplete: true });
    const onRegistered = jest.fn();
    const client = makeClient({ signUp: signUp as AuthClient['signUp'] });

    render(<RegisterPage authClient={client} onRegistered={onRegistered} />);

    await user.type(
      screen.getByLabelText(/university email/i),
      'ana@s.unibuc.ro'
    );
    await user.type(screen.getByLabelText(/password/i), 'Str0ng!pass');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp).toHaveBeenCalledTimes(1);
    expect(onRegistered).toHaveBeenCalledWith('ana@s.unibuc.ro');
  });

  it('shows the generic error when Cognito rejects a valid-domain registration', async () => {
    const user = userEvent.setup();
    const signUp = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exists'), { name: 'UsernameExistsException' })
      );
    const onRegistered = jest.fn();
    const client = makeClient({ signUp: signUp as AuthClient['signUp'] });

    render(<RegisterPage authClient={client} onRegistered={onRegistered} />);

    await user.type(
      screen.getByLabelText(/university email/i),
      'ana@s.unibuc.ro'
    );
    await user.type(screen.getByLabelText(/password/i), 'Str0ng!pass');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByTestId('register-error')).toHaveTextContent(
      GENERIC_AUTH_ERROR_MESSAGE
    );
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
