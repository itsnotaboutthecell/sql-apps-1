import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readProjectManifest } from '../src/project-contract.mjs';
import { projectHome, toolingHome } from '../src/tooling-context.mjs';

const execute = promisify(execFile);
const extensions = new Set(['.ts', '.mts', '.js', '.mjs', '.json', '.sql', '.sqlproj', '.html', '.css', '.bicep']);
const generatedBrowserArtifacts = new Set(['public/app.js', 'public/auth/redirect.js']);
const excluded = new Set(['node_modules', 'obj', 'bin', '.git', '.sql-apps']);
const projectDirectories = ['src', 'public', 'sql', 'dab'];
const projectFiles = [
  '.sql-apps-project.json', 'package.json', 'package-lock.json', 'application.json',
  'role-based-data.json', 'tsconfig.json', '.config/dotnet-tools.json',
];

async function fingerprint(home, directories, files = [], { source = false, prefix = '' } = {}) {
  const entries = [];
  async function visit(name, optional = false) {
    const path = join(home, name);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('Runtime inputs must not be symlinks');
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        if (excluded.has(child) || child.startsWith('.env')) continue;
        await visit(join(name, child));
      }
    } else if (!source || extensions.has(extname(path)) || path.endsWith('Dockerfile')) {
      const normalized = name.replaceAll('\\', '/');
      if (source && generatedBrowserArtifacts.has(normalized)) return;
      entries.push([`${prefix}${normalized}`, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  for (const directory of directories) await visit(directory, true);
  for (const file of files) await visit(file, true);
  entries.sort(([a], [b]) => a.localeCompare(b, 'en'));
  return {
    hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    files: entries.length,
    entries,
  };
}

function validApplication(value) {
  return value && typeof value.name === 'string' && value.name.length > 0 &&
    Array.isArray(value.selectedExamples) &&
    value.selectedExamples.every(item => typeof item === 'string' && item.length > 0) &&
    Object.keys(value).every(key => ['name', 'selectedExamples'].includes(key));
}

function validContract(value) {
  return value && value.version === 1 && Array.isArray(value.capabilities) && value.capabilities.length > 0 &&
    value.capabilities.every(item => ['local', 'setup-check'].includes(item)) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    Object.keys(value).every(key => ['version', 'capabilities'].includes(key));
}

async function validateProjectInput(home, name, expectedType) {
  const parts = name.split(/[\\/]/);
  let current = home;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error('Project inputs must not be links.'), { code: 'SOURCE_INVALID' });
    }
    const expected = index === parts.length - 1 ? expectedType : 'directory';
    if ((expected === 'directory' && !info.isDirectory()) || (expected === 'file' && !info.isFile())) {
      throw Object.assign(new Error(`Project input has the wrong type: ${name}`), { code: 'SOURCE_INVALID' });
    }
  }
}

async function gitEvidence(home) {
  const options = { cwd: home, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 };
  try {
    const { stdout: commit } = await execute('git', ['rev-parse', 'HEAD'], options);
    const { stdout: common } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], options);
    const { stdout: directory } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-dir'], options);
    const { stdout: changes } = await execute('git', ['status', '--porcelain', '--untracked-files=normal', '--',
      ...projectDirectories, ...projectFiles], options);
    return {
      available: true,
      commit: commit.trim(),
      linkedWorktree: common.trim() !== directory.trim(),
      sourceDirty: changes.trim().length > 0,
    };
  } catch (error) {
    return { available: false, code: error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_EVIDENCE_UNAVAILABLE' };
  }
}

async function toolingFingerprint(home) {
  const pkg = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'));
  const packaged = pkg.name === '@microsoft/sql-apps';
  const inputs = packaged
    ? await fingerprint(home, ['dist/scripts', 'dist/src', 'assets'], ['package.json'], { source: true, prefix: 'tooling/' })
    : await fingerprint(home, ['scripts', 'src'], ['package.json', 'runtime-contract.json', 'tsconfig.runtime.json'],
      { source: true, prefix: 'tooling/' });
  return { ...inputs, version: packaged ? pkg.version : pkg.version, packaged };
}

async function inspectBuild(home, sourceFingerprint, implementationFingerprint) {
  let metadata;
  try { metadata = JSON.parse(await readFile(join(home, 'dist', 'build-provenance.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { ready: false, code: 'BUILD_UNVERIFIED',
      nextAction: 'No verified build; after approval, use consent-run build (the guarded build) in this project.' };
    return { ready: false, code: 'BUILD_METADATA_INVALID', nextAction: 'Review build metadata, then rebuild this project.' };
  }
  const keys = ['version', 'home', 'sourceFingerprint', 'toolingFingerprint', 'artifactFingerprint', 'builtAt'];
  if (metadata.version !== 2 || metadata.home !== home ||
      ![metadata.sourceFingerprint, metadata.toolingFingerprint, metadata.artifactFingerprint]
        .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
      typeof metadata.builtAt !== 'string' || !Number.isFinite(Date.parse(metadata.builtAt)) ||
      Object.keys(metadata).some(key => !keys.includes(key))) {
    return { ready: false, code: 'BUILD_METADATA_INVALID',
      nextAction: 'Build provenance is invalid or belongs to another project; rebuild after approval.' };
  }
  if (metadata.sourceFingerprint !== sourceFingerprint) {
    return { ready: false, code: 'BUILD_SOURCE_MISMATCH',
      nextAction: 'Project source changed after the build; after approval, use consent-run build (the guarded build).' };
  }
  if (metadata.toolingFingerprint !== implementationFingerprint) {
    return { ready: false, code: 'BUILD_TOOLING_MISMATCH',
      nextAction: 'Tooling changed after the build; review the upgrade, then use consent-run build (the guarded build).' };
  }
  const artifacts = await fingerprint(home, ['dist/src', 'dist/functions'], [...generatedBrowserArtifacts]);
  if (!artifacts.files || artifacts.hash !== metadata.artifactFingerprint) {
    return { ready: false, code: 'BUILD_ARTIFACT_MISMATCH',
      nextAction: 'Runtime artifacts changed or are missing; after approval, use consent-run build (the guarded build).' };
  }
  return { ready: true, code: 'BUILD_CURRENT', artifactFingerprint: artifacts.hash, builtAt: metadata.builtAt };
}

export async function inspectSource(value, options = {}) {
  const home = await realpath(value);
  const tools = await realpath(options.toolingHome ?? await toolingHome(import.meta.url));
  try {
    const sourcePackage = home === tools
      ? JSON.parse(await readFile(join(home, 'package.json'), 'utf8'))
      : null;
    if (options.foundation === true || sourcePackage?.name === 'sql-apps') {
      const [pkg, application, contract] = await Promise.all([
        readFile(join(home, 'package.json'), 'utf8').then(JSON.parse),
        readFile(join(home, 'application.json'), 'utf8').then(JSON.parse),
        readFile(join(home, 'runtime-contract.json'), 'utf8').then(JSON.parse),
      ]);
      if (pkg.name !== 'sql-apps' || !validApplication(application) || !validContract(contract)) {
        return { home, ready: false, code: 'SOURCE_INVALID',
          nextAction: 'Review the tooling source application/runtime contract.' };
      }
      const inputs = await fingerprint(home,
        ['src', 'functions/src', 'public', 'sql', 'dab', 'infra', 'scripts', 'packages/sql-apps'],
        ['package.json', 'package-lock.json', 'application.json', 'runtime-contract.json',
          'tsconfig.json', 'tsconfig.runtime.json'], { source: true });
      const implementation = await toolingFingerprint(tools);
      return {
        home, toolingHome: tools, ready: true, code: 'SOURCE_READY', packageVersion: pkg.version ?? null,
        application, contract, fingerprint: inputs.hash, toolingFingerprint: implementation.hash,
        inputFiles: inputs.files, git: await gitEvidence(home),
        build: await inspectBuild(home, inputs.hash, implementation.hash),
      };
    }
    const [project, pkg, application, toolingPackage] = await Promise.all([
      readProjectManifest(home),
      readFile(join(home, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(home, 'application.json'), 'utf8').then(JSON.parse),
      readFile(join(tools, 'package.json'), 'utf8').then(JSON.parse),
    ]);
    const installedVersion = toolingPackage.name === '@microsoft/sql-apps'
      ? toolingPackage.version
      : JSON.parse(await readFile(join(tools, 'packages', 'sql-apps', 'package.json'), 'utf8')).version;
    const contractPath = toolingPackage.name === '@microsoft/sql-apps'
      ? join(tools, 'assets', 'runtime-contract.json')
      : join(tools, 'runtime-contract.json');
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    if (pkg.dependencies?.['@microsoft/sql-apps'] !== project.tooling.version ||
        project.tooling.version !== installedVersion || !validApplication(application) || !validContract(contract)) {
      return { home, ready: false, code: 'SOURCE_INVALID',
        nextAction: 'Review the project manifest, exact tooling dependency, application and runtime contract.' };
    }
    const required = [
      ['src', 'directory'],
      ['public/index.html', 'file'],
      ['public/style.css', 'file'],
      ['sql/database.sqlproj', 'file'],
      ['dab/dab-config.json', 'file'],
      ['package.json', 'file'],
      ['package-lock.json', 'file'],
      ['application.json', 'file'],
      ['tsconfig.json', 'file'],
      ['.config/dotnet-tools.json', 'file'],
      ...(project.profile === 'role-based-data' ? [['role-based-data.json', 'file']] : []),
    ];
    for (const [name, type] of required) await validateProjectInput(home, name, type);
    const inputs = await fingerprint(home, projectDirectories, projectFiles, { source: true });
    const implementation = await toolingFingerprint(tools);
    return {
      home,
      toolingHome: tools,
      ready: true,
      code: 'SOURCE_READY',
      packageVersion: pkg.version ?? null,
      project,
      application,
      contract,
      fingerprint: inputs.hash,
      toolingFingerprint: implementation.hash,
      inputFiles: inputs.files,
      git: await gitEvidence(home),
      build: await inspectBuild(home, inputs.hash, implementation.hash),
    };
  } catch (error) {
    if (['ENOENT', 'PROJECT_MANIFEST_INVALID'].includes(error.code)) return {
      home, ready: false, code: 'SOURCE_INCOMPLETE',
      nextAction: 'This project lacks required generated-project inputs; regenerate or restore this project, not the foundation tree.',
    };
    if (error instanceof SyntaxError || error.code === 'SOURCE_INVALID') return {
      home, ready: false, code: 'SOURCE_INVALID',
      nextAction: 'Correct the project JSON manifests and linked-path violations before proceeding.',
    };
    throw error;
  }
}

export async function findActiveHome(directory) {
  try { return await projectHome({}, directory); }
  catch (error) {
    if (error.code === 'PROJECT_NOT_FOUND') {
      let candidate = await realpath(directory);
      while (true) {
        try {
          const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
          if (typeof pkg.dependencies?.['@microsoft/sql-apps'] === 'string') return candidate;
        } catch (readError) {
          if (readError.code !== 'ENOENT') throw readError;
        }
        const parent = dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
      }
    }
    throw error;
  }
}

export async function checkWorkspace({ home, activeDirectory = process.cwd(), bindingSource, explicitHome = false,
  tooling: tools, foundation = false }) {
  const bound = await inspectSource(home, { toolingHome: tools, foundation });
  const activeHome = await findActiveHome(activeDirectory);
  const mismatch = activeHome !== null && activeHome !== bound.home;
  const activeSource = activeHome
    ? (mismatch ? await inspectSource(activeHome, { toolingHome: tools, foundation }) : bound)
    : null;
  const allowed = bound.ready && (!mismatch || explicitHome);
  let runtime;
  if (bound.ready) {
    const { runtimeFor } = await import(pathToFileURL(join(bound.toolingHome, 'dist', 'src', 'workspace.mjs')).href)
      .catch(() => import(pathToFileURL(join(bound.toolingHome, 'src', 'workspace.mjs')).href));
    const selected = runtimeFor(undefined, bound.home);
    runtime = {
      id: selected.id, mode: selected.mode, defaultSql: selected.defaultSql,
      ports: selected.ports, origins: selected.origins, stateDirectory: selected.stateDirectory,
    };
  }
  return {
    version: 1,
    active: { home: activeHome, source: activeSource },
    bound,
    binding: {
      source: bindingSource, explicit: explicitHome, mismatch,
      code: mismatch && !explicitHome ? 'EXPLICIT_HOME_REQUIRED' : 'HOME_SELECTED',
    },
    executionAllowed: allowed,
    runtime,
    nextAction: !allowed ? (mismatch && !explicitHome
      ? 'Select the intended project explicitly; do not change project bindings implicitly.'
      : bound.nextAction) : bound.build?.nextAction,
    scope: 'Project/build provenance and project selection only; not local resource ownership or live/cloud acceptance.',
  };
}

export async function recordBuild(value, expectedFingerprint, expectedToolingFingerprint, options = {}) {
  const source = await inspectSource(value, options);
  if (!source.ready) throw new Error(`Cannot record build provenance: ${source.code}`);
  if (expectedFingerprint && expectedFingerprint !== source.fingerprint) {
    throw new Error('Source changed during build; rebuild before running the application');
  }
  if (expectedToolingFingerprint && expectedToolingFingerprint !== source.toolingFingerprint) {
    throw new Error('Tooling changed during build; rebuild before running the application');
  }
  const artifacts = await fingerprint(source.home, ['dist/src', 'dist/functions'], [...generatedBrowserArtifacts]);
  if (!artifacts.files) throw new Error('No runtime artifacts to record');
  const target = join(source.home, 'dist', 'build-provenance.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify({
      version: 2,
      home: source.home,
      sourceFingerprint: source.fingerprint,
      toolingFingerprint: source.toolingFingerprint,
      artifactFingerprint: artifacts.hash,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const home = await projectHome();
  const tools = await toolingHome(import.meta.url);
  checkWorkspace({ home, activeDirectory: process.cwd(), bindingSource: 'project-context', tooling: tools })
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.executionAllowed) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Workspace inspection failed; review the generated project manifests and permissions.');
      process.exitCode = 1;
    });
}
