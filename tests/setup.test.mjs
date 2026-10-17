import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSetup, parseArguments } from '../scripts/setup-check.mjs';
import * as setup from '../scripts/setup-check.mjs';
import { initializeWorkspace, runtimeFor } from '../src/workspace.mjs';

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    platform: 'win32', architecture: 'x64', nodeVersion: '22.22.2', memoryBytes: 8 * 1024 ** 3,
    read: async path => {
      if (path.endsWith('package.json')) return '{"name":"sql-apps","engines":{"node":">=22 <23 || >=24 <25"}}';
      if (path.endsWith('local.ts')) return "const sqlImage = 'preview.example/azure-sql/db-dev:latest';";
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
    exists: async () => true,
    port: async () => 'free',
    fetch: async () => new Response('{}'),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'npm') return '10.9.4';
      if (command === 'dotnet') return args[0] === '--list-sdks' ? '8.0.421 [SDK]' :
        args[0] === '--list-runtimes' ? 'Microsoft.NETCore.App 8.0.27 [runtime]\nMicrosoft.AspNetCore.App 8.0.27 [runtime]' : '8.0.421';
      if (args[0] === '--version') return 'Docker version 28.0.0';
      if (args[0] === 'info') return '{"OSType":"linux","Architecture":"x86_64","MemTotal":8589934592}';
      if (args[0] === 'image') return '[{"Architecture":"amd64","Os":"linux"}]';
      if (args[0] === 'ps') return '';
      if (args[0] === 'container') return '{"status":"running","owner":"","image":"user-image"}';
      throw new Error('Unexpected probe');
    },
    ...overrides,
  };
}

test('read-only pre-build diagnostics work on Windows, macOS and Linux without dependencies', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const deps = fixture({ platform, exists: async () => false });
    const report = await checkSetup({ root: process.cwd() }, deps);
    assert.equal(report.ready, true);
    assert.equal(report.platform, platform);
    assert.equal(report.checks.find(c => c.id === 'dependencies').required, false);
    assert.equal(report.checks.find(c => c.id === 'build').status, 'action-required');
    assert.ok(deps.calls.every(call => !call.some(value => ['pull', 'run', 'login', 'start', 'stop', 'rm', 'install', 'restore'].includes(value))));
    assert.ok(deps.calls.every(call => !call.some(value => value.includes('Config.Env'))));
  }
});

test('missing preview access offers Azure SQL before Express without running login or installation', async () => {
  const base = fixture();
  const deps = fixture({ run: async (command, args) => {
    if (command === 'docker' && args[0] === 'image') throw new Error('not cached');
    return base.run(command, args);
  } });
  const report = await checkSetup({ root: process.cwd() }, deps);
  assert.equal(report.sqlRoutes?.recommended, 'azure');
  assert.deepEqual(report.sqlRoutes.routes.map(route => route.provider), ['container', 'azure', 'express']);
  assert.equal(report.ready, false, 'an alternative is not approval or database readiness');
  assert.equal(base.calls.some(call => call.includes('login') || call.includes('install')), false);
});

test('unsupported hosts do not recommend an Express installation', async () => {
  const report = await checkSetup({ root: process.cwd() }, fixture({ platform: 'darwin', architecture: 'arm64' }));
  assert.equal(report.sqlRoutes?.routes.find(route => route.provider === 'express').availability, 'unavailable');
});

test('selected Azure and Express prerequisites do not probe Docker or require preview access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-endpoint-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const provider of ['azure', 'express']) {
    const target = provider === 'azure' ? { version: 1, provider, server: 'example.database.windows.net', database: 'development',
      subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'development' } :
      { version: 1, provider, instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' };
    const path = join(root, `${provider}.json`);
    await writeFile(path, JSON.stringify(target));
    const base = fixture(), calls = [];
    const deps = fixture({ run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'az') return JSON.stringify({ id: target.subscriptionId, tenantId: target.tenantId });
      if (command === 'powershell.exe') return JSON.stringify({ supported: true,
        instances: [{ instance: 'SQLEXPRESS', majorVersion: 17, edition: 'Express Edition', verified: true, integratedSecurityOnly: 0, containedAuthentication: 1, loopbackPorts: [1433] }] });
      return base.run(command, args);
    } });
    const report = await checkSetup({ root: process.cwd(), sqlProvider: provider, sqlTarget: path }, deps);
    assert.equal(report.ready, true);
    assert.equal(report.sqlRoutes.recommended, provider);
    assert.equal(calls.some(call => call[0] === 'docker'), false);
    if (provider === 'express') assert.equal(calls.some(call => call[0] === 'az'), false);
  }
});

test('Windows-only or unknown Express authentication requires separate mixed-mode review without changing the instance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-express-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'express.json');
  await writeFile(path, JSON.stringify({ version: 1, provider: 'express', instance: 'SQLEXPRESS',
    server: '127.0.0.1', port: 1433, database: 'development' }));
  for (const integratedSecurityOnly of [1, undefined]) {
    const base = fixture(), calls = [];
    const report = await checkSetup({ root: process.cwd(), sqlProvider: 'express', sqlTarget: path }, fixture({
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'powershell.exe') return JSON.stringify({ supported: true, instances: [{
          instance: 'SQLEXPRESS', majorVersion: 17, edition: 'Express Edition', verified: true,
          containedAuthentication: 1, loopbackPorts: [1433], integratedSecurityOnly,
        }] });
        return base.run(command, args);
      },
    }));
    assert.equal(report.ready, false);
    const check = report.checks.find(item => item.id === 'sql-express');
    assert.equal(check.code, 'EXPRESS_SQL_AUTHENTICATION_REVIEW_REQUIRED');
    assert.match(JSON.stringify(check), /configure-express-auth/);
    assert.ok(calls.every(call => !call.includes('ConfigureSqlAuthentication')));
  }
});

test('host DAB requires both stable .NET 8 runtimes even when a newer SDK is selected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-host-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = 'Microsoft.NETCore.App 8.0.27 [runtime]';
  const aspnet = 'Microsoft.AspNetCore.App 8.0.27 [runtime]';
  for (const provider of ['azure', 'express']) {
    const target = provider === 'azure' ? { version: 1, provider, server: 'example.database.windows.net', database: 'development',
      subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'development' } :
      { version: 1, provider, instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' };
    const path = join(root, `${provider}.json`);
    await writeFile(path, JSON.stringify(target));
    for (const [runtimes, state] of [
      ['Microsoft.NETCore.App 10.0.0 [runtime]\nMicrosoft.AspNetCore.App 10.0.0 [runtime]', 'missing'],
      [core, 'missing'], [aspnet, 'missing'], ['', 'missing'],
      [`${core}\nMicrosoft.AspNetCore.App 8.0.0-preview.1 [runtime]`, 'missing'],
      [`${core}\n${aspnet}\nMicrosoft.NETCore.App 10.0.0 [runtime]`, 'ready'],
      ['invalid runtime listing', 'check-failed'], [new Error('permission denied'), 'check-failed'],
    ]) {
      const base = fixture(), calls = [];
      const report = await checkSetup({ root: process.cwd(), sqlProvider: provider, sqlTarget: path }, fixture({
        run: async (command, args) => {
          calls.push([command, ...args]);
          if (command === 'dotnet') {
            if (args[0] === '--list-sdks') return '10.0.100 [SDK]';
            if (args[0] === '--version') return '10.0.100';
            if (runtimes instanceof Error) throw runtimes;
            return runtimes;
          }
          if (command === 'az') return JSON.stringify({ id: target.subscriptionId, tenantId: target.tenantId });
          if (command === 'powershell.exe') return JSON.stringify({ supported: true, instances: [{
            instance: 'SQLEXPRESS', majorVersion: 17, edition: 'Express Edition', verified: true,
            integratedSecurityOnly: 0, containedAuthentication: 1, loopbackPorts: [1433],
          }] });
          return base.run(command, args);
        },
      }));
      const check = report.checks.find(item => item.id === 'host-dab-runtime');
      assert.equal(check?.toolState, state, `${provider}: ${runtimes}`);
      assert.equal(report.ready, state === 'ready');
      assert.equal(report.checks.find(item => item.id === 'dotnet').toolState, 'ready');
      assert.equal(calls.some(call => call.includes('--list-runtimes')), true);
      assert.equal(calls.some(call => call.includes('install')), false);
    }
  }
});

test('a saved container selection remains sticky even when image access fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-sticky-container-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { realpath } = await import('node:fs/promises');
  const home = await realpath(root);
  await mkdir(join(home, '.sql-apps'));
  await writeFile(join(home, '.sql-apps', 'sql-target.json'), JSON.stringify({ version: 1, home,
    target: { version: 1, provider: 'container', container: runtimeFor(undefined, home).defaultSql } }));
  const base = fixture();
  const report = await checkSetup({ root: home }, fixture({ run: (command, args) => {
    if (command === 'docker' && args[0] === 'image') throw new Error('image absent');
    return base.run(command, args);
  } }));
  assert.equal(report.sqlRoutes.recommended, 'container');
  assert.equal(report.sqlRoutes.selectionRequired, false);
});

test('role-based-data setup checks only selected service ports and remains read-only', async () => {
  assert.equal(parseArguments(['--profile', 'role-based-data']).profile, 'role-based-data');
  assert.throws(() => parseArguments(['--profile', 'unknown']));
  const checked = [];
  const report = await checkSetup({ profile: 'role-based-data' }, fixture({
    port: async port => { checked.push(port); return 'free'; },
  }));
  const runtime = runtimeFor();
  assert.equal(report.ready, true);
  assert.deepEqual(checked, [runtime.ports.gateway, runtime.ports.data]);
});

test('pre-build diagnostics check proposed workspace ports instead of an occupied legacy gateway', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-setup-ports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checked = [];
  const deps = fixture({ port: async port => {
    checked.push(port);
    return port === 18080 ? 'occupied' : 'free';
  } });
  const report = await checkSetup({ root, workspace: '30000' }, deps);
  assert.deepEqual(checked, [30000, 30001]);
  assert.equal(report.ready, true);
  assert.equal(report.workspace.mode, 'isolated');
  assert.deepEqual(parseArguments(['--workspace', '30000']), { workspace: '30000' });
  checked.length = 0;
  const legacy = await checkSetup({ root, workspace: 'legacy' }, deps);
  assert.equal(legacy.ready, false, 'explicit legacy selection still checks its occupied gateway');
  assert.equal(checked[0], 18080);
});

test('role-based procedure check accepts real declaration forms and ignores commented-out code', async () => {
  const { roleBasedProcedureProblem } = await import('../src/role-based-rules.mjs');
  const dab = { entities: {
    A: { source: { type: 'stored-procedure', object: 'dbo.ShiftReady' } },
    B: { source: { type: 'stored-procedure', object: 'app.SignUp' } },
  } };
  assert.equal(roleBasedProcedureProblem(dab, ['CREATE OR ALTER PROC [dbo].[ShiftReady] AS SELECT 1', 'create procedure app.SignUp @id int AS SELECT @id']), undefined);
  assert.match(roleBasedProcedureProblem(dab, ['/* CREATE PROCEDURE dbo.ShiftReady */ CREATE PROCEDURE app.SignUp AS SELECT 1']), /dbo\.ShiftReady/);
  assert.match(roleBasedProcedureProblem(dab, ['CREATE PROCEDURE dbo.ShiftReadyOld AS SELECT 1', 'CREATE PROCEDURE app.SignUp AS SELECT 1']), /dbo\.ShiftReady/,
    'a longer procedure name must not satisfy a shorter one');
});

test('role-based-data reports its application configuration without blocking tool readiness', async () => {
  const base = fixture();
  const validText = '{"profile":"role-based-data","requiredRole":"Coordinator","readinessPath":"/api/Ready"}';
  const readyDab = { entities: { Ready: { source: { type: 'stored-procedure', object: 'dbo.Ready' },
    rest: { enabled: true, methods: ['get'] }, permissions: [{ role: 'Coordinator', actions: ['execute'] }] } } };
  const withConfig = (text, dab = readyDab, sql = ['CREATE PROCEDURE dbo.Ready AS SELECT 1;']) => fixture({
    read: async path => path.endsWith('role-based-data.json') ? text :
      path.endsWith('dab-config.json') ? JSON.stringify(dab) : base.read(path),
    sqlSources: async () => sql });
  const missing = (await checkSetup({ profile: 'role-based-data' }, base)).checks.find(c => c.id === 'role-based-config');
  assert.equal(missing.code, 'ROLE_BASED_CONFIG_MISSING');
  assert.equal(missing.required, false);
  assert.match(missing.nextAction, /role-based-data\.example\.json/);
  const invalid = await checkSetup({ profile: 'role-based-data' }, withConfig('{"profile":"role-based-data","requiredRole":"anonymous","readinessPath":"/api/Ready"}'));
  assert.equal(invalid.checks.find(c => c.id === 'role-based-config').code, 'ROLE_BASED_CONFIG_INVALID');
  assert.equal(invalid.ready, true);
  const valid = await checkSetup({ profile: 'role-based-data' }, withConfig(validText));
  assert.equal(valid.checks.find(c => c.id === 'role-based-config').code, 'ROLE_BASED_CONFIG_READY');
  const foundationDab = { entities: { FileJob: { source: { type: 'table', object: 'dbo.FileJobs' }, rest: true,
    permissions: [{ role: 'processor', actions: ['read'] }] } } };
  const dabCheck = (await checkSetup({ profile: 'role-based-data' }, withConfig(validText, foundationDab))).checks.find(c => c.id === 'role-based-config');
  assert.equal(dabCheck.code, 'ROLE_BASED_DAB_INVALID', 'the copied foundation DAB must be caught before startup consent');
  assert.match(dabCheck.message, /FileJob/);
  assert.doesNotMatch(dabCheck.message, /"code"/);
  assert.match(dabCheck.nextAction, /dab\/dab-config\.json/);
  const unimplemented = (await checkSetup({ profile: 'role-based-data' }, withConfig(validText, readyDab, ['-- CREATE PROCEDURE dbo.Ready AS SELECT 1;'])))
    .checks.find(c => c.id === 'role-based-config');
  assert.equal(unimplemented.code, 'ROLE_BASED_PROCEDURE_MISSING', 'a DAB procedure absent from sql/ must be caught before SQL startup consent');
  assert.match(unimplemented.message, /dbo\.Ready/);
  assert.match(unimplemented.nextAction, /sql\//);
  assert.equal((await checkSetup({}, base)).checks.some(c => c.id === 'role-based-config'), true, 'the only profile is always checked');
  const actions = (await checkSetup({}, fixture({ exists: async () => false }))).checks
    .filter(c => ['dependencies', 'build'].includes(c.id)).map(c => c.nextAction).join(' ');
  assert.doesNotMatch(actions, /run npm (ci|run build)/, 'raw restore/build advice bypasses the guarded consent-run path');
  assert.match(actions, /consent-run restore/);
  assert.match(actions, /consent-run build/);
});

test('missing prerequisites, engine modes and malformed results fail safely without raw secrets', async () => {
  for (const [command, code] of [['npm', 'NPM_UNAVAILABLE'], ['dotnet', 'SDK_UNAVAILABLE'], ['docker', 'DOCKER_UNAVAILABLE']]) {
    const deps = fixture();
    const run = deps.run;
    deps.run = async (cmd, args) => { if (cmd === command) throw new Error('password=secret'); return run(cmd, args); };
    const report = await checkSetup({}, deps);
    assert.equal(report.ready, false);
    assert.ok(report.checks.some(c => c.code === code));
    assert.equal(JSON.stringify(report).includes('password=secret'), false);
  }
  for (const result of ['{"OSType":"windows","Architecture":"amd64"}', 'not JSON']) {
    const deps = fixture();
    const run = deps.run;
    deps.run = (cmd, args) => args[0] === 'info' ? Promise.resolve(result) : run(cmd, args);
    assert.equal((await checkSetup({}, deps)).ready, false);
  }
  const deps = fixture();
  const run = deps.run;
  deps.run = (cmd, args) => args[0] === 'info' ? Promise.reject(new Error('timeout')) : run(cmd, args);
  assert.ok((await checkSetup({}, deps)).checks.some(c => c.code === 'DOCKER_NOT_RUNNING'));
});

test('unsupported Node, runtime-only SDK and global.json incompatibility are explicit', async () => {
  assert.equal((await checkSetup({}, fixture({ nodeVersion: '23.0.0' }))).ready, false);
  const deps = fixture();
  const run = deps.run;
  deps.run = (cmd, args) => args[0] === '--list-sdks' ? Promise.resolve('') : run(cmd, args);
  assert.ok((await checkSetup({}, deps)).checks.some(c => c.code === 'SDK_TOO_OLD'));
  deps.run = (cmd, args) => args[0] === '--version' && cmd === 'dotnet' ?
    Promise.reject(new Error('global.json could not resolve')) : run(cmd, args);
  assert.ok((await checkSetup({}, deps)).checks.some(c => c.code === 'SDK_SELECTION_FAILED'));
});

test('missing tools and installed-but-failing probes have different installation states', async () => {
  for (const [error, state] of [
    [Object.assign(new Error('absent'), { code: 'ENOENT' }), 'missing'],
    [Object.assign(new Error('private diagnostic'), { code: 7 }), 'check-failed'],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'check-failed'],
  ]) {
    const deps = fixture();
    const run = deps.run;
    deps.run = (command, args) => command === 'npm' ? Promise.reject(error) : run(command, args);
    const report = await checkSetup({}, deps);
    assert.equal(report.checks.find(check => check.id === 'npm').toolState, state);
    assert.equal(JSON.stringify(report).includes('private diagnostic'), false);
  }
});

test('unsupported Node and unresolved SDK selection are not missing installations', async () => {
  const deps = fixture({ nodeVersion: '23.0.0' });
  const run = deps.run;
  deps.run = (command, args) => command === 'dotnet' && args[0] === '--version' ?
    Promise.reject(Object.assign(new Error('selection failed'), { code: 1 })) : run(command, args);
  const report = await checkSetup({}, deps);
  assert.equal(report.checks.find(check => check.id === 'node').toolState, 'unsupported');
  assert.equal(report.checks.find(check => check.id === 'dotnet').toolState, 'check-failed');
});

test('dependency readiness validates all locked packages and the actual SQL tool', async t => {
  assert.equal(typeof setup.inspectDependencies, 'function');
  const home = await mkdtemp(join(tmpdir(), 'sql-apps-dependencies-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'node_modules', 'fixture'), { recursive: true });
  await mkdir(join(home, '.config'));
  await writeFile(join(home, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  await writeFile(join(home, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3, packages: { '': { dependencies: { fixture: '1.0.0' } },
      'node_modules/fixture': { version: '1.0.0' } },
  }));
  await writeFile(join(home, 'node_modules', 'fixture', 'package.json'),
    '{"name":"fixture","version":"1.0.0","main":"index.js"}');
  await writeFile(join(home, 'node_modules', 'fixture', 'index.js'), 'module.exports = {};');
  await writeFile(join(home, '.config', 'dotnet-tools.json'), JSON.stringify({
    tools: { 'microsoft.sqlpackage': { version: '170.5.96', commands: ['sqlpackage'] } },
  }));
  const probe = async (command, args) => {
    if (command === 'npm') {
      assert.deepEqual(args, ['ls', '--all', '--json', '--offline']);
      return '{"dependencies":{"fixture":{"version":"1.0.0"}}}';
    }
    assert.equal(command, 'dotnet');
    assert.deepEqual(args, ['tool', 'run', 'sqlpackage', '--', '/Version']);
    return '170.5.96.0';
  };
  assert.equal((await setup.inspectDependencies(home, probe)).ready, true);
  const brokenTree = await setup.inspectDependencies(home, async (command, args) => {
    if (command === 'npm') throw Object.assign(new Error('missing transitive package'), { code: 1 });
    return probe(command, args);
  });
  assert.equal(brokenTree.npmReady, false);
  assert.equal(brokenTree.checks.find(check => check.id === 'npm-tree').code, 'NPM_TREE_UNVERIFIED');
  assert.equal((await setup.inspectDependencies(home, async () => '169.0.0')).sqlToolsReady, false);
  await unlink(join(home, 'node_modules', 'fixture', 'index.js'));
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, false);
  await writeFile(join(home, 'node_modules', 'fixture', 'index.js'), 'module.exports = {};');
  await writeFile(join(home, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"2.0.0","main":"index.js"}');
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, false);
});

test('CLI-only dependencies require their locked package and executable, not a library entry', async t => {
  const home = await mkdtemp(join(tmpdir(), 'sql-apps-cli-dependencies-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'node_modules', 'fixture', 'dist'), { recursive: true });
  await mkdir(join(home, '.config'));
  await writeFile(join(home, 'package.json'), JSON.stringify({ devDependencies: { fixture: '1.0.0' } }));
  await writeFile(join(home, 'package-lock.json'), JSON.stringify({
    packages: { '': { devDependencies: { fixture: '1.0.0' } }, 'node_modules/fixture': { version: '1.0.0' } },
  }));
  await writeFile(join(home, 'node_modules', 'fixture', 'package.json'),
    '{"name":"fixture","version":"1.0.0","bin":{"fixture":"dist/cli.js"}}');
  await writeFile(join(home, '.config', 'dotnet-tools.json'), JSON.stringify({
    tools: { 'microsoft.sqlpackage': { version: '170.5.96', commands: ['sqlpackage'] } },
  }));
  const probe = async command => command === 'npm'
    ? '{"dependencies":{"fixture":{"version":"1.0.0"}}}' : '170.5.96.0';
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, false);
  await writeFile(join(home, 'node_modules', 'fixture', 'dist', 'cli.js'), 'console.log("fixture");');
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, true);
  await writeFile(join(home, 'node_modules', 'fixture', 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', bin: { fixture: 'dist/cli.js' },
    exports: { './contract': './dist/contract.js' },
  }));
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, true,
    'subpath-only exports do not require a root library entry for a CLI');
  await unlink(join(home, 'node_modules', 'fixture', 'dist', 'cli.js'));
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, false,
    'subpath exports must not hide a missing declared executable');
  await writeFile(join(home, 'node_modules', 'fixture', 'dist', 'cli.js'), 'console.log("fixture");');
  await writeFile(join(home, 'node_modules', 'fixture', 'package.json'),
    '{"name":"fixture","version":"2.0.0","bin":{"fixture":"dist/cli.js"}}');
  assert.equal((await setup.inspectDependencies(home, probe)).npmReady, false);
});

test('slow cold dependency probes are retried and never reported as missing dependencies', async t => {
  const home = await mkdtemp(join(tmpdir(), 'sql-apps-dependency-timeout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'node_modules', 'fixture'), { recursive: true });
  await mkdir(join(home, '.config'));
  await writeFile(join(home, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  await writeFile(join(home, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3, packages: { '': { dependencies: { fixture: '1.0.0' } }, 'node_modules/fixture': { version: '1.0.0' } },
  }));
  await writeFile(join(home, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0","main":"index.js"}');
  await writeFile(join(home, 'node_modules', 'fixture', 'index.js'), 'module.exports = {};');
  await writeFile(join(home, '.config', 'dotnet-tools.json'), JSON.stringify({
    tools: { 'microsoft.sqlpackage': { version: '170.5.96', commands: ['sqlpackage'] } },
  }));
  const timeout = () => Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' });
  const calls = { npm: 0, dotnet: 0 };
  const coldOnce = async command => {
    if (calls[command]++ === 0) throw timeout();
    return command === 'npm' ? '{"dependencies":{"fixture":{"version":"1.0.0"}}}' : '170.5.96.0';
  };
  const warm = await setup.inspectDependencies(home, coldOnce);
  assert.equal(warm.ready, true);
  assert.deepEqual(calls, { npm: 2, dotnet: 2 });

  const stalled = await setup.inspectDependencies(home, async () => { throw timeout(); });
  assert.equal(stalled.ready, false);
  assert.equal(stalled.probeTimedOut, true);
  assert.equal(stalled.checks.find(check => check.id === 'npm-tree').code, 'NPM_TREE_PROBE_TIMEOUT');
  assert.equal(stalled.checks.find(check => check.id === 'microsoft.sqlpackage').code, 'SQL_TOOL_PROBE_TIMEOUT');
  assert.match(stalled.checks.find(check => check.id === 'npm-tree').nextAction, /not evidence|rerun/i);

  const broken = await setup.inspectDependencies(home, async () => { throw Object.assign(new Error('exit 1'), { code: 1 }); });
  assert.equal(broken.probeTimedOut, false);
  assert.equal(broken.checks.find(check => check.id === 'npm-tree').code, 'NPM_TREE_UNVERIFIED');
});

test('SQL cache, preview access, ARM and selected-container states are not confused with verified SQL', async () => {
  const deps = fixture({ architecture: 'arm64' });
  const run = deps.run;
  deps.run = (cmd, args) => args[0] === 'image' ? Promise.reject(new Error('absent')) : run(cmd, args);
  let report = await checkSetup({}, deps);
  assert.equal(report.ready, false);
  assert.ok(report.checks.some(c => c.code === 'SQL_IMAGE_ACCESS_REQUIRED'));
  assert.ok(report.checks.some(c => c.code === 'SQL_X64_EMULATION'));
  report = await checkSetup({ container: 'user-sql' }, deps);
  assert.equal(report.ready, true);
  assert.match(report.checks.find(c => c.id === 'sql-image').nextAction, /EngineEdition/);
  deps.run = (cmd, args) => args[0] === 'container' ?
    Promise.resolve('{"status":"exited","owner":"","image":"private"}') : run(cmd, args);
  report = await checkSetup({ container: 'user-sql' }, deps);
  assert.equal(report.ready, false);
  assert.ok(report.checks.some(c => c.code === 'SQL_CONTAINER_STOPPED'));
  await assert.rejects(checkSetup({ container: 'bad;name' }, deps), /container name/);
});

for (const selection of [undefined, 'legacy', 33000]) {
  const mode = selection === undefined ? 'legacy-unselected' : selection === 'legacy' ? 'legacy' : 'isolated';
  test(`port conflicts never authorize killing services; healthy gateway alone is not proof of ownership (${mode})`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sql-apps-setup-conflicts-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (selection !== undefined) await initializeWorkspace(root, selection, async () => 'free');
    const runtime = runtimeFor(undefined, root);
    const deps = fixture({ port: async port => port === runtime.ports.gateway ? 'occupied' : 'free' });
    let report = await checkSetup({ root }, deps);
    assert.equal(report.ready, false);
    assert.ok(report.checks.some(c => c.code === 'EXISTING_GATEWAY_CHECK_OWNERSHIP'));
    const run = deps.run;
    deps.port = async () => 'occupied';
    const containers = [
      { owner: 'data', workspace: runtime.id, ports: `127.0.0.1:${runtime.ports.data}->5000/tcp` },
    ];
    deps.run = (cmd, args) => {
      if (args[0] !== 'ps') return run(cmd, args);
      deps.calls.push([cmd, ...args]);
      return Promise.resolve(containers.map(container => JSON.stringify(container)).join('\n'));
    };
    report = await checkSetup({ root }, deps);
    assert.equal(report.checks.filter(c => c.code === 'OWNED_SERVICE_RUNNING').length, 1);
    assert.equal(report.ready, false, 'Owned dependencies do not prove gateway ownership');
    deps.port = async () => 'unknown';
    assert.equal((await checkSetup({ root }, deps)).ready, false);
    assert.ok(deps.calls.every(call => !call.some(value => ['pull', 'run', 'login', 'start', 'stop', 'rm'].includes(value))));
  });
}

test('configured setup diagnostics use derived ports and reject another workspace label', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-setup-isolated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeWorkspace(root, 32000, async () => 'free');
  const runtime = runtimeFor(undefined, root);
  for (const workspace of [runtime.id, 'another-workspace']) {
    const deps = fixture({ port: async port => port === runtime.ports.data ? 'occupied' : 'free' });
    const run = deps.run;
    deps.run = (cmd, args) => args[0] === 'ps' ? Promise.resolve(JSON.stringify({
      owner: 'data', workspace, ports: `127.0.0.1:${runtime.ports.data}->5000/tcp`,
    })) : run(cmd, args);
    const report = await checkSetup({ root }, deps);
    assert.equal(report.workspace.origins.app, 'http://127.0.0.1:32000');
    assert.equal(report.workspace.origins.data, 'http://127.0.0.1:32001');
    const portCheck = report.checks.find(check => check.id === `port-${runtime.ports.data}`);
    assert.equal(portCheck.status, workspace === runtime.id ? 'ready' : 'action-required');
    assert.equal(report.ready, workspace === runtime.id);
    assert.ok(deps.calls.every(call => !call.some(value => ['pull', 'run', 'login', 'start', 'stop', 'rm'].includes(value))));
  }
});

test('diagnostic argument parsing is explicit and rejects malformed or duplicate values', () => {
  assert.deepEqual(parseArguments(['--json', '--container', 'existing']), { json: true, container: 'existing' });
  for (const args of [['--bad'], ['--container'], ['--json', '--json'], ['--container', '--json'], ['--container', 'bad;name']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('unknown hosts and malformed Docker version cannot pass readiness', async () => {
  assert.equal((await checkSetup({}, fixture({ platform: 'unsupported' }))).ready, false);
  const deps = fixture();
  const run = deps.run;
  deps.run = (cmd, args) => cmd === 'docker' && args[0] === '--version' ? Promise.resolve('') : run(cmd, args);
  assert.ok((await checkSetup({}, deps)).checks.some(c => c.code === 'DOCKER_UNAVAILABLE'));
});

test('actual pre-build CLI exits nonzero with parseable JSON on invalid arguments', () => {
  const result = spawnSync(process.execPath, ['scripts/setup-check.mjs', '--json', '--unexpected'], {
    encoding: 'utf8', timeout: 10000, shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.checks[0].code, 'DIAGNOSTIC_FAILED');
  assert.match(report.checks[0].nextAction, /usage/);
  assert.equal(result.stderr, '');
});
