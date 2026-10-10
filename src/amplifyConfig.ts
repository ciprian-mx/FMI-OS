import { Amplify } from 'aws-amplify';
import awsExports from './aws-exports';

/**
 * Configures the Amplify client library from the generated `aws-exports`
 * module produced by `amplify push`.
 *
 * Until the backend is provisioned, `src/aws-exports.ts` is a committed
 * placeholder that exports an empty object. In that case this function is a
 * safe no-op and logs a hint rather than throwing. After `amplify push`
 * generates a real `aws-exports.js`, that file takes precedence and this
 * wiring activates auth/API/storage for the frontend.
 */
export function configureAmplify(): boolean {
  const hasConfig =
    !!awsExports && Object.keys(awsExports as object).length > 0;

  if (!hasConfig) {
    if (typeof console !== 'undefined') {
      console.info(
        'FMI OS: Amplify backend config not found. Run the Amplify CLI backend setup to enable auth/API/storage.'
      );
    }
    return false;
  }

  Amplify.configure(awsExports as Record<string, unknown>);
  return true;
}
