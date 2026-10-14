import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import sql from 'mssql';
import type { Run } from './process.js';
import {
  personalFreeConfigSchema,
  protectedDeploymentStateSchema,
  type PersonalFreeConfig,
  type ProtectedDeploymentState,
} from './personal-free-config.js';
import { deploymentName } from './deployment-name.js';
import { buildPersonalFreeArtifact } from './personal-free-build.js';
import { toolingAsset, projectRoot } from './runtime-roots.js';

export interface PersonalFreeInitOptions {
  name: string;
  location: string;
  resourceGroup: string;
  environment?: 'dev' | 'test' | 'prod';
}

export async function initPersonalFreeConfig(
  options: PersonalFreeInitOptions,
  run: Run,
): Promise<PersonalFreeConfig> {
  const account = z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    user: z.object({ name: z.string().min(1), type: z.literal('user') }),
  }).parse(JSON.parse(await run('az', ['account', 'show', '-o', 'json'])));
  const operator = (await run('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv'])).trim();
  return personalFreeConfigSchema.parse({
    profile: 'personal-free',
    subscriptionId: account.id,
    tenantId: account.tenantId,
    sqlAdministratorObjectId: operator,
    sqlAdministratorName: account.user.name,
    resourceGroup: options.resourceGroup,
    location: options.location,
    environment: options.environment ?? 'dev',
    name: deploymentName(options.name),
  });
}

export interface PersonalFreePlan {
  approval: string;
  summary: string;
}

export function planPersonalFreeDeployment(config: PersonalFreeConfig, sourceHash: string): PersonalFreePlan {
  const approval = createHash('sha256').update(JSON.stringify({ config, sourceHash })).digest('hex').slice(0, 12);
  return {
    approval,
    summary: [
      'Target: personal-free (Azure Static Web Apps Free; no SLA).',
      'Cost: potentially $0 only while Static Web Apps and Azure SQL remain inside current free allowances.',
      'Network: Azure SQL uses a public endpoint. The 0.0.0.0 firewall rule admits all resources inside the Azure boundary, including other subscriptions.',
      'Authentication: an explicitly invited owner role; generated least-privilege SQL credentials are stored outside source.',
      'Not created: DAB, Container Apps, ACR, VNet, private endpoint, private DNS, Log Analytics, Application Insights, or Key Vault.',
    ].join('\n'),
  };
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

export function createProtectedDeploymentState(approval: string): ProtectedDeploymentState {
  return protectedDeploymentStateSchema.parse({
    approval,
    stage: 'new',
    sqlAdministratorPassword: secret(),
    runtimePassword: secret(),
  });
}

export async function saveProtectedDeploymentState(path: string, state: ProtectedDeploymentState): Promise<void> {
  const validated = protectedDeploymentStateSchema.parse(state);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export function approveProtectedDeploymentRevision(
  state: ProtectedDeploymentState,
  approval: string,
): ProtectedDeploymentState {
  return protectedDeploymentStateSchema.parse({
    ...state,
    approval,
    ...(state.approval === approval ? {} : { stage: 'new' }),
  });
}

export function personalFreeStatePath(config: PersonalFreeConfig): string {
    return join(projectRoot, '.sql-apps', 'deployments', `${config.name}-${config.environment}.json`);
  }

  export async function readPersonalFreeConfig(path: string): Promise<PersonalFreeConfig> {
    return personalFreeConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }

  const outputsSchema = z.object({
    staticWebAppName: z.string().min(1),
    staticWebAppHostname: z.string().min(1),
    sqlServer: z.string().regex(/\.database\.windows\.net$/),
    databaseName: z.literal('app'),
  });

  async function secureParametersFile(
    config: PersonalFreeConfig,
    state: ProtectedDeploymentState,
  ): Promise<string> {
    const path = `${personalFreeStatePath(config)}.parameters.${randomBytes(8).toString('hex')}.json`;
    const parameters = {
      parameters: {
        name: { value: config.name },
        environment: { value: config.environment },
        location: { value: config.location },
        tenantId: { value: config.tenantId },
        sqlAdministratorObjectId: { value: config.sqlAdministratorObjectId },
        sqlAdministratorName: { value: config.sqlAdministratorName },
        sqlAdministratorPassword: { value: state.sqlAdministratorPassword },
        runtimePassword: { value: state.runtimePassword },
      },
    };
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parameters, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }

  function parseOutputs(text: string) {
    const envelope = z.record(z.string(), z.object({ value: z.unknown() })).parse(JSON.parse(text));
    return outputsSchema.parse(Object.fromEntries(Object.entries(envelope).map(([name, item]) => [name, item.value])));
  }

  async function requireProviders(config: PersonalFreeConfig, run: Run): Promise<void> {
    for (const namespace of ['Microsoft.Web', 'Microsoft.Sql']) {
      const state = (await run('az', ['provider', 'show', '--subscription', config.subscriptionId,
        '--namespace', namespace, '--query', 'registrationState', '-o', 'tsv'])).trim();
      if (state !== 'Registered') {
        throw new Error(`${namespace} is not registered in subscription ${config.subscriptionId}; register it explicitly before deployment`);
      }
    }
  }

  async function applyInfrastructure(
    config: PersonalFreeConfig,
    state: ProtectedDeploymentState,
    run: Run,
  ) {
    const parameters = await secureParametersFile(config, state);
    try {
      return parseOutputs(await run('az', [
        'deployment', 'group', 'create', '--subscription', config.subscriptionId,
        '--resource-group', config.resourceGroup,
        '--name', `${config.name}-${config.environment}-personal-free`,
        '--template-file', toolingAsset('infra', 'personal-free.bicep'),
        '--parameters', `@${parameters}`, '--query', 'properties.outputs', '-o', 'json',
      ], { redact: [state.sqlAdministratorPassword, state.runtimePassword] }));
    } finally {
      await rm(parameters, { force: true });
    }
  }

  async function publishPersonalSchema(config: PersonalFreeConfig, server: string, run: Run): Promise<void> {
    const project = resolve(projectRoot, 'sql', 'personal-free.sqlproj');
    const output = resolve(projectRoot, 'dist', 'sql-personal-free');
    await run('dotnet', ['build', project, '--output', output]);
    await run('dotnet', ['tool', 'run', 'sqlpackage', '--',
      '/Action:Publish',
      `/SourceFile:${join(output, 'personal-free.dacpac')}`,
      `/TargetConnectionString:Server=tcp:${server},1433;Database=app;Encrypt=True;TrustServerCertificate=False;Authentication=Active Directory Default;`,
      '/p:BlockOnPossibleDataLoss=True',
      '/p:DropObjectsNotInSource=False',
    ], { env: { AZURE_TOKEN_CREDENTIALS: 'AzureCliCredential', AZURE_TENANT_ID: config.tenantId } });
  }

  async function configureRuntimeUser(
    config: PersonalFreeConfig,
    state: ProtectedDeploymentState,
    server: string,
    run: Run,
  ): Promise<void> {
    const token = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(await run('az', [
      'account', 'get-access-token', '--subscription', config.subscriptionId,
      '--resource', 'https://database.windows.net/', '-o', 'json',
    ]))).accessToken;
    const pool = await new sql.ConnectionPool({
      server,
      database: 'app',
      options: { encrypt: true, trustServerCertificate: false },
      authentication: { type: 'azure-active-directory-access-token', options: { token } },
      pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
    }).connect();
    try {
      const password = state.runtimePassword.replaceAll("'", "''");
      await pool.request().query(`
  IF USER_ID(N'sql_apps_runtime') IS NULL
    EXEC(N'CREATE USER [sql_apps_runtime] WITH PASSWORD = ''${password}''');
  ELSE
    EXEC(N'ALTER USER [sql_apps_runtime] WITH PASSWORD = ''${password}''');
  GRANT CONNECT TO [sql_apps_runtime];`);
      const api = z.object({ routes: z.array(z.object({
        procedure: z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/) }),
      })) }).parse(JSON.parse(await readFile(join(projectRoot, 'personal-free-api.json'), 'utf8')));
      for (const name of new Set(api.routes.map(route => route.procedure.name))) {
        await pool.request().query(
          `GRANT EXECUTE ON OBJECT::[dbo].[${name}] TO [sql_apps_runtime];\n` +
          `GRANT VIEW DEFINITION ON OBJECT::[dbo].[${name}] TO [sql_apps_runtime];`);
      }
    } finally {
      await pool.close();
    }
  }

  export async function deployPersonalFree(
    config: PersonalFreeConfig,
    approval: string,
    run: Run,
  ): Promise<ProtectedDeploymentState> {
    const artifact = join(projectRoot, '.sql-apps', 'deployments', `${config.name}-${config.environment}-artifact`);
    const manifest = await buildPersonalFreeArtifact(projectRoot, artifact);
    const plan = planPersonalFreeDeployment(config, manifest.sourceHash);
    if (approval !== plan.approval) throw new Error('Deployment approval is stale; run plan again and review the current target');
    const statePath = personalFreeStatePath(config);
    let state: ProtectedDeploymentState;
    try {
      state = protectedDeploymentStateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
      const revised = approveProtectedDeploymentRevision(state, approval);
      if (revised.approval !== state.approval) await saveProtectedDeploymentState(statePath, revised);
      state = revised;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      state = createProtectedDeploymentState(approval);
      await saveProtectedDeploymentState(statePath, state);
    }
    await requireProviders(config, run);
    await run('az', ['group', 'create', '--subscription', config.subscriptionId,
      '--name', config.resourceGroup, '--location', config.location, '-o', 'none']);
    {
      const outputs = await applyInfrastructure(config, state, run);
      state = {
        ...state,
        stage: 'infrastructure',
        staticWebAppName: outputs.staticWebAppName,
        staticWebAppHostname: outputs.staticWebAppHostname,
        sqlServer: outputs.sqlServer,
      };
      await saveProtectedDeploymentState(statePath, state);
      await publishPersonalSchema(config, outputs.sqlServer, run);
      state = { ...state, stage: 'schema' };
      await saveProtectedDeploymentState(statePath, state);
      await configureRuntimeUser(config, state, outputs.sqlServer, run);
      state = { ...state, stage: 'runtime-user' };
      await saveProtectedDeploymentState(statePath, state);
      const deploymentToken = (await run('az', ['staticwebapp', 'secrets', 'list',
        '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
        '--name', outputs.staticWebAppName, '--query', 'properties.apiKey', '-o', 'tsv'],
      { sensitiveOutput: true })).trim();
      if (!deploymentToken) throw new Error('Static Web Apps deployment token was not returned');
      await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
        'swa', 'deploy', join(artifact, 'static'), '--api-location', join(artifact, 'api'), '--env', 'production',
      ], { env: { SWA_CLI_DEPLOYMENT_TOKEN: deploymentToken }, sensitiveOutput: true });
      state = { ...state, stage: 'application' };
      await saveProtectedDeploymentState(statePath, state);
      const response = await fetch(`https://${outputs.staticWebAppHostname}/api/health/ready`);
      if (!response.ok) throw new Error(`Personal-free readiness failed with HTTP ${response.status}`);
      state = { ...state, stage: 'ready' };
      await saveProtectedDeploymentState(statePath, state);
      return state;
    }
}

export async function rotatePersonalFreeRuntimeSecret(
    config: PersonalFreeConfig,
    approval: string,
    run: Run,
): Promise<ProtectedDeploymentState> {
    const statePath = personalFreeStatePath(config);
    let state = protectedDeploymentStateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
    if (state.approval !== approval) throw new Error('Rotation approval does not match this deployment');
    if (!state.sqlServer || !state.staticWebAppName) throw new Error('Deploy the application before rotating its runtime secret');
    const server = state.sqlServer;
    state = protectedDeploymentStateSchema.parse({
      ...state,
      runtimePassword: secret(),
      stage: 'schema',
    });
    await configureRuntimeUser(config, state, server, run);
    state = { ...state, stage: 'runtime-user' };
    await saveProtectedDeploymentState(statePath, state);
    await applyInfrastructure(config, state, run);
    state = { ...state, stage: 'ready' };
    await saveProtectedDeploymentState(statePath, state);
    return state;
}
