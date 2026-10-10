# Auth category: `fmios` (Cognito)

Local scaffold for FMI OS authentication (Task 1.2, Requirement 1.1). No cloud
resources are provisioned yet; these files describe the intended Cognito user
pool so the Amplify CLI can generate the CloudFormation on `amplify push`.

## What is configured

- **Email sign-in**: `usernameAttributes: ["email"]` — students sign in with
  their university email address. `email` is required and auto-verified.
- **University domain restriction**: enforced server-side by the Cognito
  **Pre Sign-up** Lambda trigger `fmiosPreSignup`
  (`amplify/backend/function/fmiosPreSignup`). The trigger rejects any sign-up
  whose email domain is not in the allow-list (`s.unibuc.ro`). See
  `dependsOn` / `triggers.PreSignUp` in `cli-inputs.json`.
- **Password policy**: minimum 8 chars, requires lower/upper/number.
- **No unauthenticated identities**: `allowUnauthenticatedIdentities: false`.

The allow-list is defined in two mirrored places that must stay in sync:

| Side | File | Purpose |
| --- | --- | --- |
| Server (authoritative) | `amplify/backend/function/fmiosPreSignup/src/universityEmail.js` | Cognito enforces this on every sign-up |
| Client (fast feedback) | `src/auth/universityEmail.ts` | RegisterPage form check (Task 1.3) |

## Note on token validity (Task 1.2 second bullet)

The tasks also mention 1-hour access token / 30-day refresh token validity and
silent refresh. The 30-day refresh token is set here
(`userpoolClientRefreshTokenValidity: 30`). Access-token validity (1 hour is the
Cognito default) and the client-side silent-refresh/Hub-listener logic are
implemented against the real pool in Tasks 1.3 and 1.5. This task delivers the
pool + domain-restriction trigger plus the shared, unit-tested validation
utility.

## Manual AWS steps for the project owner

Because `amplify add auth` is interactive and needs AWS credentials, run it
locally rather than committing provisioned resources:

1. `amplify init` (if not already initialized) — see `amplify/README.md`.
2. `amplify add function`
   - Name: `fmiosPreSignup`
   - Runtime: NodeJS; template: "Hello World".
   - Replace the generated `src/index.js` and `src/package.json` with the
     versions already committed here (they contain the domain-check logic).
3. `amplify add auth`
   - Choose **Manual configuration**.
   - Sign-in: **Email**.
   - Under advanced settings, enable the **Pre Sign-up** Lambda trigger and
     point it at an **existing** function → `fmiosPreSignup`.
   - Refresh token validity: **30 days**.
4. `amplify push` — provisions the user pool, identity pool, and Lambda, and
   regenerates `src/aws-exports.js`.

Alternatively, if the CLI version supports headless regeneration from
`cli-inputs.json`, running `amplify push` after dropping these files in place
will build the auth stack directly. Verify the generated CloudFormation wires
the `PreSignUp` trigger to `fmiosPreSignup` before deploying.

After provisioning, test the restriction:

- Sign up with `someone@gmail.com` → rejected with the domain message.
- Sign up with `someone@s.unibuc.ro` → allowed (proceeds to email verification).
