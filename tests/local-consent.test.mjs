import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, copyFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { planConsent, assertConsent, grantConsent, revokeConsent, acknowledgeTerms } from '../src/local-consent.mjs';
import { initializeWorkspace } from '../src/workspace.mjs';
import { withFileLock } from '../src/file-lock.mjs';
const execute = promisify(execFile);
const cli = resolve('scripts/local-consent.mjs');

async function fixture(t, selected = false) {
  const home = await mkdtemp(join(tmpdir(), 'sql-apps-consent-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'sql-apps', scripts: { build: 'node scripts/build-provenance.mjs' } }),
    'package-lock.json': '{"lockfileVersion":3}',
    '.config/dotnet-tools.json': '{}',
    'sql/database.sqlproj': '<Project />',
    'sql/grant-runtime.sql': '-- grants',
    'sql/local/acceptance.sql': '-- acceptance',
    'sql/local/application-acceptance.sql': '-- read only',
    'dab/dab-config.json': '{}',
    'src/local.ts': '// SQL operations',
    'src/local-cli.ts': '// dispatch',
    'src/local-services.ts': '// services',
    'src/local-settings.ts': '// defaults',
    'src/local-maintenance.ts': '// maintenance',
    'src/local-services-smoke.ts': '// restart test',
    'src/local-app-smoke.ts': '// browser/API test',
    'src/local-job-data.ts': '// fixtures',
    'src/local-app.ts': '// gateway',
    'src/selected-local.ts': '// selected app',
    'src/artifacts.ts': '// pinned images',
    'scripts/build-provenance.mjs': '// build',
    'tsconfig.runtime.json': '{}',
    'functions/local.Dockerfile': 'FROM fixture',
    'functions/local-package.json': '{}',
    'functions/local-host.json': '{}',
    'functions/src/local-index.ts': '// timer',
    'role-based-data.json': '{"profile":"role-based-data","requiredRole":"AppUser","readinessPath":"/api/Ready"}',
    'src/role-based-profile.ts': '// role procedure grants',
    'examples/todo/demo/smoke.mjs': '// selected acceptance',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(home, file, '..'), { recursive: true });
    await writeFile(join(home, file), content);
  }
  if (selected) await initializeWorkspace(home, 30000, async () => 'free');
  return home;
}

test('read-only commands remain available without grants or state creation', async t => {
  const home = await fixture(t);
  for (const operation of ['help', 'workspace-plan', 'verify', 'app-check']) {
    assert.equal((await planConsent(home, { operation })).allowed, true);
  }
  await assert.rejects(readFile(join(home, '.sql-apps', 'consent.json')), { code: 'ENOENT' });
});

test('composite startup lists every missing scope before any mutation', async t => {
  const home = await fixture(t, true);
  const plan = await planConsent(home, { operation: 'role-based-app' });
  assert.equal(plan.allowed, false);
  assert.deepEqual(plan.requirements.map(item => item.scope), ['restore', 'build', 'sql-start', 'schema', 'services']);
  await assert.rejects(assertConsent(home, { operation: 'role-based-app' }), /Missing local permission/);
  await assert.rejects(readFile(join(home, '.sql-apps', 'consent.json')), { code: 'ENOENT' });
});

test('unknown operations and missing workspace fail explicitly', async t => {
  const home = await fixture(t);
  await assert.rejects(planConsent(home, { operation: 'azure' }), /Unsupported consent operation: azure.*role-based-app/);
  await assert.rejects(planConsent(home, { operation: 'app' }), /workspace selection.*consent-plan workspace-init/);
  await assert.rejects(planConsent(home, { operation: 'workspace-init', selection: '30001' }), /port block/);
  await assert.rejects(planConsent(home, { operation: 'app-test', selection: 'external-sql' }), /takes no container selection/);
  const configless = await fixture(t, true);
  await rm(join(configless, 'role-based-data.json'));
  assert.deepEqual((await planConsent(configless, { operation: 'role-based-app' })).requirements.map(item => item.scope),
    ['restore', 'build', 'sql-start', 'schema', 'services'],
    'permission planning must not require domain configuration that launch validates separately');
});

test('permissions persist across reads and revoke without losing other scopes', async t => {
  const home = await fixture(t);
  await grantConsent(home, await planConsent(home, { operation: 'build' }));
  await grantConsent(home, await planConsent(home, { operation: 'restore' }));
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  await writeFile(join(home, 'src/local-app.ts'), '// unrelated UI edit');
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  await revokeConsent(home, 'build');
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, false);
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, true);
  await revokeConsent(home);
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, false);
});

test('an interrupted consent writer does not permanently block grants or revocation', async t => {
  const home = await fixture(t);
  await grantConsent(home, await planConsent(home, { operation: 'restore' }));
  const lock = join(home, '.sql-apps', 'consent.lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 31_000);
  await utimes(lock, old, old);
  await grantConsent(home, await planConsent(home, { operation: 'build' }));
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  await revokeConsent(home, 'build');
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, false);
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, true);
});

test('concurrent consent writers recovering an interrupted lock preserve both grants', async t => {
  const home = await fixture(t);
  await mkdir(join(home, '.sql-apps'));
  const lock = join(home, '.sql-apps', 'consent.lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 31_000);
  await utimes(lock, old, old);
  const build = await planConsent(home, { operation: 'build' });
  const restore = await planConsent(home, { operation: 'restore' });
  await Promise.all([grantConsent(home, build), grantConsent(home, restore)]);
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, true);
});

for (const removed of [true, false]) {
  test(`stale-lock EPERM ${removed ? 'after concurrent removal permits acquisition' : 'with an existing directory remains an error'}`, async t => {
    const home = await fixture(t);
    const lock = join(home, '.sql-apps', 'consent.lock');
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 31_000);
    await utimes(lock, old, old);
    const rmdir = fs.rmdir;
    const denied = Object.assign(new Error('Synthetic Windows directory removal failure'), { code: 'EPERM' });
    let injected = false;
    let writes = 0;
    t.mock.method(fs, 'rmdir', async (...args) => {
      if (args[0] === lock && !injected) {
        injected = true;
        if (removed) await rmdir(...args);
        throw denied;
      }
      return rmdir(...args);
    });
    syncBuiltinESMExports();
    try {
      const operation = withFileLock(lock, async () => { writes++; return 'acquired'; });
      if (removed) {
        assert.equal(await operation, 'acquired');
        assert.equal(writes, 1);
        await assert.rejects(readFile(lock), { code: 'ENOENT' });
      } else {
        await assert.rejects(operation, error => error === denied);
        assert.equal(writes, 0);
        assert.deepEqual(await readdir(lock), []);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test('a live consent lock is protected and a killed owner is recovered immediately', { timeout: 5_000 }, async t => {
  const home = await fixture(t);
  await grantConsent(home, await planConsent(home, { operation: 'restore' }));
  const lock = join(home, '.sql-apps', 'consent.lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(new URL('../src/file-lock.mjs', import.meta.url).href)};
    const timer = setInterval(() => {}, 1000);
    await withFileLock(${JSON.stringify(lock)}, async () => {
      process.stdout.write('locked');
      await new Promise(() => {});
    });
    clearInterval(timer);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  await Promise.race([
    once(child.stdout, 'data'),
    closed.then(() => { throw new Error('Lock owner exited before acquisition'); }),
  ]);
  const old = new Date(Date.now() - 31_000);
  const [owner] = await readdir(lock);
  await utimes(join(lock, owner), old, old);
  await assert.rejects(grantConsent(home, await planConsent(home, { operation: 'build' })), { code: 'EEXIST' });
  assert.equal(child.exitCode, null);
  child.kill('SIGKILL');
  await closed;
  await grantConsent(home, await planConsent(home, { operation: 'build' }));
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, true);
});

test('changed effects invalidate scope and stale plans cannot grant it', async t => {
  const home = await fixture(t);
  const original = await planConsent(home, { operation: 'restore' });
  await grantConsent(home, original);
  await writeFile(join(home, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, false);
  await assert.rejects(grantConsent(home, original), /plan changed/);
});

test('workspace selection preserves checkout grants and targets runtime grants', async t => {
  const home = await fixture(t);
  await grantConsent(home, await planConsent(home, { operation: 'build' }));
  await initializeWorkspace(home, 30000, async () => 'free');
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  await grantConsent(home, await planConsent(home, { operation: 'data' }));
  assert.equal((await planConsent(home, { operation: 'data' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'data', selection: 'external-sql' })).allowed, false);
});

test('terms acknowledgement is separate and detects changed reviewed documents', async t => {
  const home = await fixture(t, true);
  const document = join(home, 'preview-terms.txt');
  await writeFile(document, 'Fixture terms edition one');
  await acknowledgeTerms(home, document);
  const request = { operation: 'start-sql' };
  const initial = await planConsent(home, request);
  assert.equal(initial.termsAcknowledged, true);
  assert.equal(initial.allowed, false);
  await grantConsent(home, initial);
  assert.equal((await planConsent(home, request)).allowed, true);
  await assertConsent(home, request);
  assert.equal((await planConsent(home, request)).allowed, true);
  await writeFile(document, 'Fixture terms edition two');
  assert.equal((await planConsent(home, request)).allowed, false);
  await assert.rejects(assertConsent(home, request), /terms acknowledgement/);
  await acknowledgeTerms(home, document);
  assert.equal((await planConsent(home, request)).allowed, true);
  await revokeConsent(home, 'terms');
  assert.equal((await planConsent(home, request)).termsAcknowledged, false);
});

test('copied, malformed and symlink state fail without resetting records', async t => {
  const home = await fixture(t);
  const other = await fixture(t);
  await grantConsent(home, await planConsent(home, { operation: 'build' }));
  await mkdir(join(other, '.sql-apps'));
  await copyFile(join(home, '.sql-apps', 'consent.json'), join(other, '.sql-apps', 'consent.json'));
  await assert.rejects(planConsent(other, { operation: 'build' }), /another checkout/);
  await writeFile(join(home, '.sql-apps', 'consent.json'), '{bad');
  await assert.rejects(planConsent(home, { operation: 'build' }), /Invalid.*JSON/);
  assert.equal(await readFile(join(home, '.sql-apps', 'consent.json'), 'utf8'), '{bad');
  const linked = await fixture(t);
  await symlink(join(other, '.sql-apps'), join(linked, '.sql-apps'), 'junction');
  await assert.rejects(planConsent(linked, { operation: 'build' }), /symlink/);
});

test('concurrent grants preserve both scopes and repeated grants are deduplicated', async t => {
  const home = await fixture(t);
  const build = await planConsent(home, { operation: 'build' });
  const restore = await planConsent(home, { operation: 'restore' });
  await Promise.all([grantConsent(home, build), grantConsent(home, restore)]);
  await grantConsent(home, build);
  const state = JSON.parse(await readFile(join(home, '.sql-apps', 'consent.json')));
  assert.equal(state.grants.length, 2);
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'restore' })).allowed, true);
});

test('destructive recovery and maintenance grants are one-operation only', async t => {
  const home = await fixture(t, true);
  const document = join(home, 'terms.txt');
  await writeFile(document, 'Fixture terms');
  await acknowledgeTerms(home, document);
  for (const operation of ['recover-sql', 'maintain']) {
    const plan = await planConsent(home, { operation });
    assert.ok(plan.requirements.every(item => !item.reusable));
    await assert.rejects(grantConsent(home, plan), /one-operation/);
    await grantConsent(home, plan, { once: true });
    assert.equal((await planConsent(home, { operation })).allowed, true);
    await assertConsent(home, { operation });
    assert.equal((await planConsent(home, { operation })).allowed, false);
  }
});

test('pre-build CLI manages grants across processes without dependencies', async t => {
  const home = await fixture(t);
  const options = { cwd: home };
  let result = await execute(process.execPath, [cli, 'plan', 'build'], options);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.allowed, false);
  const approved = join(home, 'approved.json');
  await writeFile(approved, JSON.stringify(plan));
  await execute(process.execPath, [cli, 'grant', approved], options);
  result = await execute(process.execPath, [cli, 'status', 'build'], options);
  assert.equal(JSON.parse(result.stdout).allowed, true);
  await execute(process.execPath, [cli, 'revoke', 'build'], options);
  result = await execute(process.execPath, [cli, 'status', 'build'], options);
  assert.equal(JSON.parse(result.stdout).allowed, false);
  await assert.rejects(execute(process.execPath, [cli, 'grant', 'relative.json'], options), /absolute/);
  await assert.rejects(execute(process.execPath, [cli, 'run', 'build'], options), /Missing local permission/);
});

test('CLI grants a freshly reviewed plan without a temporary file', async t => {
  const home = await fixture(t);
  const options = { cwd: home };
  await execute(process.execPath, [cli, 'grant', '--plan-from', 'build'], options);
  assert.equal(JSON.parse((await execute(process.execPath, [cli, 'status', 'build'], options)).stdout).allowed, true);
  await assert.rejects(execute(process.execPath, [cli, 'grant', '--plan-from'], options), /Usage/);
  await assert.rejects(execute(process.execPath, [cli, 'grant', '--plan-from', 'app'], options), /workspace selection/);
});

test('setup approval lists one bundle and setup approve records it without a temporary file', async t => {
  const home = await fixture(t);
  const setupCli = resolve('scripts/setup.mjs');
  const options = { cwd: home };
  const shown = (await execute(process.execPath, [setupCli, 'approval', '--profile', 'role-based-data', '--workspace', '30000'], options)).stdout;
  assert.match(shown, /One local approval for role-based-data/);
  for (const scope of ['workspace', 'restore', 'build', 'sql-start', 'schema', 'services']) assert.match(shown, new RegExp(`^- ${scope}: `, 'm'));
  assert.match(shown, /^- SQL terms \(accepting\): .*ACCEPT_EULA=Y/m);
  assert.match(shown, /Not included: tool installs/);
  const id = shown.match(/--approval ([a-f0-9]{12})/)[1];
  await assert.rejects(execute(process.execPath, [setupCli, 'approve', '--profile', 'role-based-data', '--workspace', '30000'], options), /--approval/);
  await assert.rejects(execute(process.execPath, [setupCli, 'approval', '--profile', 'role-based-data', '--approval', id], options), /only with setup approve/);
  const recorded = (await execute(process.execPath, [setupCli, 'approve', '--profile', 'role-based-data', '--workspace', '30000', '--approval', id], options)).stdout;
  assert.match(recorded, /Next: setup run --profile role-based-data --workspace 30000/);
  assert.match((await execute(process.execPath, [setupCli, 'approval', '--profile', 'role-based-data', '--workspace', '30000'], options)).stdout, /Already approved/);
});

test('guarded execution denies before the runner and passes only approved operations', async t => {
  const { main } = await import('../scripts/local-consent.mjs');
  const home = await fixture(t);
  const calls = [];
  const runner = async (command, args, cwd) => { calls.push({ command, args, cwd }); };
  await assert.rejects(main(['run', 'build'], home, runner), /Missing local permission/);
  assert.equal(calls.length, 0);
  await grantConsent(home, await planConsent(home, { operation: 'build' }));
  await main(['run', 'build'], home, runner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [join(home, 'scripts', 'build-provenance.mjs')]);
  await assert.rejects(main(['run', 'azure'], home, runner), /Unsupported/);
});

test('direct local CLI denies before workspace mutation', async t => {
  const home = await fixture(t);
  const local = resolve('dist/src/local-cli.js');
  await assert.rejects(execute(process.execPath, [local, 'workspace-init', '30000'], { cwd: home }), /Missing local permission/);
  await assert.rejects(readFile(join(home, '.sql-apps', 'workspace.json')), { code: 'ENOENT' });
  const plan = await planConsent(home, { operation: 'workspace-init', selection: '30000' });
  await grantConsent(home, plan);
  await execute(process.execPath, [local, 'workspace-init', '30000'], { cwd: home });
  assert.equal(JSON.parse(await readFile(join(home, '.sql-apps', 'workspace.json'))).basePort, 30000);
});

test('startup planning includes implicit SQL fixtures and background retention effects', async t => {
  const home = await fixture(t, true);
  for (const operation of ['app', 'init', 'data']) {
    const plan = await planConsent(home, { operation });
    assert.ok(plan.requirements.some(item => item.scope === 'synthetic'), operation);
  }
  const service = await planConsent(home, { operation: 'services' });
  assert.match(service.requirements[0].effects.join(' '), /retention/);
  await grantConsent(home, service);
  const directory = join(home, '.sql-apps', 'workspaces', JSON.parse(await readFile(join(home, '.sql-apps', 'workspace.json'))).id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'local-settings.json'), '{"retentionDays":7}');
  assert.equal((await planConsent(home, { operation: 'services' })).allowed, false);
});

test('SQL startup grant is shared across matching profiles, not container targets', async t => {
  const home = await fixture(t, true);
  await grantConsent(home, await planConsent(home, { operation: 'start-sql' }));
  assert.ok(!(await planConsent(home, { operation: 'role-based-app' })).missing.some(item => item.scope === 'sql-start'));
  assert.ok((await planConsent(home, { operation: 'start-sql', selection: 'different-sql' })).missing.some(item => item.scope === 'sql-start'));
});

test('every runtime command declares its required scopes', async t => {
  const home = await fixture(t, true);
  const commands = {
    app: ['restore', 'build', 'sql-start', 'schema', 'services', 'synthetic'],
    init: ['restore', 'build', 'schema', 'synthetic'],
    data: ['services', 'synthetic'],
    serve: ['services'], 'serve-sql': ['services'], services: ['services'],
    'role-based-app': ['restore', 'build', 'sql-start', 'schema', 'services'],
    'role-based-serve': ['services'], 'start-sql': ['sql-start'],
    test: ['synthetic'], 'api-test': ['synthetic'], 'app-test': ['synthetic'],
    'services-test': ['services', 'synthetic'],
    stop: ['stop'], 'stop-services': ['stop'], maintain: ['maintenance'], 'recover-sql': ['sql-start'],
  };
  for (const [operation, expected] of Object.entries(commands)) {
    const plan = await planConsent(home, { operation });
    assert.deepEqual(plan.requirements.map(item => item.scope), expected, operation);
    assert.equal(plan.allowed, false, operation);
  }
});

test('application content edits keep grants; launcher and worker changes invalidate only relevant grants', async t => {
  const home = await fixture(t, true);
  await grantConsent(home, await planConsent(home, { operation: 'app' }));
  await grantConsent(home, await planConsent(home, { operation: 'role-based-app' }));
  await writeFile(join(home, 'sql', 'database.sqlproj'), '<Project Changed="true" />');
  await writeFile(join(home, 'sql', 'shifts.sql'), 'CREATE TABLE dbo.Shift (Id int);');
  await writeFile(join(home, 'dab', 'dab-config.json'), '{"entities":{}}');
  await writeFile(join(home, 'role-based-data.json'), '{"profile":"role-based-data","requiredRole":"Volunteer","readinessPath":"/api/Ready"}');
  assert.deepEqual((await planConsent(home, { operation: 'app' })).missing, []);
  assert.deepEqual((await planConsent(home, { operation: 'role-based-app' })).missing, []);
  await writeFile(join(home, 'functions', 'src', 'local-index.ts'), '// changed worker effects');
  assert.deepEqual((await planConsent(home, { operation: 'app' })).missing.map(item => item.scope), ['services']);
  await writeFile(join(home, 'src', 'role-based-profile.ts'), '// changed grant code');
  assert.deepEqual((await planConsent(home, { operation: 'role-based-app' })).missing.map(item => item.scope), ['schema', 'services']);
});

test('one bundle approval covers workspace, startup scopes and inline SQL terms', async t => {
  const { planBundle, grantBundle, SQL_TERMS } = await import('../src/local-consent.mjs');
  const home = await fixture(t);
  const bundle = await planBundle(home, { profile: 'role-based-data', workspace: '30000' });
  assert.equal(bundle.operation, 'role-based-app');
  assert.deepEqual(bundle.requirements.map(item => item.scope), ['workspace', 'restore', 'build', 'sql-start', 'schema', 'services']);
  assert.equal(bundle.terms.required, true);
  assert.equal(bundle.terms.url, SQL_TERMS.url);
  assert.match(bundle.terms.statement, /ACCEPT_EULA=Y/);
  assert.match(bundle.approval, /^[a-f0-9]{12}$/);
  assert.equal(bundle.allowed, false);
  await assert.rejects(readFile(join(home, '.sql-apps', 'consent.json')), { code: 'ENOENT' });
  await assert.rejects(grantBundle(home, { profile: 'role-based-data', workspace: '30000', approval: '000000000000' }), /changed/);
  await grantBundle(home, { profile: 'role-based-data', workspace: '30000', approval: bundle.approval });
  assert.equal((await planConsent(home, { operation: 'workspace-init', selection: '30000' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, true);
  await initializeWorkspace(home, 30000, async () => 'free');
  const startup = await planConsent(home, { operation: 'role-based-app' });
  assert.deepEqual(startup.missing, []);
  assert.equal(startup.termsAcknowledged, true);
  assert.equal(startup.allowed, true);
  assert.equal((await planBundle(home, { profile: 'role-based-data' })).allowed, true);
  assert.equal((await planConsent(home, { operation: 'stop' })).allowed, false);
  const terms = JSON.parse(await readFile(join(home, '.sql-apps', 'terms.json')));
  assert.equal(terms.url, SQL_TERMS.url);
  await writeFile(join(home, '.sql-apps', 'terms.json'), JSON.stringify({ ...terms, sha256: '0'.repeat(64) }));
  assert.equal((await planConsent(home, { operation: 'role-based-app' })).termsAcknowledged, false);
});

test('bundle planning validates profile and workspace and reuses an existing selection', async t => {
  const { planBundle } = await import('../src/local-consent.mjs');
  const home = await fixture(t);
  await assert.rejects(planBundle(home, { profile: 'azure' }), /profile/);
  await assert.rejects(planBundle(home, { profile: 'foundation' }), /workspace/);
  await assert.rejects(planBundle(home, { profile: 'foundation', workspace: '30001' }), /port block/);
  const selected = await fixture(t, true);
  const bundle = await planBundle(selected, { profile: 'foundation' });
  assert.equal(bundle.operation, 'app');
  assert.deepEqual(bundle.requirements.map(item => item.scope), ['restore', 'build', 'sql-start', 'schema', 'services', 'synthetic']);
  await assert.rejects(planBundle(selected, { profile: 'foundation', workspace: '30010' }), /differs/);
});

test('concurrent dispatch consumes a one-operation grant only once, including failed execution', async t => {
  const home = await fixture(t, true);
  const request = { operation: 'maintain' };
  await grantConsent(home, await planConsent(home, request), { once: true });
  const results = await Promise.allSettled([assertConsent(home, request), assertConsent(home, request)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const denial = results.find(item => item.status === 'rejected');
  assert.match(denial.reason.message, /Missing local permission/);
  assert.equal((await planConsent(home, request)).allowed, false);
  await grantConsent(home, await planConsent(home, { operation: 'build' }), { once: true });
  const { main } = await import('../scripts/local-consent.mjs');
  await assert.rejects(main(['run', 'build'], home, async () => { throw new Error('Fixture build failed'); }), /Fixture build failed/);
  assert.equal((await planConsent(home, { operation: 'build' })).allowed, false);
});

test('selected commands bind artifact content and reject another workspace before granting', async t => {
  const home = await fixture(t, true);
  const workspace = JSON.parse(await readFile(join(home, '.sql-apps', 'workspace.json')));
  const directory = join(home, '.sql-apps', 'workspaces', workspace.id, 'applications', 'todo', 'local-simulation', 'artifact');
  await mkdir(directory, { recursive: true });
  const manifest = { home, workspaceId: workspace.id, profile: 'local-simulation', name: 'todo' };
  await writeFile(join(directory, 'application-build.json'), JSON.stringify(manifest));
  for (const folder of ['sql', 'setup', 'server', 'dab', 'public']) await mkdir(join(directory, folder));
  await writeFile(join(directory, 'sql', 'schema.sql'), '-- fixture schema');
  await writeFile(join(directory, 'setup', 'grants.sql'), '-- fixture grants');
  await writeFile(join(directory, 'server', 'application.mjs'), '// fixture server');
  await writeFile(join(directory, 'dab', 'dab-config.json'), '{}');
  await writeFile(join(directory, 'public', 'style.css'), 'body {}');
  for (const [operation, scopes] of Object.entries({
    'selected-app': ['restore', 'build', 'sql-start', 'schema', 'services'],
    'selected-serve': ['services'], 'selected-test': ['synthetic'],
  })) {
    const request = { operation, selection: directory };
    const plan = await planConsent(home, request);
    assert.deepEqual(plan.requirements.map(item => item.scope), scopes);
    await grantConsent(home, plan);
  }
  assert.deepEqual((await planConsent(home, { operation: 'selected-stop', selection: 'todo' })).requirements.map(item => item.scope), ['stop']);
  await writeFile(join(directory, 'public', 'style.css'), 'body { color: blue; }');
  await writeFile(join(directory, 'application-build.json'), JSON.stringify({ ...manifest, sourceFingerprint: 'updated-ui-build' }));
  assert.deepEqual((await planConsent(home, { operation: 'selected-app', selection: directory })).missing, []);
  const rebuilt = join(directory, '..', 'rebuilt');
  const { cp } = await import('node:fs/promises');
  await cp(directory, rebuilt, { recursive: true });
  assert.deepEqual((await planConsent(home, { operation: 'selected-app', selection: rebuilt })).missing, []);
  await writeFile(join(directory, 'sql', 'schema.sql'), '-- changed schema');
  assert.deepEqual((await planConsent(home, { operation: 'selected-app', selection: directory })).missing.map(item => item.scope), ['schema']);
  assert.equal((await planConsent(home, { operation: 'selected-test', selection: directory })).allowed, false);
  await writeFile(join(directory, 'server', 'application.mjs'), '// changed server');
  assert.equal((await planConsent(home, { operation: 'selected-serve', selection: directory })).allowed, false);
  await grantConsent(home, await planConsent(home, { operation: 'selected-test', selection: directory }));
  await writeFile(join(home, 'examples', 'todo', 'demo', 'smoke.mjs'), '// changed acceptance effects');
  assert.equal((await planConsent(home, { operation: 'selected-test', selection: directory })).allowed, false);
  await writeFile(join(directory, 'application-build.json'), JSON.stringify({ ...manifest, workspaceId: 'other' }));
  await assert.rejects(planConsent(home, { operation: 'selected-app', selection: directory }), /another workspace/);
});
