import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../src/process.js';

test('publish status verifies live free settings and fails closed on drift', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-personal-free-cli-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  process.env.SQL_APPS_PROJECT_HOME = root;
  const { main } = await import('../src/personal-free-cli.js');
  const configPath = join(root, 'sql-apps.personal-free.json');
  const config = {
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
  await writeFile(configPath, JSON.stringify(config));
  const stateDirectory = join(root, '.sql-apps', 'deployments');
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(join(stateDirectory, 'personal-tracker-prod.json'), JSON.stringify({
    approval: 'abcdef123456',
    stage: 'ready',
    sqlAdministratorPassword: 'a'.repeat(43),
    runtimePassword: 'b'.repeat(43),
    staticWebAppName: 'personal-tracker-prod-abc',
    staticWebAppHostname: 'personal-tracker-prod-abc.azurestaticapps.net',
    sqlServer: 'personal-tracker-prod-abc.database.windows.net',
  }));

  let paid = false;
  const run: Run = async (_command, args) => {
    if (args[0] === 'staticwebapp') {
      return JSON.stringify({
        name: 'personal-tracker-prod-abc',
        sku: { name: paid ? 'Standard' : 'Free', tier: paid ? 'Standard' : 'Free' },
      });
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

  const messages: string[] = [];
  await main(['status', '--config', configPath], message => messages.push(message), run);
  assert.match(messages.join('\n'), /Cost guard: verified/);
  assert.match(messages.join('\n'), /Static Web Apps: Free/);
  assert.match(messages.join('\n'), /Azure SQL: free offer, AutoPause at monthly limit/);

  paid = true;
  await assert.rejects(
    main(['status', '--config', configPath], () => {}, run),
    /Static Web Apps SKU is Standard\/Standard/,
  );

  const missingAzure: Run = async () => {
    throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
  };
  await assert.rejects(
    main(['status', '--config', configPath], () => {}, missingAzure),
    /spawn az ENOENT/,
  );
});
