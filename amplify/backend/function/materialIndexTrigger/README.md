# Function: `materialIndexTrigger` (S3 trigger → Bedrock Knowledge Base)

Task 4.6, Requirement 7.6. Local scaffold only; nothing is provisioned. The
logic lives in `src/backend/materialIndexTrigger/` and is covered by
`npm test`; this folder holds the deployable wrapper (see
`amplify/README.md`, "Backend function convention").

## What it does

On every `s3:ObjectCreated:*` event from the `fmiosStorage` bucket:

1. Decodes the event key and keeps only Materials documents:
   `private/{identityId}/materials/{folderPath}/{fileName}` (what the upload
   helper writes) or `students/{userId}/materials/...` (the design layout).
   Metadata sidecars (`*.metadata.json`, written by this function), folder
   markers, other prefixes and `ObjectRemoved` events are ignored, so the
   function never re-triggers itself.
2. Reads `studentid` from the object metadata. The identity id in a `private/`
   key is not the user-pool `sub`; for `students/` keys the key segment is the
   id and the metadata must agree.
3. Verifies that claim: a `MaterialFile` row must exist for that exact key with
   `studentId` equal to the claim and an AppSync `owner` of `<claim>::...`. It
   retries for about 15 s because the upload creates the row right after the
   object. Without a verified row the object is not tagged or synced.
4. Writes `<key>.metadata.json` next to the document:
   `{"metadataAttributes":{"studentId":"…","folderPath":"Data Structures/Week 3","fileName":"Sorting.pdf"}}`.
5. Calls `StartIngestionJob` on the data source. Bedrock runs one sync per data
   source, so if one is already running the function joins it when it started
   after the sidecar was written, and otherwise retries with backoff.
6. Sets `MaterialFile.indexingStatus` (plus `updatedAt`):

   | Status | When |
   | --- | --- |
   | `PENDING` | Set by the upload helper (task 4.5). |
   | `INDEXING` | A sync that includes the file is running. |
   | `INDEXED` | The sync finished and `GetKnowledgeBaseDocuments` reports the file `INDEXED` (or `PARTIALLY_INDEXED`). If that status is unavailable, a `COMPLETE` job counts unless a failure reason names the file. |
   | `FAILED` | The sync failed or stopped, the file was `FAILED` / `IGNORED` / had a metadata failure, no sync could start or finish within the Lambda's 15 minutes, or an error occurred. |

   Records created for the same key while the sync runs (a re-upload) get the
   final status too.

## Configuration

| Environment variable | Source |
| --- | --- |
| `KNOWLEDGE_BASE_ID` | Function env-var parameter `knowledgeBaseId` (per environment) |
| `DATA_SOURCE_ID` | Function env-var parameter `dataSourceId` (per environment) |
| `API_FMIOS_MATERIALFILETABLE_NAME` | AppSync export, via the `dependsOn` on `api/fmios` |

The function refuses to run (and logs a `ConfigError`) while any of them is
missing or malformed.

## IAM

The template grants only what the function calls:

- CloudWatch Logs for its own log group.
- `dynamodb:Query` on the `MaterialFile` table's `byStudent` index and
  `dynamodb:UpdateItem` on the table (conditional, never creates rows).
- `bedrock:StartIngestionJob`, `bedrock:GetIngestionJob`,
  `bedrock:ListIngestionJobs`, `bedrock:GetKnowledgeBaseDocuments` on the one
  configured knowledge base.

S3 access comes from the storage stack, not this template (the function
cannot reference the bucket without a circular dependency): when the trigger
is attached, Amplify's generated storage template grants this role object
access to the bucket and allows S3 to invoke the function. Check that policy
in the generated template before pushing. The function itself only needs
`s3:GetObject` (for `HeadObject`) on Materials keys and `s3:PutObject` on
`*.metadata.json`; narrowing the generated policy with `amplify override
storage` is optional hardening.

`amplify/backend/storage/fmiosStorage/override.ts` denies students
`s3:PutObject` on `*.metadata.json`, so only this function can write the
sidecars that carry the `studentId` tag.

## Manual AWS steps

Prerequisites: `amplify init`, then auth, API and storage as described in
`amplify/README.md` and the category READMEs.

1. Create the Bedrock Knowledge Base (console: Amazon Bedrock → Knowledge
   bases → Create, with a vector store).
   - Data source: Amazon S3, the Amplify storage bucket
     (`aws_user_files_s3_bucket` in the generated `aws-exports.js`), inclusion
     prefix `private/`. Leave the prefix empty if you also write `students/`
     keys.
   - Use a vector store that supports metadata filtering (the default
     OpenSearch Serverless store does); task 4.9 filters on `studentId`.
   - Parsing: the default parser handles the text formats. PNG/JPG need a
     multimodal parser (Bedrock Data Automation or a foundation-model parser);
     otherwise they come back `IGNORED` and are marked `FAILED`.
   - Run one sync from the console (the document-status API needs it), then
     note the knowledge base id and data source id (10 characters each).
2. Register the function. If `amplify status` does not list
   `materialIndexTrigger`, run `amplify add function` (name
   `materialIndexTrigger`, Node.js, "Hello World", no advanced settings), then
   restore the committed files over the generated ones:
   `git checkout -- amplify/backend/function/materialIndexTrigger amplify/backend/backend-config.json`.
3. Set the ids: `amplify update function` → `materialIndexTrigger` →
   Environment variables configuration → set `KNOWLEDGE_BASE_ID` and
   `DATA_SOURCE_ID`. The CLI stores the values per environment in
   `amplify/team-provider-info.json` (gitignored) and prompts for missing ones
   on `amplify push`.
4. Attach the trigger: `amplify update storage` → `fmiosStorage` → keep the
   access settings → add a Lambda trigger → choose the existing function
   `materialIndexTrigger`. This produces the `triggerFunction` and
   `dependsOn` entries already committed in
   `amplify/backend/storage/fmiosStorage/cli-inputs.json` and
   `amplify/backend/backend-config.json`. Keep the committed `override.ts`.
5. `amplify push`. `amplify/hooks/pre-push.js` first compiles
   `src/backend/materialIndexTrigger/` into `src/core/`; a type error stops the
   push. In Amplify Hosting CI, run `npm ci` in the backend build phase before
   `amplifyPush --simple` so the hook can find TypeScript.
6. Verify:
   - Upload a PDF in the Materials app. The `MaterialFile` row goes `PENDING`
     → `INDEXING` → `INDEXED`, `Sorting.pdf.metadata.json` appears next to the
     file, and CloudWatch shows `Material indexing finished` with
     `"status":"INDEXED"`.
   - With a student's credentials, `PutObject` on any `*.metadata.json` key is
     denied.
   - `amplify mock function materialIndexTrigger --event src/event.json` runs
     the handler locally against your AWS account (edit the key first).

## Known limits

- Deleting or moving a file does not remove its sidecar or Knowledge Base
  entry; Requirement 7.8 propagation is a separate task.
- Statuses are written straight to DynamoDB, so no AppSync subscription fires;
  the Materials app re-reads the records.
- The ownership check relies on `MaterialFile.owner`. Amplify lets a record's
  owner reassign `owner` by default, so for a strict guarantee either protect
  the field (`owner: String @auth(rules: [{ allow: owner, operations: [read, delete] }])`)
  or move uploads to an IAM-enforced `students/${aws:PrincipalTag/sub}/` prefix,
  which this function already supports.
