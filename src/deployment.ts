import { link, mkdir, open, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deploymentSchema, environmentKey, type DeploymentConfig } from './config.js';
import { authRedirectPath } from './browser-config.js';
import { type Run } from './process.js';
import { imageDigest, imageFields } from './artifacts.js';
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
  networkId: z.string(),
  sqlBackupRetentionDays: z.number().int().min(1).max(35),
  sqlBackupRedundancy: z.enum(['Local', 'Zone', 'Geo', 'GeoZone']),
  sqlAuditWorkspaceName: z.string().min(1),
});
export type DeploymentOutputs = z.infer<typeof outputSchema>;
export const delegatedScopeId = '6bb296dd-f397-4dcc-a69b-d37dfce3c555';
export const applicationRoleId = '530d74b7-cf30-41f4-a44c-9f594cba7c63';
export const deploymentTemplatePath = () => toolingAsset('infra', 'main.bicep');
export const rbacTemplatePath = () => toolingAsset('infra', 'rbac.bicep');
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
  if (state.applicationHome !== await realpath(deploymentProjectRoot())) {
    throw new Error('Deployment state belongs to a different application checkout; discovery or copied state is not reuse approval');
  }
  return state;
}

export async function deploymentConfigHash(config: DeploymentConfig): Promise<string> {
  const home = await realpath(deploymentProjectRoot());
  return createHash('sha256').update(JSON.stringify(deploymentSchema.parse(config))).update(home)
    .update(await roleBasedSchemaFingerprint(home)).digest('hex');
}

export function armParameters(config: DeploymentConfig, deployGateway: boolean) {
  const { subscriptionId: _subscription, resourceGroup: _group, profile: _profile, functionsImage: _legacy,
    imageSource: _source, ...parameters } = config;
  return { parameters: Object.fromEntries(Object.entries({ ...parameters, deployGateway })
    .map(([key, value]) => [key, { value }])) };
}

export function rbacParameters(config: DeploymentConfig, outputs: DeploymentOutputs) {
  return { parameters: {
    name: { value: config.name },
    environment: { value: config.environment },
    registryServer: { value: config.registryServer },
    gatewayPrincipalId: { value: outputs.gatewayPrincipalId },
    dabPrincipalId: { value: outputs.dabPrincipalId },
  } };
}

const acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d';

export interface ExpectedRbacAssignment {
  label: string;
  principalId: string;
  roleDefinitionId: string;
  scope: string;
}

export function expectedRbacAssignments(
  config: DeploymentConfig, outputs: DeploymentOutputs,
): ExpectedRbacAssignment[] {
  const root = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers`;
  const role = (id: string) => `/subscriptions/${config.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${id}`;
  const registry = `${root}/Microsoft.ContainerRegistry/registries/${config.registryServer.split('.')[0]}`;
  return [
    { label: 'ACR pull for gateway', principalId: outputs.gatewayPrincipalId,
      roleDefinitionId: role(acrPullRoleId), scope: registry },
    { label: 'ACR pull for data', principalId: outputs.dabPrincipalId,
      roleDefinitionId: role(acrPullRoleId), scope: registry },
  ];
}

export async function verifyRbacAssignments(
  config: DeploymentConfig, outputs: DeploymentOutputs, run: Run,
): Promise<void> {
  const expected = expectedRbacAssignments(config, outputs);
  const actual = new Map<string, z.infer<typeof liveAssignmentSchema>[]>();
  for (const scope of new Set(expected.map(item => item.scope))) {
    const rows = z.array(liveAssignmentSchema).parse(JSON.parse(await run('az', [
      'role', 'assignment', 'list', '--subscription', config.subscriptionId,
      '--scope', scope, '--include-inherited', '-o', 'json',
    ])));
    actual.set(scope.toLowerCase(), rows);
  }
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const missing = expected.filter(item => !(actual.get(item.scope.toLowerCase()) ?? []).some(row =>
    same(row.principalId, item.principalId) &&
    same(row.roleDefinitionId, item.roleDefinitionId) &&
    same(row.scope, item.scope)));
  if (missing.length) {
    throw new Error(`RBAC handoff is incomplete:\n${missing.map(item =>
      `- ${item.label}: principal ${item.principalId}, role ${item.roleDefinitionId}, scope ${item.scope}`).join('\n')}\n` +
      'An authorized administrator must run: npm run azure -- rbac-deploy <config.json>');
  }
}

const liveAssignmentSchema = z.object({
  principalId: z.string().uuid(),
  roleDefinitionId: z.string().min(1),
  scope: z.string().min(1),
}).passthrough();

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
      !identity.appRoles.some(role => role.value === config.requiredRole && role.isEnabled && role.allowedMemberTypes?.includes('User'))) {
    throw new Error('App registration must expose access_as_user and the enabled human application role');
  }
  await run('az', ['acr', 'show', '--name', config.registryServer.split('.')[0]!, '--resource-group', config.resourceGroup, '--subscription', config.subscriptionId, '-o', 'none']);
  if (checkImages) {
    for (const field of imageFields) await imageDigest(config[field], config, run);
  }
  validateRoleBasedCloudDab(JSON.parse(await readFile(deploymentProjectPath('dab', 'dab-config.json'), 'utf8')), config);
  for (const namespace of ['Microsoft.App', 'Microsoft.Sql', 'Microsoft.Network', 'Microsoft.ManagedIdentity',
    'Microsoft.OperationalInsights', 'Microsoft.Authorization']) {
    const status = (await run('az', ['provider', 'show', '--namespace', namespace, '--subscription', config.subscriptionId, '--query', 'registrationState', '-o', 'tsv'])).trim();
    if (status !== 'Registered') throw new Error(`Register resource provider ${namespace} before deploying`);
  }
}

export async function readSavedState(config: DeploymentConfig): Promise<DeploymentState | undefined> {
  try { return await readState(config); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function provision(config: DeploymentConfig, run: Run): Promise<DeploymentState> {
  const configHash = await deploymentConfigHash(config);
  await preflight(config, run);
  const previous = await readSavedState(config);
  if (previous?.configHash === configHash) return previous;
  // A changed configuration or SQL/DAB source re-applies the idempotent infrastructure stage; deploy then rolls it out.
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
    applicationHome: await realpath(deploymentProjectRoot()),
  };
}

export async function parametersFile(config: DeploymentConfig, enabled: boolean): Promise<string> {
  const path = `${statePath(config)}.parameters.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(armParameters(config, enabled), null, 2));
  return path;
}

export async function rbacParametersFile(config: DeploymentConfig, outputs: DeploymentOutputs): Promise<string> {
  const path = `${statePath(config)}.rbac.parameters.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(rbacParameters(config, outputs), null, 2));
  return path;
}

export const grantsHandoffPath = () => deploymentProjectPath('dist', 'sql', 'role-based-grants.sql');

/** Writes the exact DAB procedure grants SQL Apps applies, so a maintained deployment route can apply the same set. */
export async function writeGrantsHandoff(config: DeploymentConfig): Promise<string> {
  const grants = roleBasedProcedureGrants(
    JSON.parse(await readFile(deploymentProjectPath('dab', 'dab-config.json'), 'utf8')), config, 'sql_apps_dab');
  await mkdir(dirname(grantsHandoffPath()), { recursive: true });
  await writeFile(grantsHandoffPath(), '-- Generated by SQL Apps from dab/dab-config.json; do not edit.\n' +
    '-- Requires the database user [sql_apps_dab] for the DAB managed identity (see sql/grant-runtime.sql).\n' +
    `${grants}\n`);
  return grants;
}

export async function publishSchema(config: DeploymentConfig, outputs: DeploymentOutputs, run: Run) {
  const grants = await writeGrantsHandoff(config);
  await run('dotnet', ['build', deploymentProjectPath('sql', 'database.sqlproj'), '--output', deploymentProjectPath('dist', 'sql')]);
  // SqlPackage signs in through the Azure CLI itself, so no bearer token appears in the process list.
  await run('dotnet', ['tool', 'run', 'sqlpackage', '--',
    '/Action:Publish', `/SourceFile:${deploymentProjectPath('dist', 'sql', 'database.dacpac')}`,
    `/TargetConnectionString:Server=tcp:${outputs.sqlServer},1433;Database=app;Encrypt=True;TrustServerCertificate=False;` +
      'Authentication=Active Directory Default;',
    `/v:DabPrincipalId=${outputs.dabPrincipalId}`,
    `/v:RoleBasedProcedureGrants=${grants}`,
    '/p:BlockOnPossibleDataLoss=True', '/p:DropObjectsNotInSource=False',
  ], { env: { AZURE_TOKEN_CREDENTIALS: 'AzureCliCredential', AZURE_TENANT_ID: config.tenantId } });
}

export async function deploy(
  config: DeploymentConfig, run: Run, fetcher: typeof fetch = fetch,
  persist: (state: DeploymentState) => Promise<void> = state => saveState(statePath(config), state),
): Promise<DeploymentState> {
  await preflight(config, run);
  const configHash = await deploymentConfigHash(config);
  if (config.imageSource !== await roleBasedSchemaFingerprint(await realpath(deploymentProjectRoot()))) {
    throw new Error('Images were built from different SQL/DAB source (DAB bakes dab-config.json into its image); run artifacts, then deploy');
  }
  const deployResources = async (enabled: boolean) => parseOutputs(await run('az', [
    'deployment', 'group', 'create', '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
    '--name', `${config.name}-${config.environment}-${enabled ? 'runtime' : 'infrastructure'}`,
    '--template-file', deploymentTemplatePath(), '--parameters', `@${await parametersFile(config, enabled)}`,
    '--query', 'properties.outputs', '-o', 'json',
  ]));
  const saved = await readSavedState(config);
  // Same configuration and source: resume from the saved stage. Anything changed: roll every stage forward again.
  const previous = saved?.configHash === configHash ? saved : undefined;
  let state: DeploymentState = previous ?? { environmentKey: environmentKey(config), configHash, stage: 'infrastructure',
    outputs: await deployResources(false), applicationHome: await realpath(deploymentProjectRoot()) };
  await persist(state);
  await verifyRbacAssignments(config, state.outputs, run);
  if (!previous || previous.stage === 'infrastructure') await publishSchema(config, state.outputs, run);
  if (!previous || ['infrastructure', 'schema'].includes(previous.stage)) {
    state = { ...state, stage: 'schema' };
    await persist(state);
    state = { ...state, stage: 'runtime', outputs: await deployResources(true) };
    await persist(state);
  }
  await configureRedirect(config, state.outputs.gatewayUrl, run);
  return await waitForReadiness(config, state, fetcher, persist);
}

export async function waitForReadiness(
  config: DeploymentConfig, state: DeploymentState, fetcher: typeof fetch,
  persist: (state: DeploymentState) => Promise<void>,
): Promise<DeploymentState> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetcher(new URL('/health/ready', state.outputs.gatewayUrl),
        { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      await requireReadyResponse(response);
      const ready = { ...state, stage: 'ready' as const };
      await persist(ready);
      return ready;
    } catch (error) {
      console.error(`Role-based-data readiness attempt ${attempt + 1} failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
    }
    if (attempt < 29) await new Promise(done => setTimeout(done, 10_000));
  }
  throw new Error(`Role-based-data runtime deployed but not ready for ${environmentKey(config)}; state retained, authenticated procedure acceptance still required`);
}

export async function requireReadyResponse(response: Response): Promise<void> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (response.status !== 200 || mediaType !== 'application/json') {
    throw new Error(`Invalid readiness response: expected HTTP 200 application/json, received ${response.status}`);
  }
  try {
    z.strictObject({ status: z.literal('ready') }).parse(await response.json());
  } catch (error) {
    throw new Error('Invalid readiness response: expected exactly {"status":"ready"}', { cause: error });
  }
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
