import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { deploymentSchema, environmentKey, portFromEnvironment } from '../src/config.js';
import {
  armParameters, configureRedirect, deploy, deploymentConfigHash, expectedRbacAssignments, grantsHandoffPath, preflight,
  rbacParameters, requireReadyResponse, saveState, statePath, verifyRbacAssignments, withDeploymentLock,
  type DeploymentState, type DeploymentOutputs,
} from '../src/deployment.js';
import { roleBasedSchemaFingerprint } from '../src/role-based-profile.js';
import type { Run } from '../src/process.js';

const example = JSON.parse(await readFile('sql-apps.example.json', 'utf8'));
const config = deploymentSchema.parse({ ...example, imageSource: await roleBasedSchemaFingerprint(process.cwd()) });
const outputs: DeploymentOutputs = {
  sqlServer: 'example.database.windows.net', databaseName: 'app',
  dabPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  gatewayPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  gatewayName: 'gateway', gatewayUrl: 'https://example.azurecontainerapps.io', networkId: '/network',
  sqlBackupRetentionDays: 7, sqlBackupRedundancy: 'Geo' as const, sqlAuditWorkspaceName: 'logs',
};
function fakeRunner(failSchema = false): { run: Run; calls: string[][]; environments: (NodeJS.ProcessEnv | undefined)[] } {
  const calls: string[][] = [];
  const environments: (NodeJS.ProcessEnv | undefined)[] = [];
  const run: Run = async (command, args, options) => {
    calls.push([command, ...args]);
    environments.push(options?.env);
    if (args[0] === 'account') return JSON.stringify({ id: config.subscriptionId, tenantId: config.tenantId, environmentName: 'AzureCloud' });
    if (args[0] === 'ad' && args[1] === 'app') return JSON.stringify({
      id: config.apiClientId, signInAudience: 'AzureADMyOrg',
      api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{ value: 'access_as_user', isEnabled: true }] },
      appRoles: [{ id: '15d91b1c-83c7-4cb6-b349-d7b8fd4b1425', value: config.requiredRole, isEnabled: true, allowedMemberTypes: ['User'] }],
      spa: { redirectUris: ['http://localhost:8080'] },
    });
    if (args[0] === 'provider') return 'Registered';
    if (args[0] === 'acr' && args[1] === 'repository') return `sha256:${'a'.repeat(64)}`;
    if (args[0] === 'role' && args[1] === 'assignment') return JSON.stringify(expectedRbacAssignments(config, outputs));
    if (args[0] === 'deployment') return JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { value }])));
    if (failSchema && args.includes('/Action:Publish')) throw new Error('SQL network unavailable');
    return '';
  };
  return { run, calls, environments };
}
test('configuration rejects unknown platform settings and floating images', () => {
  assert.throws(() => deploymentSchema.parse({ ...config, fabric: {} }));
  assert.throws(() => deploymentSchema.parse({ ...config, gatewayImage: 'image:latest' }));
  assert.throws(() => deploymentSchema.parse({ ...config, resourceGroup: 'rg;evil' }));
  assert.throws(() => deploymentSchema.parse({ ...config, gatewayImage: 'unrelated.azurecr.io/image:v1' }));
  assert.throws(() => deploymentSchema.parse({ ...config, gatewayImage: `${config.registryServer}/image;evil:v1` }));
  assert.throws(() => deploymentSchema.parse({ ...config, profile: 'foundation' }));
  assert.throws(() => deploymentSchema.parse({ ...config, functionsImage: `${config.registryServer}/fn:v1` }));
});
test('runtime port validation rejects empty, invalid, and out-of-range values', () => {
  assert.equal(portFromEnvironment(undefined), 8080);
  assert.equal(portFromEnvironment('9000'), 9000);
  for (const value of ['', 'bad', '0', '65536']) assert.throws(() => portFromEnvironment(value));
});
test('deployment readiness requires the exact successful gateway response', async () => {
  await requireReadyResponse(Response.json({ status: 'ready' }));
  for (const response of [
    new Response(null, { status: 204 }),
    Response.json({}),
    Response.json({ status: 'live' }),
    Response.json({ status: 'ready', dependency: 'data' }),
    new Response('<h1>ready</h1>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(requireReadyResponse(response), /readiness response/i);
  }
});
test('ARM parameters exclude local routing settings and identify separate environments', () => {
  const parameters = armParameters(config, false).parameters;
  for (const key of ['subscriptionId', 'resourceGroup', 'profile', 'imageSource', 'functionsImage']) {
    assert.equal(key in parameters, false, key);
  }
  assert.deepEqual(parameters.deployGateway, { value: false });
  assert.notEqual(environmentKey(config), environmentKey({ ...config, environment: 'prod' }));
});
test('RBAC handoff uses saved principals and exposes only template inputs', () => {
  assert.deepEqual(rbacParameters(config, outputs).parameters, {
    name: { value: config.name }, environment: { value: config.environment },
    registryServer: { value: config.registryServer },
    gatewayPrincipalId: { value: outputs.gatewayPrincipalId }, dabPrincipalId: { value: outputs.dabPrincipalId },
  });
});
test('expected RBAC assignments are exactly the two ACR pulls', () => {
  const assignments = expectedRbacAssignments(config, outputs);
  assert.deepEqual(assignments.map(item => item.label), ['ACR pull for gateway', 'ACR pull for data']);
  assert.ok(assignments.every(item => item.scope ===
    `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/example`));
});
test('runtime RBAC verification fails closed and names every missing assignment', async () => {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    return '[]';
  };
  await assert.rejects(
    verifyRbacAssignments(config, outputs, run),
    error => error instanceof Error && /RBAC handoff is incomplete/.test(error.message) &&
      /ACR pull for gateway/.test(error.message) && /ACR pull for data/.test(error.message) &&
      /rbac-deploy/.test(error.message),
  );
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call[1] === 'role' && call[2] === 'assignment' && call.includes('--include-inherited')));
});
test('runtime RBAC verification accepts only exact live principal, role and scope matches', async () => {
  const expected = expectedRbacAssignments(config, outputs);
  await verifyRbacAssignments(config, outputs, async () => JSON.stringify(expected));
  await assert.rejects(
    verifyRbacAssignments(config, outputs, async () => JSON.stringify(expected.map(item => ({
      ...item, scope: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}`,
    })))),
    /RBAC handoff is incomplete/,
  );
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
test('preflight without image checks skips registry lookups and checks only role-based providers', async () => {
  const { run, calls } = fakeRunner();
  await preflight(config, run, false);
  assert.equal(calls.some(call => call.includes('repository')), false);
  const providers = calls.filter(call => call[1] === 'provider').map(call => call[call.indexOf('--namespace') + 1]);
  assert.deepEqual(providers, ['Microsoft.App', 'Microsoft.Sql', 'Microsoft.Network', 'Microsoft.ManagedIdentity',
    'Microsoft.OperationalInsights', 'Microsoft.Authorization']);
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
  const { run, calls, environments } = fakeRunner();
  const stages: string[] = [];
  const state = await deploy(config, run, async () => Response.json({ status: 'ready' }), async state => { stages.push(state.stage); });
  assert.equal(state.stage, 'ready');
  assert.deepEqual(stages, ['infrastructure', 'schema', 'runtime', 'ready']);
  const infra = calls.findIndex(call => call.includes(`${config.name}-${config.environment}-infrastructure`));
  const sql = calls.findIndex(call => call.includes('/Action:Publish'));
  const runtime = calls.findIndex(call => call.includes(`${config.name}-${config.environment}-runtime`));
  assert.ok(infra < sql && sql < runtime);
  assert.ok(calls[sql]?.includes('/p:BlockOnPossibleDataLoss=True'));
  // A token argument is readable by other processes on the deployment host; SqlPackage must sign in itself.
  assert.equal(calls.some(call => call.includes('get-access-token')), false);
  assert.equal(calls[sql]?.some(arg => /^\/(AccessToken|at):/i.test(arg)), false);
  assert.ok(calls[sql]?.some(arg => arg.startsWith('/TargetConnectionString:') &&
    arg.includes('Authentication=Active Directory Default;')));
  assert.equal(environments[sql]?.AZURE_TOKEN_CREDENTIALS, 'AzureCliCredential');
  assert.equal(environments[sql]?.AZURE_TENANT_ID, config.tenantId);
});
test('failed schema publish does not start the data/gateway deployment or claim success', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner(true);
  const stages: string[] = [];
  await assert.rejects(deploy(config, run, async () => Response.json({ status: 'ready' }), async state => { stages.push(state.stage); }), /SQL network unavailable/);
  assert.deepEqual(stages, ['infrastructure']);
  assert.equal(calls.some(call => call.includes(`${config.name}-${config.environment}-runtime`)), false);
});
test('deploy writes the grants handoff and passes the same grants to SqlPackage', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner();
  await deploy(config, run, async () => Response.json({ status: 'ready' }), async () => {});
  const handoff = await readFile(grantsHandoffPath(), 'utf8');
  assert.match(handoff, /GRANT EXECUTE ON (OBJECT::)?\[?dbo\]?\.\[?AppReady\]? TO \[sql_apps_dab\]/);
  const argument = calls.find(call => call.includes('/Action:Publish'))?.find(arg => arg.startsWith('/v:RoleBasedProcedureGrants='));
  assert.ok(argument);
  assert.ok(handoff.includes(argument.slice('/v:RoleBasedProcedureGrants='.length)));
});
test('deploy refuses images built from different SQL/DAB source before any Azure change', async t => {
  t.after(cleanupArtifacts);
  const { run, calls } = fakeRunner();
  await assert.rejects(deploy({ ...config, imageSource: 'f'.repeat(64) }, run, async () => Response.json({ status: 'ready' }), async () => {}),
    /run artifacts, then deploy/);
  await assert.rejects(deploy({ ...config, imageSource: undefined }, run, async () => Response.json({ status: 'ready' }), async () => {}),
    /run artifacts, then deploy/);
  assert.equal(calls.some(call => call[1] === 'deployment' || call.includes('/Action:Publish')), false);
});
test('a ready deployment resumes when unchanged and rolls every stage forward when the source hash changes', async t => {
  t.after(async () => {
    await cleanupArtifacts();
    await unlink(statePath(config)).catch(() => {});
  });
  const home = await fs.realpath(process.cwd());
  const ready = async (configHash: string) => saveState(statePath(config),
    { environmentKey: environmentKey(config), configHash, stage: 'ready', outputs, applicationHome: home });
  await mkdir(dirname(statePath(config)), { recursive: true });
  await ready(await deploymentConfigHash(config));
  const unchanged = fakeRunner();
  await deploy(config, unchanged.run, async () => Response.json({ status: 'ready' }), async () => {});
  assert.equal(unchanged.calls.some(call => call[1] === 'deployment' || call.includes('/Action:Publish')), false);
  await ready('previous-source-hash');
  const changed = fakeRunner();
  const stages: string[] = [];
  await deploy(config, changed.run, async () => Response.json({ status: 'ready' }), async state => { stages.push(state.stage); });
  assert.deepEqual(stages, ['infrastructure', 'schema', 'runtime', 'ready']);
  assert.ok(changed.calls.some(call => call.includes('/Action:Publish')));
  assert.ok(changed.calls.some(call => call.includes(`${config.name}-${config.environment}-runtime`)));
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
