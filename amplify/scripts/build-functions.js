#!/usr/bin/env node
'use strict';

/**
 * Builds the deployable code of the FMI OS backend Lambda functions.
 *
 * Convention (amplify/README.md, "Backend function convention"):
 *   src/backend/<fn>/                 TypeScript core + adapters, tested by Jest
 *   amplify/backend/function/<fn>/    Amplify scaffold; src/index.js requires
 *                                     ./core/<fn>/...
 *
 * For every function that has both folders (or only the ones named on the
 * command line) this compiles src/backend/<fn>/ to CommonJS in
 * amplify/backend/function/<fn>/src/core/, using the TypeScript compiler the
 * web app already installs. Test files (*.test.ts) and __tests__/ folders are
 * not deployed. Type errors fail the build and nothing is written. The core may
 * import from anywhere under src/backend/ (e.g. a future src/backend/shared/),
 * never from the React app.
 *
 * Usage: node amplify/scripts/build-functions.js [functionName ...]
 * amplify/hooks/pre-push.js runs it before every `amplify push`.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendRoot = path.join(repoRoot, 'src', 'backend');
const functionsRoot = path.join(repoRoot, 'amplify', 'backend', 'function');

function loadTypeScript() {
  try {
    return require(require.resolve('typescript', { paths: [repoRoot] }));
  } catch (error) {
    throw new Error(
      'build-functions: the "typescript" package is not installed. Run `npm ci` in ' +
        repoRoot +
        ' first.'
    );
  }
}

function relative(target) {
  return path.relative(repoRoot, target).split(path.sep).join('/');
}

function isBuildable(name) {
  return (
    fs.existsSync(path.join(backendRoot, name)) &&
    fs.existsSync(path.join(functionsRoot, name, 'src'))
  );
}

/** Functions that have both a src/backend/<fn>/ core and an Amplify scaffold. */
function discoverFunctions() {
  if (!fs.existsSync(backendRoot)) {
    return [];
  }
  return fs
    .readdirSync(backendRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isBuildable(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function collectSources(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...collectSources(fullPath));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function formatDiagnostics(ts, diagnostics) {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  });
}

/** The repo's compiler settings, retargeted from the web bundler to Node.js. */
function compilerOptions(ts, outDir) {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(formatDiagnostics(ts, [read.error]));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
  return {
    ...parsed.options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2020,
    lib: ['lib.es2020.d.ts'],
    types: ['node'],
    typeRoots: [path.join(repoRoot, 'node_modules', '@types')],
    allowJs: false,
    checkJs: false,
    noEmit: false,
    noEmitOnError: true,
    declaration: false,
    sourceMap: false,
    incremental: false,
    rootDir: backendRoot,
    outDir,
  };
}

function buildFunction(ts, name) {
  const sourceDir = path.join(backendRoot, name);
  const outDir = path.join(functionsRoot, name, 'src', 'core');
  const rootNames = collectSources(sourceDir);
  if (rootNames.length === 0) {
    console.error(`build-functions: ${name}: no TypeScript sources in ${relative(sourceDir)}`);
    return false;
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  const program = ts.createProgram({ rootNames, options: compilerOptions(ts, outDir) });
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  if (diagnostics.length > 0 || emitResult.emitSkipped) {
    console.error(`build-functions: ${name} failed:\n${formatDiagnostics(ts, diagnostics)}`);
    return false;
  }
  console.log(`build-functions: ${name} -> ${relative(outDir)}`);
  return true;
}

/**
 * Builds the named functions (all discovered ones when `names` is empty).
 * Returns true when every build succeeded.
 */
function buildFunctions(names = []) {
  const unknown = names.filter((name) => !isBuildable(name));
  if (unknown.length > 0) {
    throw new Error(
      `build-functions: ${unknown.join(', ')}: expected both src/backend/<fn>/ and ` +
        'amplify/backend/function/<fn>/src/'
    );
  }
  const targets = names.length > 0 ? names : discoverFunctions();
  if (targets.length === 0) {
    console.log('build-functions: no backend functions to build');
    return true;
  }
  const ts = loadTypeScript();
  let ok = true;
  for (const name of targets) {
    ok = buildFunction(ts, name) && ok;
  }
  return ok;
}

module.exports = { buildFunctions, discoverFunctions };

if (require.main === module) {
  try {
    process.exitCode = buildFunctions(process.argv.slice(2)) ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
