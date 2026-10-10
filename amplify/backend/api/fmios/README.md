# API category: `fmios` (AppSync GraphQL)

Local scaffold for the FMI OS GraphQL API (Task 1.6, Requirements 1.1, 1.5,
7.1). No cloud resources are provisioned yet; these files describe the intended
AppSync API + DynamoDB tables so the Amplify CLI can generate the
CloudFormation on `amplify push`.

## What is configured

- **Default auth mode: Amazon Cognito User Pools** (`AMAZON_COGNITO_USER_POOLS`),
  wired to the existing `fmios` auth resource (`amplify/backend/auth/fmios`).
  The API `dependsOn` the auth category's `UserPoolId` in
  `amplify/backend/backend-config.json`, so the Cognito authorizer is attached
  automatically. There is no API-key or IAM auth fallback.
- **Per-owner authorization**: every model in `schema.graphql` carries
  `@auth(rules: [{ allow: owner }])`. The GraphQL transformer stamps an implicit
  `owner` field (the Cognito `sub`) on each record and injects an owner filter
  into every query, mutation, and subscription — so a student can only ever read
  or write their own rows. This enforces **Requirement 1.5 (student data
  isolation)** at the API layer.
- **`byStudent` indexes**: each model also stores an explicit `studentId`
  (Cognito `sub`) with a secondary index + typed query field (e.g.
  `examinationsByStudent`), so backend Lambdas added in later tasks can list a
  single student's records efficiently. This is the second of the three
  isolation layers in the design doc (AppSync `@auth owner` → DynamoDB
  `studentId` → Bedrock retrieval metadata filter).

## Core data models

`Student`, `FolderNode`, `MaterialFile`, `Examination`, `TimeBlock`,
`GradeRecord`, `WeakPoint`, `LearningGoal`, `TopicProgress`, `Session`
(with an embedded `SessionTopic` type), plus the enums `IndexingStatus`, `Day`,
`Severity`, `ComprehensionLevel`, `SessionStatus`. Each `@model` provisions its
own DynamoDB table (PAY_PER_REQUEST) and auto-generated create/read/update/
delete/list operations.

## Not in this task (added later)

The custom `@function`-backed mutations from the design doc — `askGus`,
`searchFiles`, `startSession`, `generateRoadmap`, `extractTimetable`,
`updateProgress` — and their input/output types are **not** declared here. They
depend on Lambda functions that do not exist yet and are wired up in
tasks 11.x–16.x (`amplify add function`, then extend `schema.graphql` with the
`@function` directives). This task delivers the coherent core data model only.

## Manual AWS steps for the project owner

`amplify add api` is interactive and needs AWS credentials, so run it locally
rather than committing provisioned resources:

1. `amplify init` and `amplify add auth` first — see `amplify/README.md` and
   `amplify/backend/auth/fmios/README.md`. The API depends on the user pool.
2. `amplify add api`
   - Service: **GraphQL**.
   - Authorization mode: **Amazon Cognito User Pool** (choose the existing
     `fmios` pool). Do **not** add API key as the default.
   - Additional auth types: none.
   - When prompted for a schema, replace the generated template with the
     committed `schema.graphql` in this folder (or point the CLI at it).
3. `amplify push`
   - Provisions the AppSync API, the per-model DynamoDB tables, resolvers, and
     the Cognito authorizer, and regenerates `src/aws-exports.js`.
   - Run `amplify codegen` (or accept the push prompt) to generate the typed
     GraphQL operations/types the frontend will import in later tasks.

If the CLI version supports headless regeneration from `cli-inputs.json`,
`amplify push` after dropping these files in place will build the API stack
directly. Verify the generated CloudFormation attaches the Cognito User Pool
authorizer and that each model's resolver includes the owner auth filter before
deploying.

## Verifying data isolation after provisioning

- Sign in as student A, create an `Examination`; sign in as student B and run
  `listExaminations` → B must see none of A's rows.
- Attempt to fetch A's record by id while authenticated as B → authorization
  error. (Property 2 in the design doc; the automated property test lands in
  task 1.8.)
