import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run, type Run } from '../src/process.js';
import { deploymentSchema } from '../src/config.js';
import { deploymentName, initDeploymentConfig, planDeployAll, unsetClientId } from '../src/azure-init.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentConfig } from '../src/config.js';
import type { DeploymentState } from '../src/deployment.js';

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
  assert.equal(config.functionsImage, '');
  assert.ok(calls.every(call => call[1] === 'account' || call.join(' ').includes('signed-in-user show')), 'init must only read Azure');
});

test('azure init builds a foundation config with a functions image and rejects service principals', async t => {
  const root = await home(t, false);
  const config = await initDeploymentConfig({ profile: 'foundation', location: 'westus2', resourceGroup: 'rg', registryServer: 'r1.azurecr.io', environment: 'test', name: 'demo-app' }, signedIn().run, root);
  assert.equal(config.profile, 'foundation');
  assert.equal(config.requiredRole, undefined);
  assert.match(config.functionsImage, /^r1\.azurecr\.io\/demo-app-functions:/);
  await assert.rejects(initDeploymentConfig({ profile: 'foundation', location: 'westus2', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn('servicePrincipal').run, root), /signed-in user/);
  await assert.rejects(initDeploymentConfig({ profile: 'role-based-data', location: 'westus2', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root), /role-based-data\.json/);
});

test('deploy-all review is read-only and a stale approval id runs nothing; init never overwrites', async t => {
  const root = await home(t, false);
  const config = await initDeploymentConfig({ profile: 'foundation', location: 'eastus', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root);
  const path = join(root, 'azure.json');
  await writeFile(path, JSON.stringify(config));
  const cli = resolve('dist/src/cli.js');
  const shown = await run(process.execPath, [cli, 'deploy-all', path]);
  assert.match(shown, /Pending paid Azure steps .*: identity -> artifacts -> provision -> deploy -> status/);
  assert.match(shown, /--approve [a-f0-9]{12}/);
  await assert.rejects(run(process.execPath, [cli, 'deploy-all', path, '--approve', '000000000000']), /changed since review/);
  await assert.rejects(run(process.execPath, [cli, 'init', path, '--profile', 'foundation']), /already exists/);
  await assert.rejects(run(process.execPath, [cli, 'plan', path]), /run identity/);
});

test('deploy-all lists only pending paid steps and binds approval to the config and remaining work', async t => {
  const root = await home(t);
  const config = await initDeploymentConfig({ location: 'westus2', resourceGroup: 'rg-expense', registryServer: 'expense.azurecr.io' }, signedIn().run, root);
  const fresh = planDeployAll(config, undefined);
  assert.deepEqual(fresh.pending, ['identity', 'artifacts', 'provision', 'deploy', 'status']);
  assert.match(fresh.approval, /^[a-f0-9]{12}$/);
  const digest = `@sha256:${'a'.repeat(64)}`;
  const pinned = { ...config, apiClientId: '33333333-3333-4333-8333-333333333333',
    gatewayImage: `expense.azurecr.io/expense-tracker-gateway${digest}`, dabImage: `expense.azurecr.io/expense-tracker-data${digest}` };
  const resumed = planDeployAll(pinned, 'schema');
  assert.deepEqual(resumed.pending, ['deploy', 'status']);
  assert.notEqual(resumed.approval, fresh.approval);
  assert.deepEqual(planDeployAll(pinned, 'ready').pending, ['status']);
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
        functionPrincipalId: '',
        gatewayName: 'fixture-gateway', gatewayUrl: 'https://fixture.invalid', functionsName: 'fixture-functions',
        networkId: 'fixture-network', storageAccount: 'fixturestorage', vaultName: 'fixture-vault',
        sqlBackupRetentionDays: 7, sqlBackupRedundancy: 'Geo', sqlAuditWorkspaceName: 'fixture-logs' } });
  `], { cwd: root });
}

test('deploy-all rejects changed image digests instead of skipping a saved deployment', async t => {
  const root = await home(t, false);
  const initial = await initDeploymentConfig({ profile: 'foundation', location: 'eastus', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root);
  const digest = `@sha256:${'a'.repeat(64)}`;
  const config = { ...initial, apiClientId: operator,
    gatewayImage: `r1.azurecr.io/gateway${digest}`, dabImage: `r1.azurecr.io/data${digest}`, functionsImage: `r1.azurecr.io/functions${digest}` };
  const cli = resolve('dist/src/cli.js');
  const path = join(root, 'azure.json');
  for (const stage of ['infrastructure', 'ready'] as const) {
    await saveDeployment(root, config, stage);
    await writeFile(path, JSON.stringify(config));
    const unchanged = await execute(process.execPath, [cli, 'deploy-all', path], { cwd: root });
    assert.match(unchanged.stdout, stage === 'ready' ? /: status/ : /: deploy -> status/);
    await writeFile(path, JSON.stringify({ ...config, gatewayImage: `r1.azurecr.io/gateway@sha256:${'b'.repeat(64)}` }));
    await assert.rejects(execute(process.execPath, [cli, 'deploy-all', path], { cwd: root }),
      /configuration or SQL\/DAB source changed.*review.*saved deployment/i);
  }
});

test('deploy-all rejects changed role-based SQL source before reusing a ready stage', async t => {
  const root = await home(t);
  await mkdir(join(root, 'dab'));
  await mkdir(join(root, 'sql'));
  await writeFile(join(root, 'dab', 'dab-config.json'), '{}');
  const sql = join(root, 'sql', 'Ready.sql');
  await writeFile(sql, 'CREATE PROCEDURE dbo.Ready AS SELECT 1;');
  const initial = await initDeploymentConfig({ profile: 'role-based-data', location: 'eastus', resourceGroup: 'rg', registryServer: 'r1.azurecr.io' }, signedIn().run, root);
  const config = { ...initial, apiClientId: operator,
    gatewayImage: `r1.azurecr.io/gateway@sha256:${'a'.repeat(64)}`, dabImage: `r1.azurecr.io/data@sha256:${'a'.repeat(64)}` };
  await saveDeployment(root, config, 'ready');
  const path = join(root, 'azure.json');
  await writeFile(path, JSON.stringify(config));
  await writeFile(sql, 'CREATE PROCEDURE dbo.Ready AS SELECT 2;');
  await assert.rejects(execute(process.execPath, [resolve('dist/src/cli.js'), 'deploy-all', path], { cwd: root }),
    /configuration or SQL\/DAB source changed.*review.*saved deployment/i);
});
