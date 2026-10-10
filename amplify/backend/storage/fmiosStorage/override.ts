import { AmplifyS3ResourceTemplate } from '@aws-amplify/cli-extensibility-helper';

/**
 * Per-student prefix IAM scoping for FMI OS Materials storage.
 *
 * Task 1.7 — Requirements 1.1, 1.5, 7.3.
 *
 * Amplify's `auth`-scoped S3 storage already grants the authenticated role
 * access to the `private/${cognito-identity.amazonaws.com:sub}/*` prefix, where
 * the policy variable `${cognito-identity.amazonaws.com:sub}` resolves at
 * request time to the signed-in student's Cognito Identity ID. That alone keeps
 * each student in their own prefix for the generated `private` statements.
 *
 * This override hardens that guarantee so a student can ONLY ever touch their
 * own prefix:
 *   1. It rewrites the authenticated policy's object-level statements to a
 *      single prefix: `private/${cognito-identity.amazonaws.com:sub}/*`.
 *   2. It scopes `s3:ListBucket` with an `s3:prefix` condition so a student
 *      cannot even enumerate another student's objects.
 *
 * The result: no student can read, write, delete, or list files outside
 * `private/{their-own-cognito-identity-id}/`, enforcing student data isolation
 * (Requirement 1.5) at the storage layer — the S3 counterpart to the AppSync
 * `@auth owner` rules and DynamoDB `studentId` keys from the design doc.
 */
export function override(resources: AmplifyS3ResourceTemplate): void {
  const PREFIX = 'private/${cognito-identity.amazonaws.com:sub}';

  const authPolicy = resources.s3AuthPublicPolicy ?? resources.s3AuthPrivatePolicy;

  // Scope every authenticated object-level action to the student's own prefix.
  if (authPolicy?.policyDocument?.Statement) {
    authPolicy.policyDocument.Statement = authPolicy.policyDocument.Statement.map(
      (statement: any) => {
        if (statement.Action && statement.Resource) {
          const actions: string[] = Array.isArray(statement.Action)
            ? statement.Action
            : [statement.Action];
          const isObjectAction = actions.some((a) => a !== 's3:ListBucket');

          if (isObjectAction) {
            statement.Resource = {
              'Fn::Join': [
                '',
                [
                  'arn:aws:s3:::',
                  { Ref: 'S3Bucket' },
                  `/${PREFIX}/*`,
                ],
              ],
            };
          }
        }
        return statement;
      }
    );
  }

  // Restrict ListBucket to the student's own prefix via an s3:prefix condition.
  const listStatement = {
    Effect: 'Allow',
    Action: ['s3:ListBucket'],
    Resource: {
      'Fn::Join': ['', ['arn:aws:s3:::', { Ref: 'S3Bucket' }]],
    },
    Condition: {
      StringLike: {
        's3:prefix': [`${PREFIX}/*`, `${PREFIX}/`],
      },
    },
  };

  if (authPolicy?.policyDocument?.Statement) {
    authPolicy.policyDocument.Statement = authPolicy.policyDocument.Statement.filter(
      (statement: any) => {
        const actions: string[] = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        return !actions.includes('s3:ListBucket');
      }
    );
    authPolicy.policyDocument.Statement.push(listStatement as any);
  }
}
