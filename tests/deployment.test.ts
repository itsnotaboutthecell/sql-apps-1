import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { deploymentSchema, environmentKey, portFromEnvironment } from '../src/config.js';
import { armParameters, configureRedirect, deploy, functionRoleId, preflight, saveState, statePath, withDeploymentLock, type DeploymentState, type DeploymentOutputs } from '../src/deployment.js';
import type { Run } from '../src/process.js';

const config = deploymentSchema.parse(JSON.parse(await readFile('sql-apps.example.json', 'utf8')));
const outputs: DeploymentOutputs = {
  sqlServer: 'example.database.windows.net', databaseName: 'app',
  dabPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  gatewayPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  gatewayName: 'gateway', gatewayUrl: 'https://example.azurecontainerapps.io',
  functionsName: 'functions', networkId: '/network', storageAccount: 'storage', vaultName: 'vault',
  sqlBackupRetentionDays: 7, sqlBackupRedundancy: 'Geo' as const, sqlAuditWorkspaceName: 'logs',
};
function fakeRunner(failSchema = false): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'account' && args[1] === 'get-access-token') return '{"accessToken":"test-only-sql-token"}';
    if (args[0] === 'account') return JSON.stringify({ id: config.subscriptionId, tenantId: config.tenantId, environmentName: 'AzureCloud' });
    if (args[0] === 'ad' && args[1] === 'app') return JSON.stringify({
      id: config.apiClientId, signInAudience: 'AzureADMyOrg',
      api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{ value: 'access_as_user', isEnabled: true }] },
      appRoles: [{ id: '15d91b1c-83c7-4cb6-b349-d7b8fd4b1425', value: 'Function.Invoke', isEnabled: true }],
      spa: { redirectUris: ['http://localhost:8080'] },
    });
    if (args[0] === 'ad' && args[1] === 'sp') return config.apiClientId;
    if (args[0] === 'provider') return 'Registered';
    if (args[0] === 'acr' && args[1] === 'repository') return `sha256:${'a'.repeat(64)}`;
    if (args[0] === 'rest' && args.includes('GET')) return '{"value":[]}';
    if (args[0] === 'deployment') return JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { value }])));
    if (failSchema && args.includes('/Action:Publish')) throw new Error('SQL network unavailable');
    return '';
  };
  return { run, calls };
}
test('configuration rejects unknown platform settings and floating images', () => {
  assert.throws(() => deploymentSchema.parse({ ...config, fabric: {} }));
  assert.throws(() => deploymentSchema.parse({ ...config, gatewayImage: 'image:latest' }));
  assert.throws(() => deploymentSchema.parse({ ...config, resourceGroup: 'rg;evil' }));
  assert.throws(() => deploymentSchema.parse({ ...config, gatewayImage: 'unrelated.azurecr.io/image:v1' }));
  assert.throws(() => deploymentSchema.parse({ ...config, gatewayImage: `${config.registryServer}/image;evil:v1` }));
});
test('runtime port validation rejects empty, invalid, and out-of-range values', () => {
  assert.equal(portFromEnvironment(undefined), 8080);
  assert.equal(portFromEnvironment('9000'), 9000);
  for (const value of ['', 'bad', '0', '65536']) assert.throws(() => portFromEnvironment(value));
});
test('ARM parameters exclude local routing settings and identify separate environments', () => {
  const parameters = armParameters(config, false).parameters;
  assert.equal('subscriptionId' in parameters, false);
  assert.equal('resourceGroup' in parameters, false);
  assert.deepEqual(parameters.deployGateway, { value: false });
  assert.notEqual(environmentKey(config), environmentKey({ ...config, environment: 'prod' }));
});
test('missing deployment images fail preflight before infrastructure side effects', async () => {
  const { run, calls } = fakeRunner();
  const missing: Run = async (command, args) => {
    if (args[0] === 'acr' && args[1] === 'repository') throw new Error('Image not found');
    return run(command, args);
  };
  await assert.rejects(preflight(config, missing), /Image not found/);
  assert.equal(calls.some(call => call.includes('deployment')), false);
});
test('static build preflight does not require its not-yet-built output', async () => {
  const { run, calls } = fakeRunner();
  await preflight(config, run, false);
  assert.equal(calls.some(call => call.includes('repository')), false);
  assert.equal(calls.some(call => call.includes('Registered')), false);
  assert.equal(calls.filter(call => call.includes('provider')).length, 10);
});
test('redirect registration preserves existing URIs and adds only the dedicated HTTPS callback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-redirect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(process, 'cwd', () => directory);
  await mkdir(dirname(statePath(config)), { recursive: true });
  const origin = 'https://example.azurecontainerapps.io';
  const redirect = `${origin}/auth/redirect.html`;
  const existing = 'https://existing.example/auth/redirect.html';
  let registered = [existing, origin];
  let patches = 0;
  const run: Run = async (_command, args) => {
    if (args[0] === 'ad') return JSON.stringify({ id: config.apiClientId, spa: { redirectUris: registered } });
    if (args[0] === 'rest' && args.includes('PATCH')) {
      patches++;
      const body = args[args.indexOf('--body') + 1];
      assert.ok(body && body.startsWith('@'));
      registered = JSON.parse(await readFile(body.slice(1), 'utf8')).spa.redirectUris;
    }
    return '';
  };
  await configureRedirect(config, origin, run);
  assert.deepEqual(registered, [existing, origin, redirect]);
  await configureRedirect(config, origin, run);
  assert.deepEqual(registered, [existing, origin, redirect]);
  assert.equal(patches, 2);
  for (const invalid of ['http://example.invalid', `${origin}/path`, `${origin}/`, `${origin}?x=1`]) {
    await assert.rejects(configureRedirect(config, invalid, run), /HTTPS origin required/);
  }
  assert.equal(patches, 2);
});
async function cleanupArtifacts() {
  for (const suffix of ['.parameters.json', '.role.json', '.redirect.json']) {
    await unlink(`${statePath(config)}${suffix}`).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
test('deployment orders infrastructure, schema, service permission, runtime and readiness', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner();
  const stages: string[] = [];
  const state = await deploy(config, run, async () => new Response('{}'), async state => { stages.push(state.stage); });
  assert.equal(state.stage, 'ready');
  assert.deepEqual(stages, ['infrastructure', 'schema', 'runtime', 'ready']);
  const infra = calls.findIndex(call => call.includes(`${config.name}-${config.environment}-infrastructure`));
  const sql = calls.findIndex(call => call.includes('/Action:Publish'));
  const runtime = calls.findIndex(call => call.includes(`${config.name}-${config.environment}-runtime`));
  assert.ok(infra < sql && sql < runtime);
  assert.ok(calls[sql]?.includes('/p:BlockOnPossibleDataLoss=True'));
  assert.ok(calls[sql]?.includes('/AccessToken:test-only-sql-token'));
});
test('failed schema publish does not start the data/gateway deployment or claim success', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner(true);
  const stages: string[] = [];
  await assert.rejects(deploy(config, run, async () => new Response('{}'), async state => { stages.push(state.stage); }), /SQL network unavailable/);
  assert.deepEqual(stages, ['infrastructure']);
  assert.equal(calls.some(call => call.includes(`${config.name}-${config.environment}-runtime`)), false);
});
test('existing function role on a later Graph page is not assigned again', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner();
  let pages = 0;
  const paginated: Run = async (command, args) => {
    const result = await run(command, args);
    if (args[0] !== 'rest' || !args.includes('GET')) return result;
    pages++;
    return JSON.stringify(pages === 1
      ? { value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0/servicePrincipals/${outputs.gatewayPrincipalId}/appRoleAssignments?$skiptoken=next` }
      : { value: [{ appRoleId: functionRoleId, resourceId: config.apiClientId }] });
  };
  await deploy(config, paginated, async () => new Response('{}'), async () => {});
  assert.equal(pages, 2);
  assert.equal(calls.some(call => call.includes('POST')), false);
});
test('Graph pagination never forwards credentials to an unrelated URL', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner();
  const malicious: Run = async (command, args) => {
    const result = await run(command, args);
    return args[0] === 'rest' && args.includes('GET')
      ? JSON.stringify({ value: [], '@odata.nextLink': 'https://unrelated.example/next' })
      : result;
  };
  await assert.rejects(deploy(config, malicious, async () => new Response('{}'), async () => {}), /continuation URL/);
  assert.equal(calls.some(call => call.includes('https://unrelated.example/next')), false);
});
test('atomic deployment state and local concurrency lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sql-apps-'));
  try {
    const path = join(dir, 'state.json');
    const state: DeploymentState = { environmentKey: environmentKey(config), configHash: 'hash', stage: 'runtime', outputs };
    await saveState(path, state);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), state);
    await withDeploymentLock(path, async () => {
      await assert.rejects(withDeploymentLock(path, async () => {}), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
    });
    await withDeploymentLock(path, async () => {});
  } finally { await rm(dir, { recursive: true }); }
});
test('deployment lock recovers after its owner process has stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sql-apps-'));
  try {
    const path = join(dir, 'state.json');
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 2147483647, token: 'stopped-owner' }));
    let ran = false;
    await withDeploymentLock(path, async () => { ran = true; });
    assert.equal(ran, true);
    await assert.rejects(readFile(`${path}.lock`), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await rm(dir, { recursive: true }); }
});
test('deployment lock recovers an old incomplete lock from a stopped write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sql-apps-'));
  try {
    const path = join(dir, 'state.json');
    const lock = `${path}.lock`;
    await writeFile(lock, '{"pid":');
    const old = new Date(Date.now() - 31_000);
    await utimes(lock, old, old);
    await withDeploymentLock(path, async () => {});
    await assert.rejects(readFile(lock), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await rm(dir, { recursive: true }); }
});
for (const legacy of [true, false]) test(`simultaneous ${legacy ? 'legacy' : 'directory'} stale-lock recoverers cannot remove a replacement owner`, { timeout: 5_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sql-apps-lock-race-'));
  const path = join(dir, 'state.json');
  const lock = `${path}.lock`;
  const token = legacy ? 'dead-owner' : '11111111-1111-4111-8111-111111111111';
  const ownerPath = legacy ? lock : join(lock, `${token}.json`);
  if (!legacy) await mkdir(lock);
  await writeFile(ownerPath, JSON.stringify({ pid: 2147483647, token }));
  const originalRead = fs.readFile;
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
  let releaseSecond!: () => void;
  const firstEntered = new Promise<void>(resolve => { releaseSecond = resolve; });
  const read = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const text = await originalRead(...args);
    if (args[0] === ownerPath) {
      const index = ++reads;
      if (index === 2) releaseReads();
      await bothRead;
      if (index === 2) await firstEntered;
    }
    return text;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    releaseReads();
    releaseSecond();
    read.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  });
  let active = 0;
  let maximum = 0;
  const action = async () => {
    active++;
    maximum = Math.max(maximum, active);
    releaseSecond();
    await new Promise(resolve => setTimeout(resolve, 100));
    active--;
  };
  const results = await Promise.allSettled([withDeploymentLock(path, action), withDeploymentLock(path, action)]);
  assert.equal(maximum, 1, 'only one protected action may run at a time');
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.reason.code, 'EEXIST');
});
