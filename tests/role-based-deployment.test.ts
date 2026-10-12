import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentSchema, environmentKey } from '../src/config.js';
import { deploy, preflight, provision, saveState, statePath, armParameters, deploymentConfigHash, type DeploymentState } from '../src/deployment.js';
import { buildArtifacts } from '../src/artifacts.js';
import { reviewRoleBasedCost } from '../src/role-based-cost.js';
import { assignApplicationRole } from '../src/role-based-identity.js';
import { roleBasedSmoke } from '../src/role-based-smoke.js';
import type { Run } from '../src/process.js';

const toolingRoot = resolve('.');
const original = process.cwd();
const config = deploymentSchema.parse(JSON.parse(await readFile('azure-role-based.example.json', 'utf8')));
const directory = await mkdtemp(join(tmpdir(), 'sql-apps-role-based-deploy-'));
process.chdir(directory);
after(async () => { process.chdir(original); await rm(directory, { recursive: true, force: true }); });
await mkdir('dab');
await mkdir('sql');
await writeFile(join('sql', 'database.sqlproj'), '<Project />');
await writeFile(join('sql', 'AppReady.sql'), 'CREATE PROCEDURE dbo.AppReady AS SELECT 1 AS ready;');
await writeFile(join('dab', 'dab-config.json'), JSON.stringify({
  runtime: { rest: { enabled: true, path: '/api' }, host: { mode: 'production',
    authentication: { provider: 'AzureAD', jwt: { audience: "@env('API_CLIENT_ID')", issuer: "@env('ENTRA_ISSUER')" } } } },
  entities: { AppReady: {
    source: { type: 'stored-procedure', object: 'dbo.AppReady' },
    rest: { enabled: true, methods: ['get'] }, permissions: [{ role: 'AppUser', actions: ['execute'] }],
  } },
}));
const outputs = {
  sqlServer: 'data-app.database.windows.net', databaseName: 'app',
  dabPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  gatewayPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  gatewayName: 'app-gateway', gatewayUrl: 'https://data-app.azurecontainerapps.io',
  functionsName: '', networkId: '/network', storageAccount: '', vaultName: '',
} as const;
const digest = `sha256:${'a'.repeat(64)}`;
function runner(failRuntime = false) {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'account' && args[1] === 'get-access-token') return '{"accessToken":"test-only-token"}';
    if (args[0] === 'account') return JSON.stringify({ id: config.subscriptionId, tenantId: config.tenantId, environmentName: 'AzureCloud' });
    if (args[0] === 'ad' && args[1] === 'app') return JSON.stringify({
      id: config.apiClientId, signInAudience: 'AzureADMyOrg',
      api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{ value: 'access_as_user', isEnabled: true }] },
      appRoles: [{ id: '530d74b7-cf30-41f4-a44c-9f594cba7c63', value: 'AppUser', isEnabled: true, allowedMemberTypes: ['User'] }],
      spa: { redirectUris: ['http://localhost:8080'] },
    });
    if (args[0] === 'provider') return 'Registered';
    if (args[0] === 'acr' && args[1] === 'repository') return digest;
    if (args[0] === 'deployment') {
      if (failRuntime && args.includes(`${config.name}-${config.environment}-runtime`)) throw new Error('Runtime failed');
      return JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { value }])));
    }
    return '';
  };
  return { run, calls };
}
test('authorized cost review matches paid template and never infers spending approval', () => {
  const report = reviewRoleBasedCost({ version: 1, profile: 'role-based-data', intent: 'zero-azure-spend', acknowledgeFixedCharges: false });
  assert.equal(report.review.canProceedToWhatIf, false);
  assert.equal(report.estimatedMonthlyCost, null);
  assert.equal(report.deployment.authorized, false);
  assert.equal(report.resources[0]!.sku, 'S0');
  assert.throws(() => reviewRoleBasedCost({ version: 1, profile: 'public-demo', intent: 'review-paid-costs', acknowledgeFixedCharges: true }));
});
test('authorized artifacts publish only gateway and DAB images', async () => {
  const { run, calls } = runner();
  const pinned = await buildArtifacts(config, run);
  assert.equal(pinned.functionsImage, '');
  assert.deepEqual(calls.filter(call => call.includes('build')).map(call => call[call.indexOf('--file') + 1]),
    [join(toolingRoot, 'Dockerfile'), join(toolingRoot, 'dab', 'Dockerfile')]);
});
test('authorized preflight and deployment omit excluded providers and function-role grants', async t => {
  const { run, calls } = runner();
  const stages: string[] = [];
  t.after(async () => {
    for (const suffix of ['.parameters.json', '.redirect.json']) await unlink(`${statePath(config)}${suffix}`);
  });
  const state = await deploy(config, run, async () => Response.json({ status: 'ready' }), async state => { stages.push(state.stage); });
  assert.equal(state.stage, 'ready');
  assert.deepEqual(stages, ['infrastructure', 'schema', 'runtime', 'ready']);
  assert.equal(calls.some(call => call.includes('Microsoft.Web') || call.includes('Microsoft.Storage') || call.includes('Microsoft.KeyVault')), false);
  assert.equal(calls.some(call => call.includes('POST') && call.includes('rest')), false);
  const publish = calls.find(call => call.includes('/Action:Publish'))!;
  assert.ok(publish.some(value => value.startsWith('/v:RoleBasedProcedureGrants=GRANT EXECUTE ON OBJECT::[dbo].[AppReady]')));
  assert.deepEqual(armParameters(config, true).parameters.profile, { value: 'role-based-data' });
});
test('authorized deploy resumes retained schema stage without provisioning or publishing again', async t => {
  const prior: DeploymentState = {
    environmentKey: environmentKey(config),
    configHash: await deploymentConfigHash(config),
    stage: 'schema', outputs, applicationHome: directory,
  };
  await saveState(statePath(config), prior);
  t.after(async () => { await unlink(statePath(config)); await unlink(`${statePath(config)}.parameters.json`); await unlink(`${statePath(config)}.redirect.json`); });
  const { run, calls } = runner();
  await deploy(config, run, async () => new Response('{}'), async () => {});
  assert.equal(calls.some(call => call.includes('/Action:Publish') || call.includes(`${config.name}-${config.environment}-infrastructure`)), false);
});
test('failed authorized runtime retains schema stage and never claims readiness', async t => {
  const { run } = runner(true);
  const stages: string[] = [];
  t.after(() => unlink(`${statePath(config)}.parameters.json`));
  await assert.rejects(deploy(config, run, async () => new Response('{}'), async state => { stages.push(state.stage); }), /Runtime failed/);
  assert.deepEqual(stages, ['infrastructure', 'schema']);
});
test('authorized deployment refuses copied state and changed SQL source before resource writes', async () => {
  const prior: DeploymentState = {
    environmentKey: environmentKey(config), configHash: await deploymentConfigHash(config),
    stage: 'schema', outputs, applicationHome: join(directory, 'other-checkout'),
  };
  const { run, calls } = runner();
  await saveState(statePath(config), prior);
  try {
    await assert.rejects(deploy(config, run, async () => new Response('{}'), async () => {}), /different application checkout/);
    await assert.rejects(provision(config, run), /different application checkout/);
    await saveState(statePath(config), { ...prior, applicationHome: directory });
    assert.equal((await provision(config, run)).stage, 'schema');
    await writeFile(join('sql', 'AppReady.sql'), 'CREATE PROCEDURE dbo.AppReady AS SELECT 2 AS ready;');
    await assert.rejects(deploy(config, run, async () => new Response('{}'), async () => {}), /SQL\/DAB source changed/);
    await assert.rejects(provision(config, run), /SQL\/DAB source changed/);
    assert.equal(calls.some(call => call.includes('deployment') || call.includes('/Action:Publish')), false);
  } finally {
    await writeFile(join('sql', 'AppReady.sql'), 'CREATE PROCEDURE dbo.AppReady AS SELECT 1 AS ready;');
    await unlink(statePath(config));
  }
});
test('authorized preflight refuses application-only roles', async () => {
  const { run } = runner();
  await assert.rejects(preflight(config, async (command, args) => {
    const output = await run(command, args);
    return args[0] === 'ad' ? output.replace('"User"', '"Application"') : output;
  }), /App registration/);
});
test('application role assignment validates target role and skips an existing assignment', async () => {
  const principal = '11111111-1111-4111-8111-111111111111';
  let writes = 0;
  await assignApplicationRole(config, principal, async (_command, args) => {
    if (args[0] === 'account') return JSON.stringify({ tenantId: config.tenantId });
    if (args[0] === 'ad') return JSON.stringify({ id: config.apiClientId,
      appRoles: [{ id: principal, value: 'AppUser', isEnabled: true, allowedMemberTypes: ['User'] }] });
    if (args.includes('GET')) return JSON.stringify({ value: [{ principalId: principal, appRoleId: principal, resourceId: config.apiClientId }] });
    writes++;
    return '';
  });
  assert.equal(writes, 0);
});
test('authorized smoke checks authorized procedure and denies role-forged users without the required role and anonymous calls', async () => {
  const codes = [200, 403, 401];
  const roles: (string | null)[] = [];
  await roleBasedSmoke(config, outputs.gatewayUrl, 'authorized', 'unauthorized', async (_url, options) => {
    roles.push(new Headers(options?.headers).get('x-ms-api-role'));
    const status = codes.shift();
    assert.ok(status);
    return new Response('{}', { status });
  });
  assert.deepEqual(roles, ['forged-admin', 'AppUser', 'AppUser']);
  await assert.rejects(roleBasedSmoke(config, outputs.gatewayUrl, 'authorized', 'unauthorized', async () => new Response('{}')), /without the required role/);
});
