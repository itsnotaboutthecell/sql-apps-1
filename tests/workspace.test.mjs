import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const launcher = resolve('plugins', 'sql-apps', 'scripts', 'sql-apps.mjs');
const load = () => import('../scripts/workspace-check.mjs');

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'sql-apps workspace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const folder of ['src', 'sql', 'plugins/sql-apps', 'public', 'dist/src', 'scripts']) {
    await mkdir(join(home, folder), { recursive: true });
  }
  await writeFile(join(home, 'package.json'), JSON.stringify({
    name: 'sql-apps', version: '0.1.0', scripts: { local: 'node dist/src/local-cli.js' },
  }));
  await writeFile(join(home, 'runtime-contract.json'), JSON.stringify({ version: 1, capabilities: ['local', 'setup-check'] }));
  await writeFile(join(home, 'application.json'), JSON.stringify({ name: 'fixture', selectedExamples: [] }));
  await writeFile(join(home, 'src', 'local-cli.ts'), 'export const source = 1;');
  await writeFile(join(home, 'src', 'workspace.mjs'), await readFile(resolve('src', 'workspace.mjs')));
  await writeFile(join(home, 'sql', 'database.sqlproj'), '<Project />');
  await writeFile(join(home, 'plugins', 'sql-apps', 'plugin.json'), '{}');
  await writeFile(join(home, 'scripts', 'workspace-check.mjs'), await readFile(resolve('scripts', 'workspace-check.mjs')));
  await writeFile(join(home, 'dist', 'src', 'local-cli.js'), 'console.log("EXECUTED");');
  return realpath(home);
}

test('launcher offers a dependency-free workspace report before build', async () => {
  const { stdout } = await execute(process.execPath, [launcher, 'workspace-check'], {
    env: { ...process.env, SQL_APPS_HOME: process.cwd() },
  });
  assert.equal(JSON.parse(stdout).version, 1);
});

test('equal package versions do not hide differing worktree source', async t => {
  const home = await fixture(t);
  const active = await fixture(t);
  await writeFile(join(active, 'src', 'local-cli.ts'), 'export const source = 2;');
  const { checkWorkspace } = await load();
  const report = await checkWorkspace({ home, activeDirectory: active, bindingSource: 'installed-binding' });
  assert.equal(report.executionAllowed, false);
  assert.equal(report.binding.code, 'EXPLICIT_HOME_REQUIRED');
  assert.equal(report.active.source.packageVersion, report.bound.packageVersion);
  assert.notEqual(report.active.source.fingerprint, report.bound.fingerprint);
});

test('explicit home selection permits intentional use of another checkout', async t => {
  const home = await fixture(t);
  const active = await fixture(t);
  const { checkWorkspace } = await load();
  const report = await checkWorkspace({ home, activeDirectory: active, bindingSource: 'environment', explicitHome: true });
  assert.equal(report.executionAllowed, true);
  assert.equal(report.binding.mismatch, true);
});

test('missing uncommitted foundation in an active checkout is reported, not copied', async t => {
  const home = await fixture(t);
  const active = await fixture(t);
  await rm(join(active, 'runtime-contract.json'));
  const { checkWorkspace } = await load();
  const report = await checkWorkspace({ home, activeDirectory: active, bindingSource: 'installed-binding' });
  assert.equal(report.executionAllowed, false);
  assert.equal(report.active.source.code, 'SOURCE_INCOMPLETE');
  await assert.rejects(readFile(join(active, 'runtime-contract.json')), { code: 'ENOENT' });
});

test('build provenance detects missing, changed source and tampered artifacts', async t => {
  const home = await fixture(t);
  const { inspectSource, recordBuild } = await load();
  const guarded = build => {
    assert.match(build.nextAction, /consent-run build/);
    assert.doesNotMatch(build.nextAction, /run npm run build/, 'raw build advice bypasses the guarded approval path');
  };
  guarded((await inspectSource(home)).build);
  assert.equal((await inspectSource(home)).build.code, 'BUILD_UNVERIFIED');
  await recordBuild(home);
  assert.equal((await inspectSource(home)).build.code, 'BUILD_CURRENT');
  await writeFile(join(home, 'src', 'local-cli.ts'), 'export const source = 2;');
  assert.equal((await inspectSource(home)).build.code, 'BUILD_SOURCE_MISMATCH');
  guarded((await inspectSource(home)).build);
  await recordBuild(home);
  await writeFile(join(home, 'dist', 'src', 'local-cli.js'), 'console.log("different");');
  assert.equal((await inspectSource(home)).build.code, 'BUILD_ARTIFACT_MISMATCH');
  guarded((await inspectSource(home)).build);
});

test('build provenance attests the generated callback without treating it as source', async t => {
  const home = await fixture(t);
  const { inspectSource, recordBuild } = await load();
  await mkdir(join(home, 'public', 'auth'), { recursive: true });
  const callback = join(home, 'public', 'auth', 'redirect.js');
  await writeFile(callback, 'export const bridge = 1;');
  const before = (await inspectSource(home)).fingerprint;
  await recordBuild(home);
  assert.equal((await inspectSource(home)).build.code, 'BUILD_CURRENT');
  await writeFile(callback, 'export const bridge = 2;');
  const after = await inspectSource(home);
  assert.equal(after.fingerprint, before);
  assert.equal(after.build.code, 'BUILD_ARTIFACT_MISMATCH');
});

test('source fingerprint excludes credentials, state and dependencies', async t => {
  const home = await fixture(t);
  const { inspectSource } = await load();
  const before = (await inspectSource(home)).fingerprint;
  for (const folder of ['.sql-apps', 'node_modules', 'sql/obj']) await mkdir(join(home, folder), { recursive: true });
  for (const file of ['.env', '.sql-apps/private.json', 'node_modules/private.js', 'sql/obj/secret.sql', 'public/notes.md']) {
    await writeFile(join(home, file), 'secret-not-a-runtime-input');
  }
  const report = await inspectSource(home);
  assert.equal(report.fingerprint, before);
  assert.equal(JSON.stringify(report).includes('secret-not-a-runtime-input'), false);
});

test('provenance cannot certify source changed during compilation', async t => {
  const home = await fixture(t);
  const { inspectSource, recordBuild } = await load();
  const before = (await inspectSource(home)).fingerprint;
  await writeFile(join(home, 'src', 'local-cli.ts'), 'export const source = 3;');
  await assert.rejects(recordBuild(home, before), /Source changed during build/);
  await assert.rejects(readFile(join(home, 'dist', 'build-provenance.json')), { code: 'ENOENT' });
});

test('ZIP checkout without Git has source evidence without inventing a commit', async t => {
  const home = await fixture(t);
  const { inspectSource } = await load();
  const report = await inspectSource(home);
  assert.equal(report.ready, true);
  assert.equal(report.git.available, false);
  assert.match(report.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.contract.version, 1);
});

test('canonical home resolves a junction without a false binding conflict', async t => {
  const home = await fixture(t);
  const parent = await mkdtemp(join(tmpdir(), 'sql-apps alias-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const alias = join(parent, 'alias');
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const { checkWorkspace } = await load();
  const report = await checkWorkspace({ home: alias, activeDirectory: home, bindingSource: 'installed-binding' });
  assert.equal(report.binding.mismatch, false);
  assert.equal(report.executionAllowed, true);
});

test('invalid application selection is rejected with a safe structured source error', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'application.json'), '{"name":"fixture","selectedExamples":"invalid"}');
  const { inspectSource } = await load();
  const report = await inspectSource(home);
  assert.equal(report.ready, false);
  assert.equal(report.code, 'SOURCE_INVALID');
});

test('current project takes precedence over the foundation binding and explicit home still overrides it', async t => {
  const home = await fixture(t);
  const active = await fixture(t);
  const profile = await mkdtemp(join(tmpdir(), 'sql-apps binding-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, 'sql-apps-local.json'), JSON.stringify({ version: 1, home }));
  const { recordBuild } = await load();
  await recordBuild(home);
  await recordBuild(active);
  const env = { ...process.env, COPILOT_HOME: profile };
  delete env.SQL_APPS_HOME;
  const current = await execute(process.execPath, [launcher, 'verify'], { cwd: active, env });
  assert.match(current.stdout, /EXECUTED/);
  const selected = await execute(process.execPath, [launcher, 'verify'], {
    cwd: active, env: { ...env, SQL_APPS_HOME: home },
  });
  assert.match(selected.stdout, /EXECUTED/);
});
