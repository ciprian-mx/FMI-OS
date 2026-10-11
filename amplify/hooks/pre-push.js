'use strict';

/**
 * Amplify CLI command hook: runs before every `amplify push`, locally and in
 * Amplify Hosting CI.
 *
 * Compiles each backend function's TypeScript core (src/backend/<fn>/) into its
 * Amplify function folder so the deployed Lambda is the tested code. A failed
 * build (e.g. a type error) exits non-zero, which stops the push. See
 * amplify/README.md, "Backend function convention".
 */
const fs = require('fs');
const path = require('path');

/** The CLI passes `{ data, error }` as JSON on stdin; absent when run by hand. */
function readHookEvent() {
  if (process.stdin.isTTY) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (error) {
    return {};
  }
}

function main() {
  const event = readHookEvent();
  const projectPath =
    (event.data && event.data.amplify && event.data.amplify.environment &&
      event.data.amplify.environment.projectPath) ||
    path.resolve(__dirname, '..', '..');
  const { buildFunctions } = require(path.join(projectPath, 'amplify', 'scripts', 'build-functions.js'));
  if (!buildFunctions()) {
    console.error('pre-push: backend function build failed; fix the errors above and push again.');
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`pre-push: ${error.message}`);
  process.exitCode = 1;
}
