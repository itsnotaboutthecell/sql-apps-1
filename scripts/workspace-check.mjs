import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, lstat, realpath, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const inputDirectories = ['src', 'functions/src', 'public', 'sql', 'dab', 'infra', 'scripts'];
const inputFiles = ['package.json', 'package-lock.json', 'application.json', 'runtime-contract.json',
  'tsconfig.json', 'tsconfig.runtime.json', 'Dockerfile', 'functions/Dockerfile', 'functions/local.Dockerfile',
  'functions/package.json', 'functions/local-package.json', 'functions/host.json', 'functions/local-host.json',
  '.config/dotnet-tools.json'];
const extensions = new Set(['.ts', '.mts', '.js', '.mjs', '.json', '.sql', '.sqlproj', '.html', '.css', '.bicep']);
const browserArtifacts = [join('public', 'app.js'), join('public', 'auth', 'redirect.js')];

async function fingerprint(home, directories, files = [], source = false) {
  const entries = [];
  async function visit(relative, optional = false) {
    const path = join(home, relative);
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Runtime inputs must not be symlinks');
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (['node_modules', 'obj', 'bin', '.git', '.sql-apps'].includes(entry) || entry.startsWith('.env')) continue;
        await visit(join(relative, entry));
      }
    } else if (!source || extensions.has(extname(path)) || path.endsWith('Dockerfile')) {
      if (source && browserArtifacts.includes(relative)) return;
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      entries.push([relative.replaceAll('\\', '/'), hash]);
    }
  }
  for (const directory of directories) await visit(directory, true);
  for (const file of files) await visit(file, true);
  entries.sort(([a], [b]) => a.localeCompare(b, 'en'));
  return { hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files: entries.length };
}

async function gitEvidence(home) {
  const options = { cwd: home, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 };
  try {
    const { stdout: commit } = await execute('git', ['rev-parse', 'HEAD'], options);
    const { stdout: common } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], options);
    const { stdout: directory } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-dir'], options);
    const { stdout: changes } = await execute('git', ['status', '--porcelain', '--untracked-files=normal', '--',
      ...inputDirectories, ...inputFiles], options);
    return { available: true, commit: commit.trim(), linkedWorktree: common.trim() !== directory.trim(),
      sourceDirty: changes.trim().length > 0 };
  } catch (error) {
    return { available: false, code: error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_EVIDENCE_UNAVAILABLE' };
  }
}

function validApplication(value) {
  return value && typeof value.name === 'string' && value.name.length > 0 &&
    Array.isArray(value.selectedExamples) && value.selectedExamples.every(item => typeof item === 'string' && item.length > 0) &&
    Object.keys(value).every(key => ['name', 'selectedExamples'].includes(key));
}

function validContract(value) {
  return value && value.version === 1 && Array.isArray(value.capabilities) && value.capabilities.length > 0 &&
    value.capabilities.every(item => ['local', 'setup-check'].includes(item)) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    Object.keys(value).every(key => ['version', 'capabilities'].includes(key));
}

async function inspectBuild(home, sourceFingerprint) {
  let metadata;
  try { metadata = JSON.parse(await readFile(join(home, 'dist', 'build-provenance.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { ready: false, code: 'BUILD_UNVERIFIED', nextAction: 'No verified build; after approval, use consent-run build (the guarded build) in this checkout.' };
    return { ready: false, code: 'BUILD_METADATA_INVALID', nextAction: 'Review build metadata, then rebuild the selected checkout.' };
  }
  if (metadata.version !== 1 || metadata.home !== home || typeof metadata.sourceFingerprint !== 'string' ||
      typeof metadata.artifactFingerprint !== 'string' || typeof metadata.builtAt !== 'string' ||
      !Number.isFinite(Date.parse(metadata.builtAt)) ||
      Object.keys(metadata).some(key => !['version', 'home', 'sourceFingerprint', 'artifactFingerprint', 'builtAt'].includes(key))) {
    return { ready: false, code: 'BUILD_METADATA_INVALID', nextAction: 'Build provenance is invalid or belongs to another checkout; after approval, use consent-run build (the guarded build) in this checkout.' };
  }
  if (metadata.sourceFingerprint !== sourceFingerprint) {
    return { ready: false, code: 'BUILD_SOURCE_MISMATCH', nextAction: 'Source changed after the build; after approval, use consent-run build (the guarded build) in this checkout.' };
  }
  const artifacts = await fingerprint(home, ['dist/src', 'dist/functions', 'dist/scripts'], browserArtifacts);
  if (artifacts.hash !== metadata.artifactFingerprint || artifacts.files === 0) {
    return { ready: false, code: 'BUILD_ARTIFACT_MISMATCH', nextAction: 'Runtime artifacts changed or are missing; after approval, use consent-run build (the guarded build) in this checkout.' };
  }
  return { ready: true, code: 'BUILD_CURRENT', artifactFingerprint: artifacts.hash, builtAt: metadata.builtAt };
}

export async function inspectSource(value) {
  const home = await realpath(value);
  try {
    const pkg = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'));
    const application = JSON.parse(await readFile(join(home, 'application.json'), 'utf8'));
    const contract = JSON.parse(await readFile(join(home, 'runtime-contract.json'), 'utf8'));
    if ((pkg.name !== 'sql-apps' && pkg.sqlApps?.project !== true) || pkg.scripts?.local !== 'node dist/src/local-cli.js' ||
        !validApplication(application) || !validContract(contract)) {
      return { home, ready: false, code: 'SOURCE_INVALID', nextAction: 'Review the selected checkout application/runtime contract; do not copy another worktree implicitly.' };
    }
    for (const file of ['src/local-cli.ts', 'src/workspace.mjs', 'sql/database.sqlproj',
      ...(pkg.name === 'sql-apps' ? ['plugins/sql-apps/plugin.json'] : [])]) {
      await readFile(join(home, file));
    }
    const inputs = await fingerprint(home, inputDirectories, inputFiles, true);
    return { home, ready: true, code: 'SOURCE_READY', packageVersion: pkg.version ?? null,
      application, contract, fingerprint: inputs.hash, inputFiles: inputs.files,
      git: await gitEvidence(home), build: await inspectBuild(home, inputs.hash) };
  } catch (error) {
    if (error.code === 'ENOENT') return { home, ready: false, code: 'SOURCE_INCOMPLETE',
      nextAction: 'This checkout lacks required foundation inputs; select an explicit runtime home containing the intended source.' };
    if (error instanceof SyntaxError) return { home, ready: false, code: 'SOURCE_INVALID',
      nextAction: 'Correct the selected checkout JSON manifests before proceeding.' };
    throw error;
  }
}

export async function findActiveHome(directory) {
  const initial = await realpath(directory);
  let candidate = initial;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      if (pkg.name === 'sql-apps') return candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  try {
    const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'],
      { cwd: initial, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return await realpath(stdout.trim());
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 128) return null;
    throw new Error('Could not determine the active checkout; select an explicit runtime home and retry.', { cause: error });
  }
}

export async function checkWorkspace({ home, activeDirectory = process.cwd(), bindingSource, explicitHome = false }) {
  const bound = await inspectSource(home);
  const activeHome = await findActiveHome(activeDirectory);
  const mismatch = activeHome !== null && activeHome !== bound.home;
  const activeSource = activeHome ? (mismatch ? await inspectSource(activeHome) : bound) : null;
  const allowed = bound.ready && (!mismatch || explicitHome);
  let runtime;
  if (bound.ready) {
    const { runtimeFor } = await import(pathToFileURL(join(bound.home, 'src', 'workspace.mjs')).href);
    const selected = runtimeFor(undefined, bound.home);
    runtime = { id: selected.id, mode: selected.mode, defaultSql: selected.defaultSql,
      ports: selected.ports, origins: selected.origins, stateDirectory: selected.stateDirectory };
  }
  return { version: 1, active: { home: activeHome, source: activeSource }, bound,
    binding: { source: bindingSource, explicit: explicitHome, mismatch,
      code: mismatch && !explicitHome ? 'EXPLICIT_HOME_REQUIRED' : 'HOME_SELECTED' },
    executionAllowed: allowed, runtime,
    nextAction: !allowed ? (mismatch && !explicitHome ?
      'Set SQL_APPS_HOME to the absolute intended checkout path after reviewing the mismatch; do not change the global binding implicitly.' :
      bound.nextAction) : bound.build?.nextAction,
    scope: 'Source/build provenance and checkout selection only; not local resource ownership or live/cloud acceptance.' };
}

export async function recordBuild(value, expectedFingerprint) {
  const source = await inspectSource(value);
  if (!source.ready) throw new Error(`Cannot record build provenance: ${source.code}`);
  if (expectedFingerprint && expectedFingerprint !== source.fingerprint) throw new Error('Source changed during build; rebuild before running the application');
  const artifacts = await fingerprint(source.home, ['dist/src', 'dist/functions', 'dist/scripts'], browserArtifacts);
  if (artifacts.files === 0) throw new Error('No runtime artifacts to record');
  const target = join(source.home, 'dist', 'build-provenance.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, home: source.home,
      sourceFingerprint: source.fingerprint, artifactFingerprint: artifacts.hash, builtAt: new Date().toISOString() }, null, 2));
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [home = process.cwd()] = process.argv.slice(2);
  checkWorkspace({ home, bindingSource: 'argument', explicitHome: process.argv.length > 2 })
    .then(report => { console.log(JSON.stringify(report, null, 2)); if (!report.executionAllowed) process.exitCode = 1; })
    .catch(() => { console.error('Workspace inspection failed; review the checkout manifests and permissions.'); process.exitCode = 1; });
}
