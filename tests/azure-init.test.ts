import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run, type Run } from '../src/process.js';
import { deploymentSchema } from '../src/config.js';
import { deploymentName, initDeploymentConfig, planDeployAll, unsetClientId } from '../src/azure-init.js';
import { ensureApplicationIdentity } from '../src/role-based-identity.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentConfig } from '../src/config.js';
import type { DeploymentState } from '../src/deployment.js';
import { roleBasedSchemaFingerprint } from '../src/role-based-profile.js';

const execute = promisify(execFile);

const tenant = '22222222-2222-4222-8222-222222222222';
const subscription = '11111111-1111-4111-8111-111111111111';
const operator = '44444444-4444-4444-8444-444444444444';

function signedIn(type = 'user'): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'account' && args[1] === 'show') return JSON.stringify({ id: subscription, tenantId: tenant, user: { name: 'ada@contoso.com', type } });
    if (args.join(' ') === 'ad signed-in-user show --query id -o tsv') return `${operator}\n`;
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  return { run, calls };
}

async function home(t: { after(fn: () => Promise<void>): void }, roleBased = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'application.json'), JSON.stringify({ name: 'Expense Tracker!', selectedExamples: [] }));
  if (roleBased) await writeFile(join(root, 'role-based-data.json'), JSON.stringify({ profile: 'role-based-data', requiredRole: 'Approver', readinessPath: '/api/Ready' }));
  return root;
}

async function project(t: { after(fn: () => Promise<void>): void }): Promise<{ root: string; sql: string }> {
  const root = await home(t);
  await mkdir(join(root, 'dab'));
  await mkdir(join(root, 'sql'));
  await writeFile(join(root, 'dab', 'dab-config.json'), '{}');
  const sql = join(root, 'sql', 'Ready.sql');
  await writeFile(sql, 'CREATE PROCEDURE dbo.Ready AS SELECT 1;');
  return { root, sql };
}

test('deployment names stay bounded without collisions after normalization', () => {
  const first = deploymentName('customer-portal-production');
  const second = deploymentName('customer-portal-staging');
  assert.match(first, /^[a-z][a-z0-9-]{2,19}$/);
  assert.match(second, /^[a-z][a-z0-9-]{2,19}$/);
  assert.notEqual(first, second);
  assert.equal(deploymentName('Expense Tracker!'), 'expense-tracker');
});

test('azure init derives tenant, subscription, operator and role settings and asks only for placement', async t => {
  const root = await home(t);
  const { run, calls } = signedIn();
  const config = await initDeploymentConfig({ location: 'westus2', resourceGroup: 'rg-expense', registryServer: 'expense.azurecr.io' }, run, root);
  assert.equal(config.profile, 'role-based-data', 'POC initialization defaults to the lowest-cost cloud profile');
  assert.deepEqual(deploymentSchema.parse(config), config);
  assert.equal(config.tenantId, tenant);
  assert.equal(config.subscriptionId, subscription);
  assert.equal(config.sqlAdminObjectId, operator);
  assert.equal(config.sqlAdminName, 'ada@contoso.com');
  assert.equal(config.requiredRole, 'Approver');
  assert.equal(config.readinessPath, '/api/Ready');
  assert.equal(config.name, 'expense-tracker');
  assert.equal(config.environment, 'dev');
  assert.equal(config.apiClientId, unsetClientId, 'identity fills the client id; init never invents one');
  assert.match(config.gatewayImage, /^expense\.azurecr\.io\/expense-tracker-gateway:/);
  assert.equal('functionsImage' in config, false);
  assert.ok(calls.every(call => call[1] === 'account' || call.join(' ').includes('signed-in-user show')), 'init must only read Azure');
});

test('azure init rejects service principals and projects without role-based-data.json', async t => {
  await assert.rejects(initDeploymentConfig({ location: 'westus2', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn('servicePrincipal').run, await home(t)), /signed-in user/);
  await assert.rejects(initDeploymentConfig({ location: 'westus2', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, await home(t, false)), /role-based-data\.json/);
});

test('identity creation resumes after a partial failure without creating a duplicate application', async t => {
  const root = await home(t);
  const configPath = join(root, 'azure.json');
  const config = await initDeploymentConfig({
    location: 'westus2', resourceGroup: 'rg-expense', registryServer: 'expense.azurecr.io',
  }, signedIn().run, root);
  await writeFile(configPath, JSON.stringify(config));
  const applicationId = '55555555-5555-4555-8555-555555555555';
  const objectId = '66666666-6666-4666-8666-666666666666';
  let creates = 0;
  let failPatch = true;
  const calls: string[][] = [];
  const identityRun: Run = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'account') return JSON.stringify({ tenantId: config.tenantId });
    if (args[0] === 'ad' && args[1] === 'app' && args[2] === 'create') {
      creates++;
      return JSON.stringify({ id: objectId, appId: applicationId });
    }
    if (args[0] === 'rest' && failPatch) throw new Error('Transient Graph failure');
    return '';
  };
  await assert.rejects(ensureApplicationIdentity(config, configPath, identityRun, root), /Transient Graph failure/);
  failPatch = false;
  const updated = await ensureApplicationIdentity(config, configPath, identityRun, root);
  assert.equal(creates, 1);
  assert.equal(updated.apiClientId, applicationId);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).apiClientId, applicationId);
  assert.equal(calls.filter(call => call[0] === 'rest').length, 2);
});

test('identity creation refuses to replace a configured application', async t => {
  const root = await home(t);
  const config = {
    ...await initDeploymentConfig({
      location: 'westus2', resourceGroup: 'rg-expense', registryServer: 'expense.azurecr.io',
    }, signedIn().run, root),
    apiClientId: '33333333-3333-4333-8333-333333333333',
  };
  let calls = 0;
  await assert.rejects(
    ensureApplicationIdentity(config, join(root, 'azure.json'), async () => { calls++; return ''; }, root),
    /already has an apiClientId/,
  );
  assert.equal(calls, 0);
});

test('deploy-all review is read-only and a stale approval id runs nothing; init never overwrites', async t => {
  const root = await home(t);
  const config = await initDeploymentConfig({ location: 'eastus', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root);
  const path = join(root, 'azure.json');
  await writeFile(path, JSON.stringify(config));
  const cli = resolve('dist/src/cli.js');
  const shown = await run(process.execPath, [cli, 'deploy-all', path]);
  assert.match(shown, /Pending paid Azure steps .*: identity -> artifacts -> provision -> deploy -> status/);
  assert.match(shown, /--approve [a-f0-9]{12}/);
  await assert.rejects(run(process.execPath, [cli, 'deploy-all', path, '--approve', '000000000000']), /changed since review/);
  await assert.rejects(run(process.execPath, [cli, 'init', path, '--location', 'eastus', '--resource-group', 'rg', '--registry', 'r1.azurecr.io']), /already exists/);
  const repositoryRole = join(root, 'repository-role.json');
  await writeFile(repositoryRole, JSON.stringify({ ...config, requiredRole: 'AppUser', readinessPath: '/api/AppReady' }));
  await assert.rejects(run(process.execPath, [cli, 'plan', repositoryRole]), /run identity/);
});

test('deploy-all lists only pending paid steps and binds approval to the config and remaining work', async t => {
  const root = await home(t);
  const config = await initDeploymentConfig({ location: 'westus2', resourceGroup: 'rg-expense', registryServer: 'expense.azurecr.io' }, signedIn().run, root);
  const source = 'c'.repeat(64);
  const fresh = planDeployAll(config, undefined, source);
  assert.deepEqual(fresh.pending, ['identity', 'artifacts', 'provision', 'deploy', 'status']);
  assert.match(fresh.approval, /^[a-f0-9]{12}$/);
  const digest = `@sha256:${'a'.repeat(64)}`;
  const pinned = { ...config, apiClientId: '33333333-3333-4333-8333-333333333333',
    gatewayImage: `expense.azurecr.io/expense-tracker-gateway${digest}`, dabImage: `expense.azurecr.io/expense-tracker-data${digest}`, imageSource: source };
  const resumed = planDeployAll(pinned, 'schema', source);
  assert.deepEqual(resumed.pending, ['deploy', 'status']);
  assert.notEqual(resumed.approval, fresh.approval);
  assert.deepEqual(planDeployAll(pinned, 'ready', source).pending, ['status']);
  assert.deepEqual(planDeployAll(pinned, 'ready', 'd'.repeat(64)).pending, ['artifacts', 'status'],
    'images built from older SQL/DAB source make artifacts pending again');
  assert.ok(fresh.excluded.some(item => /rbac-deploy/.test(item)), 'privileged Azure RBAC stays a separate administrator decision');
  assert.ok(fresh.excluded.some(item => /role-based-assign/.test(item)), 'role assignment names a person and stays a separate decision');
});

async function saveDeployment(root: string, config: DeploymentConfig, stage: DeploymentState['stage']) {
  const deployment = new URL('../src/deployment.js', import.meta.url).href;
  const configuration = new URL('../src/config.js', import.meta.url).href;
  await execute(process.execPath, ['--input-type=module', '-e', `
    import { deploymentConfigHash, saveState, statePath } from ${JSON.stringify(deployment)};
    import { environmentKey } from ${JSON.stringify(configuration)};
    import { realpath } from 'node:fs/promises';
    const config = ${JSON.stringify(config)};
    await saveState(statePath(config), { environmentKey: environmentKey(config),
      configHash: await deploymentConfigHash(config), stage: ${JSON.stringify(stage)}, applicationHome: await realpath('.'),
      outputs: { sqlServer: 'fixture.database.windows.net', databaseName: 'app',
        dabPrincipalId: '55555555-5555-4555-8555-555555555555',
        gatewayPrincipalId: '66666666-6666-4666-8666-666666666666',
        gatewayName: 'fixture-gateway', gatewayUrl: 'https://fixture.invalid', networkId: 'fixture-network',
        sqlBackupRetentionDays: 7, sqlBackupRedundancy: 'Geo', sqlAuditWorkspaceName: 'fixture-logs' } });
  `], { cwd: root });
}

test('deploy-all makes deploy pending again when the configuration changes after a saved deployment', async t => {
  const { root } = await project(t);
  const initial = await initDeploymentConfig({ location: 'eastus', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root);
  const digest = `@sha256:${'a'.repeat(64)}`;
  const config = { ...initial, apiClientId: operator, imageSource: await roleBasedSchemaFingerprint(root),
    gatewayImage: `r1.azurecr.io/gateway${digest}`, dabImage: `r1.azurecr.io/data${digest}` };
  const cli = resolve('dist/src/cli.js');
  const path = join(root, 'azure.json');
  for (const stage of ['infrastructure', 'ready'] as const) {
    await saveDeployment(root, config, stage);
    await writeFile(path, JSON.stringify(config));
    const unchanged = await execute(process.execPath, [cli, 'deploy-all', path], { cwd: root });
    assert.match(unchanged.stdout, stage === 'ready' ? /: status\r?\n/ : /: deploy -> status/);
    await writeFile(path, JSON.stringify({ ...config, gatewayImage: `r1.azurecr.io/gateway@sha256:${'b'.repeat(64)}` }));
    const changed = await execute(process.execPath, [cli, 'deploy-all', path], { cwd: root });
    assert.match(changed.stdout, /: deploy -> status/);
  }
});

test('deploy-all rebuilds artifacts and redeploys after a SQL source change to a ready deployment', async t => {
  const { root, sql } = await project(t);
  const initial = await initDeploymentConfig({ location: 'eastus', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root);
  const config = { ...initial, apiClientId: operator, imageSource: await roleBasedSchemaFingerprint(root),
    gatewayImage: `r1.azurecr.io/gateway@sha256:${'a'.repeat(64)}`, dabImage: `r1.azurecr.io/data@sha256:${'a'.repeat(64)}` };
  await saveDeployment(root, config, 'ready');
  const path = join(root, 'azure.json');
  await writeFile(path, JSON.stringify(config));
  await writeFile(sql, 'CREATE PROCEDURE dbo.Ready AS SELECT 2;');
  const { stdout } = await execute(process.execPath, [resolve('dist/src/cli.js'), 'deploy-all', path], { cwd: root });
  assert.match(stdout, /: artifacts -> deploy -> status/);
});
