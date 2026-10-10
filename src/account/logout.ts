/**
 * Explicit logout from the Account Center (Task 3.5, Requirement 6.4: "a logout
 * button that, when clicked, terminates the Student's session and redirects the
 * Student to the login screen").
 *
 * {@link logoutStudent} runs the whole sequence behind injectable seams:
 *
 *   1. Terminate the Cognito session (Amplify `signOut`). Amplify then emits the
 *      Hub `signedOut` event, which the session manager
 *      (`src/auth/sessionManager.ts`) already answers by clearing any saved
 *      post-login route.
 *   2. Clear the persisted desktop layout (`clearDesktopState`) and, explicitly
 *      and idempotently, the saved route (`clearIntendedRoute`), so the next
 *      sign-in on this browser starts from a clean desktop even when the
 *      session manager is not mounted.
 *   3. Redirect to the login screen ({@link LOGIN_ROUTE}).
 *
 * If sign-out fails nothing is cleared and no redirect happens: the session is
 * still alive, so the error propagates and the panel offers a retry.
 *
 * As with `src/materials/uploadMaterial.ts`, `aws-amplify/auth` is imported
 * lazily inside the default sign-out, never at module load.
 */
import { clearIntendedRoute } from '../auth/routeRestoration';
import { LOGIN_ROUTE } from '../auth/sessionManager';
import { clearDesktopState } from '../components/desktopStatePersistence';

/** Injectable dependencies; each defaults to the production implementation. */
export interface LogoutDeps {
  /** Terminates the session. Defaults to Amplify `signOut()`. */
  signOut?: () => Promise<unknown>;
  /** Clears the persisted desktop layout. Defaults to `clearDesktopState()`. */
  clearDesktopState?: () => void;
  /** Clears the saved post-login route. Defaults to `clearIntendedRoute()`. */
  clearIntendedRoute?: () => void;
  /** Navigates to `route`. Defaults to `window.location.assign`. */
  redirect?: (route: string) => void;
}

/** Production sign-out; binds to Amplify only when actually invoked. */
async function amplifySignOut(): Promise<void> {
  const { signOut } = await import('aws-amplify/auth');
  await signOut();
}

/** Default redirect: hard navigation, matching the session manager's. */
function assignLocation(route: string): void {
  if (typeof window !== 'undefined' && window.location) {
    window.location.assign(route);
  }
}

/**
 * Signs the student out, clears their local desktop state and sends them to the
 * login screen. Rejects (without clearing or redirecting) when sign-out fails.
 */
export async function logoutStudent(deps: LogoutDeps = {}): Promise<void> {
  await (deps.signOut ?? amplifySignOut)();
  (deps.clearDesktopState ?? clearDesktopState)();
  (deps.clearIntendedRoute ?? clearIntendedRoute)();
  (deps.redirect ?? assignLocation)(LOGIN_ROUTE);
}
