# Amplify Backend (local scaffold)

This directory holds the **local** Amplify project structure for FMI OS. No AWS
cloud resources have been provisioned yet. The files here let later tasks add
auth, API (GraphQL/AppSync), storage (S3), and functions (Lambda) with the
Amplify CLI.

## Manual AWS steps the user must run

These require AWS credentials and are interactive, so they are intentionally
left for the project owner to run locally:

1. Install the CLI (once): `npm install -g @aws-amplify/cli`
2. Configure an IAM user/profile: `amplify configure`
3. Initialize the cloud backend in this repo: `amplify init`
   - Choose the existing `fmios` project settings when prompted.
   - This generates `src/aws-exports.js`, `amplify/team-provider-info.json`,
     and populates `amplify/#current-cloud-backend`.
4. Add backend categories as the corresponding spec tasks are implemented:
   - Task 1.2: `amplify add auth` (Cognito, `@s.unibuc.ro` email validation).
     A local scaffold already exists under
     `amplify/backend/auth/fmios/` plus the pre-sign-up trigger Lambda under
     `amplify/backend/function/fmiosPreSignup/`. See
     `amplify/backend/auth/fmios/README.md` for the exact manual steps and how
     the domain-restriction trigger is wired.
   - Task 1.6: `amplify add api` (GraphQL / AppSync schema). A local scaffold
     already exists under `amplify/backend/api/fmios/` (core data-model
     `schema.graphql` with Cognito User Pool default auth and per-owner
     `@auth` rules). See `amplify/backend/api/fmios/README.md` for the exact
     manual steps.
   - Task 1.7: `amplify add storage` (S3, per-student prefix)
   - Materials/Timetable/Gus tasks: `amplify add function` (Lambda)
5. Deploy: `amplify push`

The frontend reads its Amplify config through `src/amplifyConfig.ts`, which
imports `src/aws-exports`. A committed placeholder `src/aws-exports.ts`
(exports an empty object) keeps the app building and tests passing before any
backend exists; `configureAmplify()` is a safe no-op while the config is empty.

After `amplify push` generates `src/aws-exports.js` with real resource IDs,
delete the placeholder `src/aws-exports.ts` so the generated JS module is the
single source of truth. The generated `aws-exports.js` is gitignored.

> Do not commit `src/aws-exports.js`, `amplify/team-provider-info.json`, or
> `amplify/#current-cloud-backend` with real resource IDs. They are already
> listed in `.gitignore`.
