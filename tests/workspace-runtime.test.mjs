import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const load = () => import('../src/workspace.mjs');
async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps isolated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

test('Windows short paths use the same canonical workspace identity', { skip: process.platform !== 'win32' }, async t => {
  const { stdout } = await promisify(execFile)(process.env.ComSpec,
    ['/d', '/c', `for %I in ("${process.env.ProgramFiles}") do @echo %~sI`], { windowsVerbatimArguments: true });
  const alias = stdout.trim();
  const canonical = await realpath(alias);
  if (alias === canonical) return t.skip('8.3 paths are unavailable on this filesystem');
  const { describeWorkspace, runtimeFor } = await load();
  assert.deepEqual(describeWorkspace(alias, 30000), describeWorkspace(canonical, 30000));
  assert.deepEqual(runtimeFor(undefined, alias), runtimeFor(undefined, canonical));
});

test('workspace candidates derive distinct ports, names and state from canonical home', async t => {
  const first = await home(t);
  const second = await home(t);
  const { proposeWorkspace, initializeWorkspace, runtimeFor } = await load();
  const a = await proposeWorkspace(first, async () => 'free');
  const b = await proposeWorkspace(second, async () => 'free');
  assert.notEqual(a.descriptor.id, b.descriptor.id);
  await initializeWorkspace(first, a.descriptor.basePort, async () => 'free');
  await initializeWorkspace(second, b.descriptor.basePort, async () => 'free');
  const one = runtimeFor(undefined, first);
  const two = runtimeFor(undefined, second);
  assert.notEqual(one.defaultSql, two.defaultSql);
  assert.notEqual(one.names.data, two.names.data);
  assert.notEqual(one.stateDirectory, two.stateDirectory);
  assert.notEqual(one.database, two.database);
  assert.notEqual(one.login, two.login);
  assert.deepEqual(one.ports, { gateway: a.descriptor.basePort, data: a.descriptor.basePort + 1, sql: a.descriptor.basePort + 5 },
    'fixed offsets keep existing isolated workspaces on the same SQL port');
  assert.equal(one.origins.app, `http://127.0.0.1:${one.ports.gateway}`);
  assert.equal(one.defaultSql, `sql-apps-${one.id}-sql`);
  assert.equal(one.database, `sql_apps_local_${one.id}`);
  assert.equal(one.login, `sql_apps_local_dab_${one.id}`);
  assert.equal(one.stateDirectory, join(first, '.sql-apps', 'workspaces', one.id));
  assert.deepEqual(one.labels, ['--label', `sql-apps.workspace=${one.id}`]);
  assert.deepEqual(runtimeFor(undefined, first), one);
});

test('occupied deterministic candidate produces a free alternate proposal without persistence', async t => {
  const root = await home(t);
  const { proposeWorkspace, workspaceFile } = await load();
  let checks = 0;
  const report = await proposeWorkspace(root, async () => ++checks <= 3 ? 'occupied' : 'free');
  assert.equal(report.conflicts.length, 3);
  assert.ok(report.alternative);
  assert.notEqual(report.descriptor.basePort, report.alternative.basePort);
  await assert.rejects(readFile(workspaceFile(root)), { code: 'ENOENT' });
});

test('endpoint workspace proposals and initialization never reserve a container SQL port', async t => {
  const root = await home(t);
  const { proposeWorkspace, initializeWorkspace } = await load();
  const checked = [];
  const proposal = await proposeWorkspace(root, async port => { checked.push(port); return 'free'; }, { includeSql: false });
  assert.equal(checked.length, 2);
  assert.deepEqual(proposal.ports.map(item => item.name), ['gateway', 'data']);
  await mkdir(join(root, '.sql-apps'), { recursive: true });
  await writeFile(join(root, '.sql-apps', 'sql-target.json'), JSON.stringify({ version: 1, home: root,
    target: { version: 1, provider: 'express', instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' } }));
  checked.length = 0;
  await initializeWorkspace(root, proposal.descriptor.basePort, async port => { checked.push(port); return 'free'; });
  assert.deepEqual(checked, [proposal.descriptor.basePort, proposal.descriptor.basePort + 1]);
});

test('initialization requires an explicit available port block and never replaces a descriptor', async t => {
  const root = await home(t);
  const { initializeWorkspace, workspaceFile } = await load();
  await assert.rejects(initializeWorkspace(root, 25000, async () => 'occupied'), /occupied/);
  await assert.rejects(readFile(workspaceFile(root)), { code: 'ENOENT' });
  await initializeWorkspace(root, 25000, async () => 'free');
  const original = await readFile(workspaceFile(root), 'utf8');
  await assert.rejects(initializeWorkspace(root, 26000, async () => 'free'), /already selected/);
  assert.equal(await readFile(workspaceFile(root), 'utf8'), original);
  for (const port of [10000, 65535, NaN, 25001]) {
    await assert.rejects(initializeWorkspace(await home(t), port, async () => 'free'), /port block/);
  }
});

test('copied workspace descriptors fail instead of sharing another home resources', async t => {
  const first = await home(t);
  const second = await home(t);
  const { initializeWorkspace, workspaceFile, runtimeFor } = await load();
  await initializeWorkspace(first, 28000, async () => 'free');
  await mkdir(join(second, '.sql-apps'));
  await writeFile(workspaceFile(second), await readFile(workspaceFile(first)));
  assert.throws(() => runtimeFor(undefined, second), /another checkout/);
});

test('fixed-port legacy selection preserves SQL Apps defaults, names and state', async t => {
  const root = await home(t);
  const { runtimeFor, initializeWorkspace } = await load();
  const legacy = runtimeFor('owned-sql', root);
  assert.equal(legacy.mode, 'legacy-unselected');
  assert.equal(legacy.ports.gateway, 18080);
  assert.equal(legacy.ports.data, 15000);
  await initializeWorkspace(root, 'legacy');
  const selected = runtimeFor('owned-sql', root);
  assert.equal(selected.mode, 'legacy');
  assert.deepEqual(selected.names, legacy.names);
  assert.equal(selected.stateDirectory, legacy.stateDirectory);
  assert.equal(selected.database, 'sql_apps_local');
  assert.equal(selected.login, 'sql_apps_local_dab');
});

test('external SQL selection scopes downstream resources without claiming SQL ownership', async t => {
  const root = await home(t);
  const { initializeWorkspace, runtimeFor } = await load();
  await initializeWorkspace(root, 29000, async () => 'free');
  const selected = runtimeFor('sqldbdev', root);
  assert.equal(selected.sqlContainer, 'sqldbdev');
  assert.equal(selected.ownsSqlName, false);
  assert.notEqual(selected.names.data, runtimeFor(undefined, root).names.data);
  const second = await home(t);
  await initializeWorkspace(second, 29010, async () => 'free');
  const other = runtimeFor('sqldbdev', second);
  assert.equal(other.sqlContainer, selected.sqlContainer);
  assert.notEqual(other.database, selected.database);
  assert.notEqual(other.login, selected.login);
  assert.notEqual(other.names.data, selected.names.data);
});
