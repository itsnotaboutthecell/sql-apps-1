import { link, mkdir, open, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deploymentSchema, environmentKey, type DeploymentConfig } from './config.js';
import { authRedirectPath } from './browser-config.js';
import { type Run } from './process.js';
import { imageDigest, deploymentImageFields } from './artifacts.js';
import { validateRoleBasedCloudDab, roleBasedProcedureGrants, roleBasedSchemaFingerprint } from './role-based-profile.js';
import { withFileLock } from './file-lock.mjs';
import { toolingAsset } from './runtime-roots.js';

const outputSchema = z.object({
  sqlServer: z.string().regex(/^[a-z0-9-]+\.database\.windows\.net$/),
  databaseName: z.literal('app'),
  dabPrincipalId: z.string().uuid(),
  gatewayPrincipalId: z.string().uuid(),
  gatewayName: z.string(),
  gatewayUrl: z.string(),
  functionsName: z.string(),
  networkId: z.string(),
  storageAccount: z.string(),
  vaultName: z.string(),
});
export type DeploymentOutputs = z.infer<typeof outputSchema>;
export const functionRoleId = '15d91b1c-83c7-4cb6-b349-d7b8fd4b1425';
export const delegatedScopeId = '6bb296dd-f397-4dcc-a69b-d37dfce3c555';
export const applicationRoleId = '530d74b7-cf30-41f4-a44c-9f594cba7c63';
export const deploymentTemplatePath = () => toolingAsset('infra', 'main.bicep');
const deploymentProjectRoot = () => process.env.SQL_APPS_PROJECT_HOME ?? process.cwd();
const deploymentProjectPath = (...parts: string[]) => resolve(deploymentProjectRoot(), ...parts);

export interface DeploymentState {
  environmentKey: string;
  configHash: string;
  stage: 'infrastructure' | 'schema' | 'runtime' | 'ready';
  outputs: DeploymentOutputs;
  applicationHome?: string | undefined;
}

export const deploymentStateSchema = z.strictObject({
  environmentKey: z.string(),
  configHash: z.string(),
  stage: z.enum(['infrastructure', 'schema', 'runtime', 'ready']),
  outputs: outputSchema,
  applicationHome: z.string().optional(),
});

export async function readState(config: DeploymentConfig): Promise<DeploymentState> {
  const state = deploymentStateSchema.parse(JSON.parse(await readFile(statePath(config), 'utf8')));
  if (state.environmentKey !== environmentKey(config)) throw new Error('Deployment state belongs to a different environment');
  if (config.profile === 'role-based-data' && state.applicationHome !== await realpath(deploymentProjectRoot())) {
    throw new Error('Role-based deployment state belongs to a different application checkout; discovery or copied state is not reuse approval');
  }
  return state;
}

export async function deploymentConfigHash(config: DeploymentConfig): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(config));
  if (config.profile === 'role-based-data') {
    const home = await realpath(deploymentProjectRoot());
    hash.update(home).update(await roleBasedSchemaFingerprint(home));
  }
  return hash.digest('hex');
}

export function armParameters(config: DeploymentConfig, deployGateway: boolean) {
  const { subscriptionId: _subscription, resourceGroup: _group, readinessPath: _readiness, ...parameters } = config;
  return { parameters: Object.fromEntries(Object.entries({ ...parameters,
    ...(config.profile === 'role-based-data' ? { readinessPath: config.readinessPath } : {}), deployGateway })
    .filter(([, value]) => value !== undefined).map(([key, value]) => [key, { value }])) };
}

export function parseOutputs(text: string): DeploymentOutputs {
  const envelope = z.record(z.string(), z.object({ value: z.unknown() })).parse(JSON.parse(text));
  return outputSchema.parse(Object.fromEntries(Object.entries(envelope).map(([key, result]) => [key, result.value])));
}

export function statePath(config: DeploymentConfig): string {
  return deploymentProjectPath('.sql-apps', `${createHash('sha256').update(environmentKey(config)).digest('hex').slice(0, 20)}.json`);
}

export async function saveState(path: string, state: DeploymentState): Promise<void> {
  await saveJson(path, state);
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeJson(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export async function createJsonFile(
  path: string,
  value: unknown,
  temporaryPath: (destination: string) => string = destination => `${destination}.${randomUUID()}.tmp`,
): Promise<void> {
  const content = serializeJson(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  let ownsTemporary = false;
  let publicationError: unknown;
  try {
    temporaryFile = await open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    await temporaryFile.writeFile(content);
    await temporaryFile.sync();
  } catch (error) {
    publicationError = error;
  }
  let closeError: unknown;
  if (temporaryFile !== undefined) {
    try {
      await temporaryFile.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (publicationError === undefined && closeError === undefined) {
    try {
      await link(temporary, path);
    } catch (error) {
      publicationError = error;
    }
  }
  let cleanupError: unknown;
  if (ownsTemporary) {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
    }
  }
  const errors = [publicationError, closeError, cleanupError].filter(error => error !== undefined);
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Failed to publish ${path}, close its temporary file, or remove the temporary entry`,
    );
  }
  if (errors.length === 1) throw errors[0];
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function withDeploymentLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(`${path}.lock`, action);
}

export async function readConfig(path: string): Promise<DeploymentConfig> {
  return deploymentSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function preflight(config: DeploymentConfig, run: Run, checkImages = true): Promise<void> {
  const currentTenant = z.object({ tenantId: z.string() }).parse(JSON.parse(await run('az', ['account', 'show', '-o', 'json'])));
  if (currentTenant.tenantId !== config.tenantId) throw new Error('Sign Azure CLI into the configured tenant before directory operations');
  const account = z.object({ id: z.string(), tenantId: z.string(), environmentName: z.literal('AzureCloud') })
    .parse(JSON.parse(await run('az', ['account', 'show', '--subscription', config.subscriptionId, '-o', 'json'])));
  if (account.id !== config.subscriptionId || account.tenantId !== config.tenantId) {
    throw new Error('Selected subscription must belong to the configured tenant');
  }
  await run('az', ['bicep', 'version']);
  await run('az', ['containerapp', '--help']);
  await run('dotnet', ['tool', 'run', 'sqlpackage', '--', '/Version']);
  const identity = z.object({
    signInAudience: z.literal('AzureADMyOrg'),
    api: z.object({
      requestedAccessTokenVersion: z.literal(2),
      oauth2PermissionScopes: z.array(z.object({ value: z.string(), isEnabled: z.boolean() })),
    }),
    appRoles: z.array(z.object({ id: z.string(), value: z.string(), isEnabled: z.boolean(),
      allowedMemberTypes: z.array(z.string()).optional() })),
  }).parse(JSON.parse(await run('az', ['ad', 'app', 'show', '--id', config.apiClientId, '-o', 'json'])));
  if (!identity.api.oauth2PermissionScopes.some(scope => scope.value === 'access_as_user' && scope.isEnabled) ||
      !identity.appRoles.some(role => config.profile === 'role-based-data' ?
        role.value === config.requiredRole && role.isEnabled && role.allowedMemberTypes?.includes('User') :
        role.id === functionRoleId && role.value === 'Function.Invoke' && role.isEnabled)) {
    throw new Error(config.profile === 'role-based-data' ?
      'App registration must expose access_as_user and the enabled human application role' :
      'App registration must expose access_as_user and the documented Function.Invoke role');
  }
  await run('az', ['acr', 'show', '--name', config.registryServer.split('.')[0]!, '--resource-group', config.resourceGroup, '--subscription', config.subscriptionId, '-o', 'none']);
  if (checkImages) {
    for (const field of deploymentImageFields(config)) await imageDigest(config[field], config, run);
  }
  if (config.profile === 'role-based-data') validateRoleBasedCloudDab(JSON.parse(await readFile(deploymentProjectPath('dab', 'dab-config.json'), 'utf8')), {
    profile: 'role-based-data', requiredRole: config.requiredRole!, readinessPath: config.readinessPath!,
  });
  const providers = ['Microsoft.App', 'Microsoft.Sql', 'Microsoft.Network', 'Microsoft.ManagedIdentity',
    'Microsoft.OperationalInsights', 'Microsoft.Authorization'];
  if (config.profile !== 'role-based-data') providers.push('Microsoft.Storage', 'Microsoft.Web', 'Microsoft.KeyVault', 'Microsoft.Insights');
  for (const namespace of providers) {
    const status = (await run('az', ['provider', 'show', '--namespace', namespace, '--subscription', config.subscriptionId, '--query', 'registrationState', '-o', 'tsv'])).trim();
    if (status !== 'Registered') throw new Error(`Register resource provider ${namespace} before deploying`);
  }
}

export async function provision(config: DeploymentConfig, run: Run): Promise<DeploymentState> {
  const configHash = await deploymentConfigHash(config);
  await preflight(config, run);
  if (config.profile === 'role-based-data') {
    let previous: DeploymentState | undefined;
    try { previous = await readState(config); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (previous) {
      if (previous.configHash !== configHash) {
        throw new Error('Role-based configuration or SQL/DAB source changed; provisioning cannot overwrite the saved deployment subject');
      }
      return previous;
    }
  }
  const outputs = parseOutputs(await run('az', [
    'deployment', 'group', 'create', '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
    '--name', `${config.name}-${config.environment}-infrastructure`, '--template-file', deploymentTemplatePath(),
    '--parameters', `@${await parametersFile(config, false)}`, '--query', 'properties.outputs', '-o', 'json',
  ]));
  return {
    environmentKey: environmentKey(config),
    configHash,
    stage: 'infrastructure',
    outputs,
    ...(config.profile === 'role-based-data' ? { applicationHome: await realpath('.') } : {}),
  };
}

export async function parametersFile(config: DeploymentConfig, enabled: boolean): Promise<string> {
  const path = `${statePath(config)}.parameters.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(armParameters(config, enabled), null, 2));
  return path;
}

export async function publishSchema(config: DeploymentConfig, outputs: DeploymentOutputs, run: Run) {
  const roleBasedGrants = config.profile === 'role-based-data' ? roleBasedProcedureGrants(
    JSON.parse(await readFile(deploymentProjectPath('dab', 'dab-config.json'), 'utf8')),
    { profile: 'role-based-data', requiredRole: config.requiredRole!, readinessPath: config.readinessPath! }, 'sql_apps_dab',
  ) : '';
  await run('dotnet', ['build', deploymentProjectPath('sql', 'database.sqlproj'), '--output', deploymentProjectPath('dist', 'sql')]);
  const { accessToken } = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(await run('az', [
    'account', 'get-access-token', '--subscription', config.subscriptionId, '--resource', 'https://database.windows.net/', '-o', 'json',
  ])));
  await run('dotnet', ['tool', 'run', 'sqlpackage', '--',
    '/Action:Publish', `/SourceFile:${deploymentProjectPath('dist', 'sql', 'database.dacpac')}`,
    `/TargetConnectionString:Server=tcp:${outputs.sqlServer},1433;Database=app;Encrypt=True;TrustServerCertificate=False;`,
    `/AccessToken:${accessToken}`,
    `/v:DabPrincipalId=${outputs.dabPrincipalId}`,
    ...(config.profile === 'role-based-data' ? [`/v:RoleBasedProcedureGrants=${roleBasedGrants}`] : []),
    '/p:BlockOnPossibleDataLoss=True', '/p:DropObjectsNotInSource=False',
  ]);
}

export async function deploy(
  config: DeploymentConfig, run: Run, fetcher: typeof fetch = fetch,
  persist: (state: DeploymentState) => Promise<void> = state => saveState(statePath(config), state),
): Promise<DeploymentState> {
  await preflight(config, run);
  const configHash = await deploymentConfigHash(config);
  const deployResources = async (enabled: boolean) => parseOutputs(await run('az', [
    'deployment', 'group', 'create', '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
    '--name', `${config.name}-${config.environment}-${enabled ? 'runtime' : 'infrastructure'}`,
    '--template-file', deploymentTemplatePath(), '--parameters', `@${await parametersFile(config, enabled)}`,
    '--query', 'properties.outputs', '-o', 'json',
  ]));
  let previous: DeploymentState | undefined;
  if (config.profile === 'role-based-data') {
    try { previous = await readState(config); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (previous && previous.configHash !== configHash) throw new Error('Role-based deployment configuration or SQL/DAB source changed; review the prior deployment before resuming');
  }
  let state: DeploymentState = previous ?? { environmentKey: environmentKey(config), configHash, stage: 'infrastructure',
    outputs: await deployResources(false), ...(config.profile === 'role-based-data' ? { applicationHome: await realpath('.') } : {}) };
  await persist(state);
  if (!previous || previous.stage === 'infrastructure') await publishSchema(config, state.outputs, run);
  if (config.profile === 'role-based-data') {
    if (!previous || ['infrastructure', 'schema'].includes(previous.stage)) {
      state = { ...state, stage: 'schema' };
      await persist(state);
      state = { ...state, stage: 'runtime', outputs: await deployResources(true) };
      await persist(state);
    }
    await configureRedirect(config, state.outputs.gatewayUrl, run);
    return await waitForReadiness(config, state, fetcher, persist);
  }
  state = { ...state, stage: 'schema' };
  await persist(state);
  const apiServicePrincipal = z.string().uuid().parse(
    (await run('az', ['ad', 'sp', 'show', '--id', config.apiClientId, '--query', 'id', '-o', 'tsv'])).trim(),
  );
  const assignmentsUrl = `https://graph.microsoft.com/v1.0/servicePrincipals/${state.outputs.gatewayPrincipalId}/appRoleAssignments`;
  let pageUrl: string | undefined = assignmentsUrl;
  let hasFunctionRole = false;
  const visited = new Set<string>();
  while (pageUrl) {
    if ((pageUrl !== assignmentsUrl && !pageUrl.startsWith(`${assignmentsUrl}?`)) || visited.has(pageUrl)) {
      throw new Error('Invalid or repeated Graph role-assignment continuation URL');
    }
    visited.add(pageUrl);
    const page = z.object({
      value: z.array(z.object({ appRoleId: z.string(), resourceId: z.string() })),
      '@odata.nextLink': z.url().optional(),
    }).parse(JSON.parse(await run('az', ['rest', '--method', 'GET', '--url', pageUrl, '-o', 'json'])));
    if (page.value.some(role => role.appRoleId === functionRoleId && role.resourceId === apiServicePrincipal)) {
      hasFunctionRole = true;
      break;
    }
    pageUrl = page['@odata.nextLink'];
  }
  if (!hasFunctionRole) {
    const path = `${statePath(config)}.role.json`;
    await writeFile(path, JSON.stringify({ principalId: state.outputs.gatewayPrincipalId, resourceId: apiServicePrincipal, appRoleId: functionRoleId }));
    await run('az', ['rest', '--method', 'POST', '--url',
      `https://graph.microsoft.com/v1.0/servicePrincipals/${state.outputs.gatewayPrincipalId}/appRoleAssignments`, '--body', `@${path}`, '-o', 'none']);
  }
  state = { ...state, stage: 'runtime', outputs: await deployResources(true) };
  await persist(state);
  await configureRedirect(config, state.outputs.gatewayUrl, run);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetcher(new URL('/health/ready', state.outputs.gatewayUrl), { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        state = { ...state, stage: 'ready' };
        await persist(state);
        return state;
      }
    } catch (error) {
      console.error(`Readiness attempt ${attempt + 1} failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
    }
    if (attempt < 29) await new Promise(done => setTimeout(done, 10_000));
  }
  throw new Error('Runtime deployed but readiness failed. Deployment state remains at runtime; inspect Container Apps logs.');
}

export async function waitForReadiness(
  config: DeploymentConfig, state: DeploymentState, fetcher: typeof fetch,
  persist: (state: DeploymentState) => Promise<void>,
): Promise<DeploymentState> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetcher(new URL('/health/ready', state.outputs.gatewayUrl),
        { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (response.ok) {
        const ready = { ...state, stage: 'ready' as const };
        await persist(ready);
        return ready;
      }
    } catch (error) {
      console.error(`Role-based-data readiness attempt ${attempt + 1} failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
    }
    if (attempt < 29) await new Promise(done => setTimeout(done, 10_000));
  }
  throw new Error(`Role-based-data runtime deployed but not ready for ${environmentKey(config)}; state retained, authenticated procedure acceptance still required`);
}

export async function configureRedirect(config: DeploymentConfig, origin: string, run: Run) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('HTTPS origin required');
  const registration = z.object({
    id: z.string().uuid(), spa: z.object({ redirectUris: z.array(z.string()) }),
  }).parse(JSON.parse(await run('az', ['ad', 'app', 'show', '--id', config.apiClientId, '-o', 'json'])));
  const redirectUri = new URL(authRedirectPath, origin).href;
  const redirectUris = [...new Set([...registration.spa.redirectUris, redirectUri])];
  const path = `${statePath(config)}.redirect.json`;
  await writeFile(path, JSON.stringify({ spa: { redirectUris } }));
  await run('az', ['rest', '--method', 'PATCH', '--url', `https://graph.microsoft.com/v1.0/applications/${registration.id}`, '--body', `@${path}`, '-o', 'none']);
}
