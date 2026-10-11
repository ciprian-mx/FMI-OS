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
   - Task 4.6: the `materialIndexTrigger` S3 trigger Lambda (needs a Bedrock
     Knowledge Base created by hand). See
     `amplify/backend/function/materialIndexTrigger/README.md`.
   - Later Timetable/Gus tasks: further Lambdas, following the backend function
     convention below.
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

## Backend function convention

Every Lambda follows the layout `materialIndexTrigger` (task 4.6) introduced;
timetableOcrHandler, ragOrchestrator, fileSearchHandler, sessionGenerator,
progressUpdater and roadmapGenerator use it too.

| Part | Location | Contents |
| --- | --- | --- |
| Tested core | `src/backend/<fn>/` | TypeScript logic written against small port interfaces declared in the folder (`ports.ts`); adapters that take AWS SDK v3 clients and command classes by injection (no `@aws-sdk/*` imports); a `createLambdaHandler` composition root in `lambda.ts`; co-located Jest / fast-check tests (`*.test.ts`, helpers under `__tests__/`). |
| Amplify scaffold | `amplify/backend/function/<fn>/` | `<fn>-cloudformation-template.json` (env vars, least-privilege IAM), `function-parameters.json`, `src/package.json` pinning the `@aws-sdk/*` clients, `src/index.js` (builds the SDK clients, calls `./core/<fn>/lambda`), optional `src/event.json` for `amplify mock function`, and a README with the manual AWS steps. |

Rules:

- The core imports only from `src/backend/` (shared code can go in
  `src/backend/shared/`), never from the React app or `@aws-sdk/*`. The
  existing `npm run typecheck` and `npm test` then cover it with no config
  changes.
- `node amplify/scripts/build-functions.js [<fn> ...]` compiles
  `src/backend/<fn>/` (minus tests) to CommonJS in
  `amplify/backend/function/<fn>/src/core/` with the repo's TypeScript compiler
  (Node.js target, strict settings from `tsconfig.json`); a type error fails the
  build. Without arguments it builds every function that has both folders.
- `amplify/hooks/pre-push.js` runs that build before every `amplify push`,
  locally and in Amplify Hosting CI (run `npm ci` first there). A new function
  therefore needs no edits to `package.json`, `jest.config.js`,
  `tsconfig.json` or the hook. The `src/core/` output is gitignored.
- Register the function in `amplify/backend/backend-config.json` (read it,
  then merge your entry and `dependsOn`), and document its manual AWS steps in
  its README.
- All Knowledge Base retrieval goes through `src/backend/shared/knowledgeBase/`
  (task 4.9): `createBedrockKnowledgeBaseRetriever` (inject
  `BedrockAgentRuntimeClient` and `RetrieveCommand`), `retrieveForStudent`,
  `toCitations`. It always applies `{ equals: { key: "studentId", value } }`
  (caller filters are ANDed with it) and drops chunks of other students. Pass
  the verified Cognito `sub`, never a client-supplied id, and never send
  `Retrieve` / `RetrieveAndGenerate` directly. The role needs `bedrock:Retrieve`.
