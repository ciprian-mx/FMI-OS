// The real `aws-amplify/auth` entry runs setup at import time that jsdom cannot
// execute; `logoutStudent` only imports it lazily, but stub it so the default
// sign-out path can be exercised.
jest.mock('aws-amplify/auth', () => ({ signOut: jest.fn() }));

import { signOut } from 'aws-amplify/auth';
import { INTENDED_ROUTE_STORAGE_KEY } from '../auth/routeRestoration';
import { LOGIN_ROUTE } from '../auth/sessionManager';
import { DESKTOP_STATE_STORAGE_KEY } from '../components/desktopStatePersistence';
import { logoutStudent } from './logout';

/**
 * Task 3.5 — Account Center logout (Requirement 6.4).
 *
 * Sign-out and the redirect are injected; the clearing steps run for real
 * against jsdom's localStorage / sessionStorage.
 */

const SAVED_DESKTOP = JSON.stringify({ schemaVersion: 1, windows: [] });
const SAVED_ROUTE = '/materials';

function storedSession(): [string | null, string | null] {
  return [
    localStorage.getItem(DESKTOP_STATE_STORAGE_KEY),
    sessionStorage.getItem(INTENDED_ROUTE_STORAGE_KEY),
  ];
}

beforeEach(() => {
  localStorage.setItem(DESKTOP_STATE_STORAGE_KEY, SAVED_DESKTOP);
  sessionStorage.setItem(INTENDED_ROUTE_STORAGE_KEY, SAVED_ROUTE);
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('logoutStudent', () => {
  it('signs out, clears the saved desktop and route, then redirects to login', async () => {
    let atSignOut: [string | null, string | null] = [null, null];
    let atRedirect: [string | null, string | null] = [SAVED_DESKTOP, SAVED_ROUTE];
    const signOutSession = jest.fn(async () => {
      atSignOut = storedSession();
    });
    const redirect = jest.fn(() => {
      atRedirect = storedSession();
    });

    await logoutStudent({ signOut: signOutSession, redirect });

    expect(signOutSession).toHaveBeenCalledTimes(1);
    expect(atSignOut).toEqual([SAVED_DESKTOP, SAVED_ROUTE]);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
    expect(atRedirect).toEqual([null, null]);
  });

  it('keeps local state and does not redirect when sign-out fails', async () => {
    const failure = new Error('network');
    const redirect = jest.fn();

    await expect(
      logoutStudent({ signOut: jest.fn().mockRejectedValue(failure), redirect })
    ).rejects.toBe(failure);

    expect(redirect).not.toHaveBeenCalled();
    expect(storedSession()).toEqual([SAVED_DESKTOP, SAVED_ROUTE]);
  });

  it('signs out through Amplify by default', async () => {
    jest.mocked(signOut).mockResolvedValue(undefined);
    const redirect = jest.fn();

    await logoutStudent({ redirect });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
