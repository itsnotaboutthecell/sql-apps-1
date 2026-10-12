import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { before, test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = join(root, 'dist', 'tooling-package');

async function runNode(args, options = {}) {
  return execute(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function pathsBelow(directory) {
  const paths = [];
  async function visit(current) {
    for (const entry of await readdir(current)) {
      const path = join(current, entry);
      const stat = await lstat(path);
      paths.push(relative(directory, path).replaceAll('\\', '/'));
      if (stat.isDirectory()) await visit(path);
    }
  }
  await visit(directory);
  return paths.sort();
}

before(async () => {
  await runNode([join(root, 'scripts', 'build-provenance.mjs')]);
  await runNode([join(root, 'scripts', 'build-tooling-package.mjs')]);
});

test('stages publishable package metadata with synchronized exact runtime dependencies', async () => {
  const [pkg, source, rootPackage] = await Promise.all([
    readFile(join(staged, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'packages', 'sql-apps', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const expectedDependencies = {
    ...rootPackage.dependencies,
    esbuild: rootPackage.devDependencies.esbuild,
    typescript: rootPackage.devDependencies.typescript,
  };

  for (const candidate of [source, pkg]) {
    assert.equal(candidate.name, '@microsoft/sql-apps');
    assert.equal(candidate.version, '0.1.1');
    assert.equal(candidate.type, 'module');
    assert.deepEqual(candidate.bin, { 'sql-apps': 'bin/sql-apps.mjs' });
    assert.equal(Object.hasOwn(candidate, 'private'), false);
    assert.deepEqual(candidate.files, ['bin', 'dist', 'assets']);
    assert.equal(candidate.license, 'MIT');
    assert.deepEqual(candidate.engines, { node: '>=22 <23 || >=24 <25' });
    assert.deepEqual(candidate.exports, {
      './project-contract': './dist/src/project-contract.mjs',
    });
    assert.deepEqual(candidate.dependencies, expectedDependencies);
    for (const version of Object.values(candidate.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    }
  }
});

test('staged tree contains only package files and immutable runtime assets', async () => {
  const paths = await pathsBelow(staged);
  const excluded = /(^|\/)(?:\.git|\.sql-apps|examples|tests|node_modules|plugins)(?:\/|$)|(^|\/)\.env[^/]*$/;
  assert.equal(paths.some(path => excluded.test(path)), false, paths.join('\n'));
  assert.equal(paths.some(path => path.startsWith('src/') || path.startsWith('scripts/')), false);
  assert(paths.includes('LICENSE'));
  assert(paths.includes('bin/sql-apps.mjs'));
  assert(paths.includes('dist/src/project-contract.mjs'));
  for (const path of paths) {
    assert.equal((await lstat(join(staged, path))).isSymbolicLink(), false, path);
  }
});

test('bin help is project-independent and its validated command map targets packaged modules', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'sql-apps-bin-'));
  try {
    const bin = join(staged, 'bin', 'sql-apps.mjs');
    const result = await runNode([bin, '--help'], { cwd: empty });
    assert.match(result.stdout, /Usage: sql-apps <command>/);
    assert.equal(result.stderr, '');

    const module = await import(`${pathToFileURL(bin).href}?test=${Date.now()}`);
    assert.deepEqual(module.COMMANDS, {
      build: 'dist/scripts/build-provenance.mjs',
      setup: 'dist/scripts/setup.mjs',
      'setup-check': 'dist/scripts/setup-check.mjs',
      guide: 'dist/scripts/guide.mjs',
      'workspace-check': 'dist/scripts/workspace-check.mjs',
      consent: 'dist/scripts/local-consent.mjs',
      local: 'dist/src/local-cli.js',
      azure: 'dist/src/cli.js',
      check: 'dist/scripts/check-application.mjs',
    });
    const originalArgv = process.argv;
    const originalHome = process.env.SQL_APPS_PROJECT_HOME;
    let imported;
    try {
      await module.dispatch('setup', ['status'], empty, async specifier => { imported = specifier; });
      assert.equal(process.env.SQL_APPS_PROJECT_HOME, empty);
      assert.deepEqual(process.argv.slice(2), ['status']);
      assert.equal(fileURLToPath(imported), join(staged, 'dist', 'scripts', 'setup.mjs'));
    } finally {
      process.argv = originalArgv;
      if (originalHome === undefined) delete process.env.SQL_APPS_PROJECT_HOME;
      else process.env.SQL_APPS_PROJECT_HOME = originalHome;
    }
    await assert.rejects(runNode([bin, 'unknown'], { cwd: empty }), error => {
      assert.match(error.stderr, /Unknown command/);
      return true;
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('package tree validation rejects links', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'sql-apps-package-link-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'bin'));
  await writeFile(join(fixture, 'target'), 'target');
  try {
    await symlink(join(fixture, 'target'), join(fixture, 'bin', 'linked'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const { validatePackageTree } = await import('../scripts/check-tooling-package.mjs');
  await assert.rejects(validatePackageTree(fixture), /link/i);
});

test('tooling package check validates npm dry-run contents', async () => {
  const result = await runNode([join(root, 'scripts', 'check-tooling-package.mjs')]);
  assert.match(result.stdout, /Tooling package checks passed/);
});
