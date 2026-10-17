import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { validateSqlTarget, type SqlTarget } from './sql-target.mjs';
import { readProtectedJson, saveProtectedJson } from './sql-endpoint.js';
import { withStateLock } from './state-files.js';
import { toolingAsset } from './runtime-roots.js';
import type { Run } from './process.js';

const requestSchema = z.strictObject({
  version: z.literal(1), target: z.unknown(), location: z.string().regex(/^[a-z][a-z0-9]{1,63}$/),
  administratorObjectId: z.string().uuid(), administratorName: z.string().min(1).max(128),
  clientIp: z.ipv4().refine(value => !['0.0.0.0', '255.255.255.255'].includes(value)),
  createResourceGroup: z.boolean(), cost: z.literal('free-only'),
});
type AzureTarget = Extract<SqlTarget, { provider: 'azure' }>;
type DevelopmentRequest = Omit<z.infer<typeof requestSchema>, 'target'> & { target: AzureTarget };
const stateSchema = z.strictObject({
  version: z.literal(1), home: z.string(), approval: z.string(), administratorPassword: z.string().min(32),
  stage: z.enum(['approved', 'submitted', 'ready']), resourceGroupId: z.string(), deploymentId: z.string(),
});
export interface DevelopmentSqlPlan {
  version: 1; home: string; request: DevelopmentRequest; templateHash: string; approval: string; effects: string[];
}

export async function planDevelopmentSql(home: string, value: unknown): Promise<DevelopmentSqlPlan> {
  const input = requestSchema.parse(value);
  const target = validateSqlTarget(input.target);
  if (target.provider !== 'azure') throw new Error('Database-only provisioning requires an Azure SQL target.');
  const request = { ...input, target };
  const templateHash = createHash('sha256').update(await readFile(toolingAsset('infra', 'development-sql.bicep'))).digest('hex');
  const canonical = realpathSync.native(home);
  const approval = createHash('sha256').update(JSON.stringify({ home: canonical, request, templateHash })).digest('hex').slice(0, 12);
  return { version: 1, home: canonical, request, templateHash, approval, effects: [
    `Subscription ${target.subscriptionId}; tenant ${target.tenantId}; resource group ${target.resourceGroup}; region ${request.location}.`,
    `${request.createResourceGroup ? 'Create the resource group if absent and create' : 'Reuse the existing resource group and create'} only a new SQL server ${target.server} and database ${target.database}. Existing servers without this plan's receipt are never adopted or reconfigured.`,
    `Enable the SQL public endpoint and a firewall rule for exactly ${request.clientIp}; no broad Azure or internet rule.`,
    'Request the current Azure SQL free offer with AutoPause. Free capacity/eligibility is not guaranteed; never convert a refusal into paid provisioning or overage.',
    'Configure the named Entra administrator and SQL authentication, protect the generated bootstrap credential locally, and later create a separate least-privilege app user after schema approval.',
    'No website/app publishing, hosted DAB, registry, telemetry or app registration. Resources persist; cleanup is separately approved.',
  ] };
}

export async function provisionDevelopmentSql(home: string, approved: DevelopmentSqlPlan, run: Run,
  fetcher: typeof fetch = fetch): Promise<{ resourceGroupId: string; deploymentId: string }> {
  const current = await planDevelopmentSql(home, approved.request);
  if (JSON.stringify(current) !== JSON.stringify(approved)) throw new Error('Azure SQL plan is stale or changed; review a new database-only plan.');
  const { target } = current.request;
  const account = z.object({ id: z.string(), tenantId: z.string() }).parse(JSON.parse(await run('az',
    ['account', 'show', '--query', '{id:id,tenantId:tenantId}', '-o', 'json'])));
  if (account.id !== target.subscriptionId || account.tenantId !== target.tenantId) throw new Error('Azure account does not match the reviewed subscription/tenant.');
  const token = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(await run('az',
    ['account', 'get-access-token', '--subscription', target.subscriptionId, '--tenant', target.tenantId,
      '--resource', 'https://management.azure.com/', '-o', 'json'], { sensitiveOutput: true }))).accessToken;
  const groupId = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
  const serverId = `${groupId}/providers/Microsoft.Sql/servers/${target.server.split('.')[0]}`;
  const deploymentId = `${groupId}/providers/Microsoft.Resources/deployments/sql-apps-development-${current.approval}`;
  const path = join(current.home, '.sql-apps', `azure-development-${current.approval}.json`);
  const api = async (id: string, apiVersion: string, method = 'GET', body?: unknown) => {
    const response = await fetcher(`https://management.azure.com${id}?api-version=${apiVersion}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000), redirect: 'error',
    });
    const value: unknown = await response.json();
    if (!response.ok && !(method === 'GET' && response.status === 404)) {
      const error = z.object({ error: z.object({ code: z.string().regex(/^[A-Za-z0-9_.-]+$/) }) }).safeParse(value);
      throw new Error(`Azure SQL request failed (HTTP ${response.status}${error.success ? ` / ${error.data.error.code}` : ''}); review the deployment. No paid fallback or resource deletion was attempted.`);
    }
    return { status: response.status, value };
  };
  return withStateLock(path, async () => {
    let state: z.infer<typeof stateSchema>;
    try { state = stateSchema.parse(await readProtectedJson(path, run)); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      if ((await api(serverId, '2023-08-01')).status !== 404) throw new Error('The SQL server already exists without this plan receipt; select a development database instead of reconfiguring it.');
      state = { version: 1, home: current.home, approval: current.approval,
        administratorPassword: `SqlApps1!${randomBytes(32).toString('hex')}`, stage: 'approved', resourceGroupId: groupId, deploymentId };
      await saveProtectedJson(path, state, run);
    }
    if (state.home !== current.home || state.approval !== current.approval ||
        state.resourceGroupId !== groupId || state.deploymentId !== deploymentId) throw new Error('Azure SQL receipt belongs to another target; nothing was reset.');
    const group = await api(groupId, '2024-03-01');
    if (group.status === 404) {
      if (!current.request.createResourceGroup) throw new Error('The reviewed resource group does not exist; creating one needs a new explicit plan.');
      await api(groupId, '2024-03-01', 'PUT', { location: current.request.location, tags: { project: 'sql-apps' } });
    }
    const observed = await api(deploymentId, '2022-09-01');
    if (observed.status === 404) {
      if (state.stage !== 'approved') throw new Error('Recorded deployment disappeared; inspect resources before creating another deployment.');
      if ((await api(serverId, '2023-08-01')).status !== 404) throw new Error('A SQL server appeared before this deployment was submitted; no existing server was reconfigured.');
      const template: unknown = JSON.parse(await run('az', ['bicep', 'build', '--file', toolingAsset('infra', 'development-sql.bicep'), '--stdout']));
      const values = {
        serverName: target.server.split('.')[0], databaseName: target.database, location: current.request.location,
        tenantId: target.tenantId, administratorObjectId: current.request.administratorObjectId,
        administratorName: current.request.administratorName, clientIp: current.request.clientIp,
        administratorPassword: state.administratorPassword,
      };
      await api(deploymentId, '2022-09-01', 'PUT', { properties: { mode: 'Incremental', template,
        parameters: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) } });
      state = { ...state, stage: 'submitted' };
      await saveProtectedJson(path, state, run);
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await api(deploymentId, '2022-09-01');
      const deployment = z.object({ properties: z.object({ provisioningState: z.string() }) }).parse(response.value);
      if (deployment.properties.provisioningState === 'Succeeded') {
        const database = z.object({ properties: z.object({ useFreeLimit: z.literal(true), freeLimitExhaustionBehavior: z.literal('AutoPause') }) })
          .parse((await api(`${serverId}/databases/${target.database}`, '2023-08-01')).value);
        if (!database.properties.useFreeLimit) throw new Error('Free-only database guard did not verify.');
        await saveProtectedJson(path, { ...state, stage: 'ready' }, run);
        return { resourceGroupId: groupId, deploymentId };
      }
      if (['Failed', 'Canceled'].includes(deployment.properties.provisioningState)) throw new Error('Azure SQL deployment did not succeed. Inspect its errors and free-offer/policy availability; resources are preserved and no paid retry was made.');
      await new Promise(done => setTimeout(done, 2000));
    }
    throw new Error('Azure SQL deployment is still pending; resources and receipt were preserved. Resume this exact reviewed plan after inspecting the deployment.');
  });
}
