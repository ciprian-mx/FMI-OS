# Storage category: `fmiosStorage` (Amplify Storage / S3)

Local scaffold for the FMI OS Materials object store (Task 1.7, Requirements
1.1, 1.5, 7.3). No cloud resources are provisioned yet; these files describe the
intended S3 bucket and the per-student prefix IAM policy so the Amplify CLI can
generate the CloudFormation on `amplify push`.

## What is configured

- **An S3 bucket** holding every student's uploaded study materials. Access is
  granted only to the **authenticated** Cognito role (`authAccess` =
  create/update, read, delete); there is no guest/unauthenticated access.
- **Per-student prefix isolation.** Each student's files live under
  `private/${cognito-identity.amazonaws.com:sub}/...`. The policy variable
  `${cognito-identity.amazonaws.com:sub}` is an IAM condition key that resolves
  at request time to the signed-in student's Cognito Identity ID. Because the
  authenticated role's S3 permissions are scoped to that variable prefix, every
  student is confined to their own prefix — one student can never read, write,
  delete, or even list another student's objects.
- **ListBucket is prefix-scoped.** `s3:ListBucket` is granted on the bucket only
  with an `s3:prefix` condition of `private/${cognito-identity.amazonaws.com:sub}/*`,
  so a student cannot enumerate the keys of any other student.

This is the S3 counterpart of the three-layer isolation model from the design
doc: AppSync `@auth owner` (API) → DynamoDB `studentId` key (data) → S3
per-student prefix (objects). Together they satisfy **Requirement 1.5 (student
data isolation)**.

> **Prefix note.** The design doc also sketches an `students/{userId}/materials/...`
> key layout used by the upload helper and the `materialIndexTrigger` Lambda
> (tasks 4.5 / 4.6). The IAM *isolation boundary* enforced here is the Amplify
> `private/{cognito-identity-id}/` prefix required by Requirement 1.1/1.5. When
> the upload pipeline is wired in task 4.5, write materials under
> `private/{cognito-identity-id}/materials/{folderPath}/{fileName}` so the keys
> stay inside the IAM-enforced prefix. Adjust the Lambda's S3 event prefix
> filter to match at that time.

## Files

- `cli-inputs.json` — Amplify Storage (S3) service configuration: bucket,
  authenticated-only access, no guest access, no trigger function.
- `override.ts` — the enforced per-student prefix IAM policy. Amplify runs this
  against the generated S3 CloudFormation stack on `amplify push`, rewriting the
  authenticated role's object statements to the single prefix
  `private/${cognito-identity.amazonaws.com:sub}/*` and adding the prefix-scoped
  `ListBucket` statement.
- `storage-params.json` — human-readable description of the intended prefix and
  the resulting IAM statements, for reviewers who are not reading the override.

## Manual AWS steps for the project owner

`amplify add storage` is interactive and needs AWS credentials, so run it
locally rather than committing provisioned resources:

1. `amplify init`, `amplify add auth`, and `amplify add api` first — see
   `amplify/README.md`, `amplify/backend/auth/fmios/README.md`, and
   `amplify/backend/api/fmios/README.md`. Storage depends on the auth category's
   Identity Pool so the `${cognito-identity.amazonaws.com:sub}` variable
   resolves. The auth resource is already configured with
   `authSelections: identityPoolAndUserPool`, which provides that Identity Pool.
2. `amplify add storage`
   - Category: **Content (Images, audio, video, etc.)** → **S3**.
   - Friendly name / resource name: `fmiosStorage`.
   - Who should have access: **Auth users only**.
   - Auth user access: **create/update, read, delete**.
   - Lambda trigger: **No** for this task (the `materialIndexTrigger` S3 event
     Lambda is added in task 4.6).
3. Apply the per-student prefix override:
   - `amplify override storage` (scaffolds the override entry point if needed),
     then keep / merge the committed `override.ts` in this folder.
4. `amplify push`
   - Provisions the S3 bucket and the IAM policy on the authenticated role,
     applies `override.ts`, and regenerates `src/aws-exports.js` with the bucket
     name and region.

If the CLI version supports headless regeneration from `cli-inputs.json`,
`amplify push` after dropping these files in place builds the storage stack
directly. Before deploying, verify the generated CloudFormation grants the
authenticated role object access ONLY on
`arn:aws:s3:::<bucket>/private/${cognito-identity.amazonaws.com:sub}/*` and
scopes `ListBucket` with the matching `s3:prefix` condition.

## Verifying per-student isolation after provisioning

- Sign in as student A and upload a file via the Materials app → the object
  lands under `private/{A-identity-id}/...`.
- While authenticated as student B, attempt to `Storage.get` /
  `Storage.list` with an identity-id level `{ identityId: <A-identity-id> }`
  (or a raw `GetObject` on A's key) → the request must be denied by IAM.
- Confirm B's `Storage.list({ level: 'private' })` returns only B's own
  objects. (This is the S3 half of Property 2 — Student Data Isolation; the
  automated property test lands in task 1.8.)
