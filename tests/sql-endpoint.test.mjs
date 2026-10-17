import { test } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFor, initializeWorkspace } from '../src/workspace.mjs';
import { sqlTargetFingerprint } from '../src/sql-target.mjs';
import { run } from '../dist/src/process.js';

let endpoint;
try { endpoint = await import('../dist/src/sql-endpoint.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const azure = { version: 1, provider: 'azure', server: 'example.database.windows.net', database: 'development',
  subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'development' };
const express = { version: 1, provider: 'express', instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' };

test('endpoint identity checks edition, major version and selected database', () => {
  assert.equal(typeof endpoint?.verifyEndpointIdentity, 'function');
  endpoint.verifyEndpointIdentity(azure, { engineEdition: 5, edition: 'SQL Azure', majorVersion: 12, database: 'development' });
  endpoint.verifyEndpointIdentity(express, { engineEdition: 4, edition: 'Express Edition (64-bit)', majorVersion: 17, database: 'development' });
  for (const row of [
    { engineEdition: 3, edition: 'Developer Edition', majorVersion: 17, database: 'development' },
    { engineEdition: 4, edition: 'Express Edition', majorVersion: 16, database: 'development' },
    { engineEdition: 4, edition: 'Express Edition', majorVersion: 17, database: 'master' },
  ]) assert.throws(() => endpoint.verifyEndpointIdentity(express, row), /identity/);
});

test('runtime connections never use an administrator or disable cloud certificate verification', () => {
  assert.equal(typeof endpoint?.endpointConnection, 'function');
  assert.match(endpoint.endpointConnection(azure, 'app_runtime', 'quotes";semicolon'), /TrustServerCertificate=False/);
  assert.match(endpoint.endpointConnection(express, 'app_runtime', 'secret'), /Server=127.0.0.1,1433/);
  assert.throws(() => endpoint.endpointConnection(express, 'sa', 'secret'), /administrator/);
  assert.match(endpoint.endpointConnection(azure, 'app_runtime', 'quotes";semicolon'), /Password="quotes"";semicolon"/);
});

test('schema platform is provider-specific without incompatible-platform overrides', () => {
  assert.equal(typeof endpoint?.endpointSchemaPlatform, 'function');
  assert.equal(endpoint.endpointSchemaPlatform(azure), 'Microsoft.Data.Tools.Schema.Sql.SqlAzureV12DatabaseSchemaProvider');
  assert.equal(endpoint.endpointSchemaPlatform(express), 'Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider');
});

test('Express mixed-mode maintenance dispatch is separate from ordinary instance configuration', async () => {
  const { endpointLocalCommand } = await import('../dist/src/endpoint-local.js');
  const calls = [];
  await endpointLocalCommand('configure-express-auth', express, async (command, args) => { calls.push([command, ...args]); return ''; });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('ConfigureSqlAuthentication'));
  assert.ok(calls[0].includes('-AllowRestart'));
  await assert.rejects(endpointLocalCommand('configure-express-auth', azure, async () => ''), /Express target/);
});

async function fixture(t, target) {
  const previous = process.cwd();
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-endpoint-')));
  await initializeWorkspace(home, 31000, async () => 'free');
  process.chdir(home);
  t.after(async () => { process.chdir(previous); await rm(home, { recursive: true, force: true }); });
  const runtime = runtimeFor();
  const calls = [], connections = [];
  let closed = 0;
  const rows = statement => {
    if (statement.includes("SERVERPROPERTY('EngineEdition')")) return [{ engineEdition: target.provider === 'azure' ? 5 : 4,
      edition: target.provider === 'azure' ? 'SQL Azure' : 'Express Edition', majorVersion: 17, database: target.database }];
    if (statement.includes('USER_ID(')) return [{ principal: null }];
    if (statement.includes('USER_NAME()')) return [{ principal: runtime.login, database: target.database }];
    return [];
  };
  t.mock.method(sql, 'ConnectionPool', function (config) {
    connections.push(config);
    return { connect: async () => {}, close: async () => { closed++; }, request: () => ({
      on() {}, query: async statement => { calls.push(['sql', statement]); return { recordset: rows(statement), recordsets: [rows(statement)] }; },
    }) };
  });
  const runner = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === 'az') return JSON.stringify(args.includes('show') ? { id: azure.subscriptionId, tenantId: azure.tenantId } : { accessToken: 'test-only-token' });
    if (command === 'powershell.exe' && args.includes('-Command')) return options.input;
    if (command === 'powershell.exe' && args.includes('Query')) return JSON.stringify(rows(JSON.parse(options.input).sql));
    if (args.includes('/Version')) return '170.5.96.0';
    return '';
  };
  return { home, runtime, calls, connections, runner, closed: () => closed };
}

test('endpoint queries preserve all SQL result sets, including trailing acceptance markers', async t => {
  const f = await fixture(t, azure);
  const sets = [[{ outcome: 'missing' }], [{ '': 'PROCEDURE OWNERSHIP AND PERMISSIONS PASSED' }]];
  t.mock.method(sql, 'ConnectionPool', function () {
    return { connect: async () => {}, close: async () => {}, request: () => ({
      on() {}, query: async () => ({ recordset: sets[0], recordsets: sets }),
    }) };
  });
  assert.deepEqual(await endpoint.endpointAdminQuery(azure, 'EXEC dbo.Example; SELECT marker;', f.runner), sets.flat());
});

test('Express initialization preserves safe configuration recovery instructions', async t => {
  const f = await fixture(t, express);
  for (const action of ['configure-express', 'configure-express-auth']) {
    await assert.rejects(endpoint.initializeEndpoint(express, async (command, args, options) => {
      assert.equal(command, 'powershell.exe');
      assert.ok(args.includes('Database'));
      return run(process.execPath, ['-e', `console.error('Review and separately approve ${action}; no configuration was changed.');process.exitCode=1;`], options);
    }, { profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/AppReady' }),
    error => error.message.includes(action) && !error.message.includes('sensitive command output omitted'));
  }
  assert.equal(f.calls.length, 0, 'no credential creation or publication after a failed preflight');
});

test('Express credential-bearing SQL errors still suppress all command output', async t => {
  const f = await fixture(t, express);
  let secret;
  await assert.rejects(endpoint.initializeEndpoint(express, async (command, args, options) => {
    if (command === 'powershell.exe' && args.includes('Query') && options.input.includes('CREATE USER')) {
      secret = /PASSWORD = '([^']+)'/.exec(JSON.parse(options.input).sql)[1];
      return run(process.execPath, ['-e', 'console.error(process.argv[1]);process.exitCode=1;', secret], options);
    }
    return f.runner(command, args, options);
  }, { profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/AppReady' }),
  error => Boolean(secret) && !error.message.includes(secret) && error.message.includes('sensitive command output omitted'));
});

for (const target of [azure, express, { ...express, instance: 'MSSQLSERVER' }]) {
  test(`${target.provider}${target.provider === 'express' ? ` ${target.instance}` : ''} initialization publishes the correct schema without Docker or admin runtime`, async t => {
    const f = await fixture(t, target);
    await endpoint.initializeEndpoint(target, f.runner, { profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/AppReady' });
    assert.equal(f.calls.some(call => call[0] === 'docker'), false);
    const build = f.calls.find(call => call[1] === 'build');
    assert.ok(build.includes(`-p:DSP=${endpoint.endpointSchemaPlatform(target)}`));
    assert.ok(build.some(value => value.includes(sqlTargetFingerprint(target))), 'target-specific build directory');
    const publish = f.calls.find(call => call.includes('/Action:Publish'));
    assert.ok(publish.includes('/p:BlockOnPossibleDataLoss=True'));
    assert.ok(publish.includes('/p:DropObjectsNotInSource=False'));
    if (target.provider === 'express') {
      const server = `lpc:.${target.instance === 'MSSQLSERVER' ? '' : `\\${target.instance}`}`;
      assert.ok(publish.includes(`/TargetConnectionString:Server=${server};Database=${target.database};Encrypt=True;TrustServerCertificate=True;Integrated Security=True;`));
      assert.ok(publish.includes('/p:ScriptDatabaseOptions=False'), 'preserve approved partial containment');
    }
    assert.equal(publish.some(value => value.includes('AllowIncompatiblePlatform') || value.includes('test-only-token')), false);
    assert.ok(f.connections.filter(item => item.user).every(item => item.user === f.runtime.login && item.user !== 'sa'));
    assert.ok(f.connections.every(item => item.options.encrypt && item.options.trustServerCertificate === (target.provider === 'express')));
    assert.equal(f.closed(), f.connections.length);
    const state = await endpoint.readEndpointCredentials(f.runtime, target, f.runner);
    assert.equal(state.fingerprint, sqlTargetFingerprint(target));
    assert.equal(state.login, f.runtime.login);
  });
}

test('Azure bootstrap rejects the wrong account before any SQL connection', async t => {
  const f = await fixture(t, azure);
  await assert.rejects(endpoint.verifyEndpoint(azure, async () => JSON.stringify({ id: 'wrong', tenantId: azure.tenantId })), /account does not match/);
  assert.equal(f.connections.length, 0);
});

test('endpoint failures close their pool and redact the access token', async t => {
  const f = await fixture(t, azure);
  let closed = false;
  t.mock.method(sql, 'ConnectionPool', function () {
    return { connect: async () => { throw new Error('permission denied test-only-token'); }, close: async () => { closed = true; } };
  });
  await assert.rejects(endpoint.verifyEndpoint(azure, f.runner), error => /permission denied/.test(error.message) && !error.message.includes('test-only-token'));
  assert.equal(closed, true);
});

test('Windows endpoint secrets use actual current-user encryption', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, express);
  const { run } = await import('../dist/src/process.js');
  const path = join(f.home, 'protected.json');
  await endpoint.saveProtectedJson(path, { secret: 'fixture-not-a-real-credential' }, run);
  assert.equal((await readFile(path, 'utf8')).includes('fixture-not-a-real-credential'), false);
  assert.deepEqual(await endpoint.readProtectedJson(path, run), { secret: 'fixture-not-a-real-credential' });
});
