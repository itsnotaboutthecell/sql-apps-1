import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveProtectedDeploymentRevision,
  createPersonalFreeResourceGroup,
  createProtectedDeploymentState,
  initPersonalFreeConfig,
  planPersonalFreeDeployment,
  saveProtectedDeploymentState,
  verifyPersonalFreeReadiness,
  verifyPersonalFreeInfrastructure,
} from '../src/personal-free-deployment.js';
import type { Run } from '../src/process.js';

const subscriptionId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const operatorId = '33333333-3333-4333-8333-333333333333';

test('personal-free init is read-only and plan binds warnings to approval', async () => {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'account') return JSON.stringify({
      id: subscriptionId, tenantId, user: { name: 'owner@example.com', type: 'user' },
    });
    if (args[0] === 'ad') return operatorId;
    throw new Error('unexpected write');
  };
  const config = await initPersonalFreeConfig({
    name: 'Personal Tracker',
    location: 'westus2',
    resourceGroup: 'rg-personal',
  }, run);
  assert.equal(config.profile, 'personal-free');
  assert.equal(config.name, 'personal-tracker');
  assert.ok(calls.every(call => call[1] === 'account' || call[1] === 'ad'));
  const plan = planPersonalFreeDeployment(config, 'source-hash');
  assert.match(plan.summary, /potentially \$0/i);
  assert.match(plan.summary, /no SLA/i);
  assert.match(plan.summary, /public endpoint/i);
  assert.match(plan.summary, /all resources inside the Azure boundary/i);
  assert.match(plan.approval, /^[a-f0-9]{12}$/);
  assert.equal(planPersonalFreeDeployment(config, 'changed').approval === plan.approval, false);
});

test('personal-free resource group carries the project tracking tag', async () => {
  const calls: string[][] = [];
  const config = await initPersonalFreeConfig({
    name: 'Personal Tracker',
    location: 'westus2',
    resourceGroup: 'rg-personal',
    environment: 'prod',
  }, async (_command, args) => args[0] === 'account'
    ? JSON.stringify({ id: subscriptionId, tenantId, user: { name: 'owner@example.com', type: 'user' } })
    : operatorId);
  const command: Run = async (executable, args) => {
    calls.push([executable, ...args]);
    return '';
  };
  await createPersonalFreeResourceGroup(config, command);
  assert.deepEqual(calls, [
    [
      'az', 'group', 'create',
      '--subscription', subscriptionId,
      '--name', 'rg-personal',
      '--location', 'westus2',
      '-o', 'none',
    ],
    [
      'az', 'group', 'update',
      '--subscription', subscriptionId,
      '--name', 'rg-personal',
      '--set', 'tags.project=sql-apps', 'tags.environment=prod', 'tags.deployment=personal-free',
      '-o', 'none',
    ],
  ]);
});

test('protected deployment state contains strong secrets and is written privately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-personal-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = createProtectedDeploymentState('abcdef123456');
  assert.match(state.sqlAdministratorPassword, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state.runtimePassword, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state.sqlAdministratorPassword, state.runtimePassword);
  const path = join(directory, 'state.json');
  await saveProtectedDeploymentState(path, state);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), state);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a newly approved build preserves protected credentials for the existing deployment', () => {
  const state = createProtectedDeploymentState('0123456789ab');
  const revised = approveProtectedDeploymentRevision(
    { ...state, stage: 'ready', staticWebAppName: 'app', sqlServer: 'app.database.windows.net' },
    'abcdef012345',
  );
  assert.equal(revised.approval, 'abcdef012345');
  assert.equal(revised.stage, 'new');
  assert.equal(revised.sqlAdministratorPassword, state.sqlAdministratorPassword);
  assert.equal(revised.runtimePassword, state.runtimePassword);
});

test('infrastructure stage is returned only after the live cost guard passes', async () => {
  const state = createProtectedDeploymentState('0123456789ab');
  const config = await initPersonalFreeConfig({
    name: 'Personal Tracker',
    location: 'westus2',
    resourceGroup: 'rg-personal',
  }, async (_command, args) => args[0] === 'account'
    ? JSON.stringify({ id: subscriptionId, tenantId, user: { name: 'owner@example.com', type: 'user' } })
    : operatorId);
  const outputs = {
    staticWebAppName: 'personal-tracker-prod-abc',
    staticWebAppHostname: 'personal-tracker-prod-abc.azurestaticapps.net',
    sqlServer: 'personal-tracker-prod-abc.database.windows.net',
    databaseName: 'app' as const,
  };
  const paidRun: Run = async (_command, args) => {
    if (args[0] === 'staticwebapp') {
      return JSON.stringify({ name: outputs.staticWebAppName, sku: { name: 'Standard', tier: 'Standard' } });
    }
    return JSON.stringify({
      name: 'app',
      edition: 'GeneralPurpose',
      currentServiceObjectiveName: 'GP_S_Gen5_2',
      maxSizeBytes: 34359738368,
      currentBackupStorageRedundancy: 'Local',
      requestedBackupStorageRedundancy: 'Local',
      useFreeLimit: true,
      freeLimitExhaustionBehavior: 'AutoPause',
    });
  };
  const savedStages: string[] = [];
  await assert.rejects(
    verifyPersonalFreeInfrastructure(config, state, outputs, paidRun, async prepared => {
      savedStages.push(prepared.stage);
    }),
    /Static Web Apps SKU is Standard\/Standard/,
  );
  assert.deepEqual(savedStages, ['infrastructure']);
});

test('personal-free readiness uses a bounded request', async () => {
  let signal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    signal = init?.signal;
    return Response.json({ status: 'ready' });
  };
  await verifyPersonalFreeReadiness('personal-tracker.azurestaticapps.net', fetcher);
  assert.ok(signal instanceof AbortSignal);
});
