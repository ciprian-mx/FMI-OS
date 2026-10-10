import { render, act } from '@testing-library/react';

import { useSessionManager } from './useSessionManager';
import {
  AUTH_EVENTS,
  LOGIN_ROUTE,
  type AuthHub,
  type AuthHubCapsule,
} from './sessionManager';
import { INTENDED_ROUTE_STORAGE_KEY } from './routeRestoration';

/**
 * Task 1.5 — React binding for session-expiry handling (Requirements 1.4).
 *
 * Mounts the hook inside a component and drives it through a fake Amplify Hub,
 * asserting the two behaviours called out in the task:
 *   - expiry (tokenRefresh_failure) → redirect to /login (location preserved)
 *   - post re-login (signedIn)      → restore the preserved route
 * Also verifies the Hub subscription is torn down on unmount.
 */

/** A controllable fake Hub whose single listener can be fired by the test. */
function makeFakeHub() {
  let listener: ((c: AuthHubCapsule) => void) | null = null;
  const unsubscribe = jest.fn();
  const hub: AuthHub = {
    listen: (_channel, cb) => {
      listener = cb;
      return unsubscribe;
    },
  };
  return {
    hub,
    unsubscribe,
    emit: (event: string) => {
      act(() => {
        listener?.({ payload: { event } });
      });
    },
    get hasListener() {
      return listener !== null;
    },
  };
}

function Harness(props: {
  hub: AuthHub;
  redirect: (route: string) => void;
  onRestore: (route: string) => void;
  getLocation: () => Pick<Location, 'pathname' | 'search' | 'hash'> | null;
}) {
  useSessionManager({
    hub: props.hub,
    redirect: props.redirect,
    onRestore: props.onRestore,
    getLocation: props.getLocation,
    store: window.sessionStorage,
  });
  return <div data-testid="harness" />;
}

describe('useSessionManager', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('redirects to /login on expiry and restores the route after re-login', () => {
    const fake = makeFakeHub();
    const redirect = jest.fn();
    const onRestore = jest.fn();
    const getLocation = () => ({
      pathname: '/materials',
      search: '',
      hash: '',
    });

    render(
      <Harness
        hub={fake.hub}
        redirect={redirect}
        onRestore={onRestore}
        getLocation={getLocation}
      />
    );

    expect(fake.hasListener).toBe(true);

    // Session token can no longer be refreshed.
    fake.emit(AUTH_EVENTS.TOKEN_REFRESH_FAILURE);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
    expect(window.sessionStorage.getItem(INTENDED_ROUTE_STORAGE_KEY)).toBe(
      '/materials'
    );

    // Student logs back in → restore to where they were.
    fake.emit(AUTH_EVENTS.SIGNED_IN);
    expect(onRestore).toHaveBeenCalledWith('/materials');
    expect(
      window.sessionStorage.getItem(INTENDED_ROUTE_STORAGE_KEY)
    ).toBeNull();
  });

  it('unsubscribes from the Hub on unmount', () => {
    const fake = makeFakeHub();
    const { unmount } = render(
      <Harness
        hub={fake.hub}
        redirect={jest.fn()}
        onRestore={jest.fn()}
        getLocation={() => null}
      />
    );
    expect(fake.unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
