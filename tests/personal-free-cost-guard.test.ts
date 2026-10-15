import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPersonalFreeCostGuard } from '../src/personal-free-cost-guard.js';
import type { PersonalFreeConfig, ProtectedDeploymentState } from '../src/personal-free-config.js';
import type { Run } from '../src/process.js';

const config: PersonalFreeConfig = {
  profile: 'personal-free',
  subscriptionId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  sqlAdministratorObjectId: '33333333-3333-4333-8333-333333333333',
  sqlAdministratorName: 'owner@example.com',
  resourceGroup: 'rg-personal',
  location: 'westus2',
  environment: 'prod',
  name: 'personal-tracker',
};

const state: ProtectedDeploymentState = {
  approval: 'abcdef123456',
  stage: 'infrastructure',
  sqlAdministratorPassword: 'a'.repeat(43),
  runtimePassword: 'b'.repeat(43),
  staticWebAppName: 'personal-tracker-prod-abc',
  staticWebAppHostname: 'personal-tracker-prod-abc.azurestaticapps.net',
  sqlServer: 'personal-tracker-prod-abc.database.windows.net',
};

const validSite = {
  name: state.staticWebAppName,
  sku: { name: 'Free', tier: 'Free' },
};

const validDatabase = {
  name: 'app',
  edition: 'GeneralPurpose',
  currentServiceObjectiveName: 'GP_S_Gen5_2',
  maxSizeBytes: 34359738368,
  currentBackupStorageRedundancy: 'Local',
  requestedBackupStorageRedundancy: 'Local',
  useFreeLimit: true,
  freeLimitExhaustionBehavior: 'AutoPause',
};

function azureRun(site = validSite, database = validDatabase): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'staticwebapp') return JSON.stringify(site);
    if (args[0] === 'sql') return JSON.stringify(database);
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { run, calls };
}

test('verifies the deployed free SKUs and non-billing SQL exhaustion behavior', async () => {
  const { run, calls } = azureRun();
  const report = await verifyPersonalFreeCostGuard(config, state, run);
  assert.deepEqual(report, {
    staticWebApp: 'Free',
    sqlFreeLimit: true,
    sqlExhaustionBehavior: 'AutoPause',
    sqlMaxSizeBytes: 34359738368,
    backupStorageRedundancy: 'Local',
  });
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['az', 'staticwebapp', 'show'],
    ['az', 'sql', 'db'],
  ]);
  assert.ok(calls.every(call => call.includes(config.subscriptionId)));
  assert.ok(calls.every(call => call.includes(config.resourceGroup)));
});

test('rejects a paid Static Web Apps SKU', async () => {
  const { run } = azureRun({ ...validSite, sku: { name: 'Standard', tier: 'Standard' } });
  await assert.rejects(
    verifyPersonalFreeCostGuard(config, state, run),
    /Personal-free cost guard failed: Static Web Apps SKU is Standard\/Standard, expected Free\/Free/,
  );
});

test('rejects SQL settings that permit charges or exceed the free storage boundary', async () => {
  const { run } = azureRun(validSite, {
    ...validDatabase,
    useFreeLimit: false,
    freeLimitExhaustionBehavior: 'BillOverUsage',
    maxSizeBytes: 68719476736,
    currentBackupStorageRedundancy: 'Geo',
  });
  await assert.rejects(
    verifyPersonalFreeCostGuard(config, state, run),
    error => {
      assert.match(String(error), /free limit is not enabled/);
      assert.match(String(error), /exhaustion behavior is BillOverUsage/);
      assert.match(String(error), /maximum size is 68719476736/);
      assert.match(String(error), /current backup redundancy is Geo/);
      return true;
    },
  );
});

test('rejects an unexpected SQL database identity or compute objective', async () => {
  const { run } = azureRun(validSite, {
    ...validDatabase,
    name: 'other',
    edition: 'BusinessCritical',
    currentServiceObjectiveName: 'BC_Gen5_2',
  });
  await assert.rejects(
    verifyPersonalFreeCostGuard(config, state, run),
    error => {
      assert.match(String(error), /database name is other/);
      assert.match(String(error), /edition is BusinessCritical/);
      assert.match(String(error), /service objective is BC_Gen5_2/);
      return true;
    },
  );
});

test('fails closed on incomplete Azure output', async () => {
  const { run } = azureRun({ name: state.staticWebAppName } as typeof validSite);
  await assert.rejects(
    verifyPersonalFreeCostGuard(config, state, run),
    /Personal-free cost guard could not verify Azure settings/,
  );
});

test('fails closed when Azure CLI cannot read a resource', async () => {
  const run: Run = async () => {
    throw new Error('Forbidden');
  };
  await assert.rejects(verifyPersonalFreeCostGuard(config, state, run), /Forbidden/);
});

test('requires deployed resource names before querying Azure', async () => {
  const { run, calls } = azureRun();
  await assert.rejects(
    verifyPersonalFreeCostGuard(config, { ...state, staticWebAppName: undefined }, run),
    /requires a deployed Static Web App and SQL server/,
  );
  assert.equal(calls.length, 0);
});
