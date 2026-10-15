import { z } from 'zod';
import type { PersonalFreeConfig, ProtectedDeploymentState } from './personal-free-config.js';
import type { Run } from './process.js';

const freeMaxSizeBytes = 34359738368 as const;

const staticWebAppSchema = z.object({
  name: z.string().min(1),
  sku: z.object({
    name: z.string().min(1),
    tier: z.string().min(1),
  }),
});

const databaseSchema = z.object({
  name: z.string().min(1),
  edition: z.string().min(1),
  currentServiceObjectiveName: z.string().min(1),
  maxSizeBytes: z.number().int().positive(),
  currentBackupStorageRedundancy: z.string().min(1),
  requestedBackupStorageRedundancy: z.string().min(1),
  useFreeLimit: z.boolean(),
  freeLimitExhaustionBehavior: z.string().min(1),
});

export interface PersonalFreeCostReport {
  staticWebApp: 'Free';
  sqlFreeLimit: true;
  sqlExhaustionBehavior: 'AutoPause';
  sqlMaxSizeBytes: typeof freeMaxSizeBytes;
  backupStorageRedundancy: 'Local';
}

function parseAzureOutput<T>(schema: z.ZodType<T>, text: string, resource: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Personal-free cost guard could not verify Azure settings for ${resource}: ${detail}`);
  }
}

export async function verifyPersonalFreeCostGuard(
  config: PersonalFreeConfig,
  state: ProtectedDeploymentState,
  run: Run,
): Promise<PersonalFreeCostReport> {
  if (!state.staticWebAppName || !state.sqlServer) {
    throw new Error('Personal-free cost guard requires a deployed Static Web App and SQL server');
  }
  const suffix = '.database.windows.net';
  if (!state.sqlServer.endsWith(suffix)) {
    throw new Error(`Personal-free cost guard could not verify SQL server name: ${state.sqlServer}`);
  }
  const sqlServerName = state.sqlServer.slice(0, -suffix.length);
  const site = parseAzureOutput(staticWebAppSchema, await run('az', [
    'staticwebapp', 'show',
    '--subscription', config.subscriptionId,
    '--resource-group', config.resourceGroup,
    '--name', state.staticWebAppName,
    '-o', 'json',
  ]), 'Static Web Apps');
  const database = parseAzureOutput(databaseSchema, await run('az', [
    'sql', 'db', 'show',
    '--subscription', config.subscriptionId,
    '--resource-group', config.resourceGroup,
    '--server', sqlServerName,
    '--name', 'app',
    '-o', 'json',
  ]), 'Azure SQL Database');

  const violations: string[] = [];
  if (site.name !== state.staticWebAppName) {
    violations.push(`Static Web App name is ${site.name}, expected ${state.staticWebAppName}`);
  }
  if (site.sku.name !== 'Free' || site.sku.tier !== 'Free') {
    violations.push(`Static Web Apps SKU is ${site.sku.name}/${site.sku.tier}, expected Free/Free`);
  }
  if (database.name !== 'app') violations.push(`database name is ${database.name}, expected app`);
  if (database.edition !== 'GeneralPurpose') {
    violations.push(`edition is ${database.edition}, expected GeneralPurpose`);
  }
  if (database.currentServiceObjectiveName !== 'GP_S_Gen5_2') {
    violations.push(`service objective is ${database.currentServiceObjectiveName}, expected GP_S_Gen5_2`);
  }
  if (!database.useFreeLimit) violations.push('free limit is not enabled');
  if (database.freeLimitExhaustionBehavior !== 'AutoPause') {
    violations.push(`exhaustion behavior is ${database.freeLimitExhaustionBehavior}, expected AutoPause`);
  }
  if (database.maxSizeBytes !== freeMaxSizeBytes) {
    violations.push(`maximum size is ${database.maxSizeBytes}, expected ${freeMaxSizeBytes}`);
  }
  if (database.currentBackupStorageRedundancy !== 'Local') {
    violations.push(`current backup redundancy is ${database.currentBackupStorageRedundancy}, expected Local`);
  }
  if (database.requestedBackupStorageRedundancy !== 'Local') {
    violations.push(`requested backup redundancy is ${database.requestedBackupStorageRedundancy}, expected Local`);
  }
  if (violations.length) throw new Error(`Personal-free cost guard failed: ${violations.join('; ')}`);

  return {
    staticWebApp: 'Free',
    sqlFreeLimit: true,
    sqlExhaustionBehavior: 'AutoPause',
    sqlMaxSizeBytes: freeMaxSizeBytes,
    backupStorageRedundancy: 'Local',
  };
}
