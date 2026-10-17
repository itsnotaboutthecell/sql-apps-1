import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runtimeFor, portState, type WorkspaceRuntime } from './workspace.mjs';
import { checkSelectedApplication, type ApplicationBuildManifest } from './application-build.js';
import { localAdminQuery, publishLocalSchema, startLocalSql, verifyLocal, sqlImage, dabImage } from './local.js';
import { verifyContainerWorkspace } from './local-ownership.js';
import { saveJson, withStateLock } from './state-files.js';
import { run, type Run } from './process.js';
import type { DemoOptions } from './demo-app.js';
import { readSqlTarget, validateSqlTarget } from './sql-target.mjs';
import { initializeEndpoint, endpointRuntimeQuery, endpointAdminQuery, type EndpointTarget } from './sql-endpoint.js';
import { startHostData, verifyHostData, stopHostData } from './local-data-process.js';

async function selectedEndpoint(runtime: WorkspaceRuntime, name: string): Promise<EndpointTarget | null> {
  const selected = await readSqlTarget(runtime.home, runtime.sqlContainer);
  if (selected.provider === 'container') return null;
  const target = validateSqlTarget({ ...selected, database: `${selected.database}_${name.replaceAll('-', '_')}` });
  if (target.provider === 'container') throw new Error('Selected endpoint provider changed unexpectedly.');
  return target;
}

export function selectedLocalPaths(runtime: WorkspaceRuntime, name: string) {
  if (runtime.mode !== 'isolated' || !runtime.ownsSqlName || runtime.ports.sql === null) throw new Error('Selected application requires an isolated workspace-owned SQL container');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error('Invalid application selection');
  const directory = join(runtime.stateDirectory, 'applications', name, 'local');
  const suffix = name.replaceAll('-', '_');
  return {
    directory, database: `${runtime.database}_${suffix}`, login: `${runtime.login}_${suffix}`,
    stateFile: join(directory, 'sql.json'), configFile: join(directory, 'dab-config.json'),
    dataContainer: `${runtime.names.data}-${name}`, compiled: join(directory, 'sql'), intermediate: join(directory, 'obj'),
  };
}

const credentials = z.strictObject({
  version: z.literal(1), workspace: z.string(), name: z.string(), container: z.string(),
  database: z.string(), login: z.string(), password: z.string().regex(/^SqlApps1![a-f0-9]{64}$/),
});

async function readCredentials(runtime: WorkspaceRuntime, name: string) {
  const target = selectedLocalPaths(runtime, name);
  const state = credentials.parse(JSON.parse(await readFile(target.stateFile, 'utf8')));
  if (state.workspace !== runtime.id || state.name !== name || state.container !== runtime.sqlContainer ||
      state.database !== target.database || state.login !== target.login) {
    throw new Error('Selected SQL credentials belong to another application/workspace; nothing was reset');
  }
  return state;
}

function connection(runtime: WorkspaceRuntime, state: z.infer<typeof credentials>) {
  return `Server=${runtime.sqlContainer},1433;Database=${state.database};User Id=${state.login};Password="${state.password}";Encrypt=True;TrustServerCertificate=True;`;
}

export async function querySelectedLocal(runtime: WorkspaceRuntime, name: string, sql: string, runner: Run, admin = false) {
  const endpoint = await selectedEndpoint(runtime, name);
  if (endpoint) {
    const rows = await (admin ? endpointAdminQuery : endpointRuntimeQuery)(endpoint, sql, runner);
    return rows.map(row => Object.values(row).map(value => value == null ? '' : String(value)).join('|')).join('\n');
  }
  const state = await readCredentials(runtime, name);
  await verifyContainerWorkspace(runtime.sqlContainer, runtime, sqlImage, { '1433/tcp': runtime.ports.sql! }, runner);
  if (admin) return localAdminQuery(runtime.sqlContainer, state.database, sql, runner, [state.password]);
  return runner('docker', ['exec', '-i', '--env', 'SQLCMDPASSWORD', runtime.sqlContainer,
    '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', state.login, '-C', '-b', '-d', state.database, '-h', '-1', '-W', '-s', '|'],
  { input: sql, env: { SQLCMDPASSWORD: state.password }, redact: [state.password] });
}

async function verifyData(runtime: WorkspaceRuntime, name: string, runner: Run) {
  const target = selectedLocalPaths(runtime, name);
  const endpoint = await selectedEndpoint(runtime, name);
  if (endpoint) {
    await verifyHostData(endpoint, JSON.parse(await readFile(target.configFile, 'utf8')));
    return;
  }
  const state = await readCredentials(runtime, name);
  await verifyContainerWorkspace(target.dataContainer, runtime, dabImage, { '5000/tcp': runtime.ports.data }, runner);
  const details = z.object({
    role: z.string(), application: z.string(), environment: z.array(z.string()),
    networks: z.record(z.string(), z.unknown()),
    mounts: z.array(z.object({ Source: z.string(), Destination: z.string(), RW: z.boolean() })),
  }).parse(JSON.parse(await runner('docker', ['inspect', target.dataContainer, '--format',
    '{"role":{{json (index .Config.Labels "sql-apps.local")}},"application":{{json (index .Config.Labels "sql-apps.application")}},"environment":{{json .Config.Env}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}}}'],
  { redact: [state.password] })));
  if (details.role !== 'data' || details.application !== name ||
      !Object.hasOwn(details.networks, runtime.names.sqlNetwork) ||
      !details.environment.includes(`SQL_CONNECTION_STRING=${connection(runtime, state)}`) ||
      !details.mounts.some(mount => mount.Source === target.configFile && mount.Destination === '/App/dab-config.json' && !mount.RW)) {
    throw new Error('Selected DAB ownership, database, network or configuration does not match; no services were modified');
  }
}

async function selectedContext(home: string, directory: string) {
  const manifest = await checkSelectedApplication(home, directory, 'local-simulation');
  const runtime = runtimeFor(undefined, home);
  if (runtime.home !== runtimeFor().home) throw new Error('Run selected local commands from the explicitly bound runtime home');
  return { manifest, runtime, target: selectedLocalPaths(runtime, manifest.name) };
}

async function initializeDatabase(runtime: WorkspaceRuntime, manifest: ApplicationBuildManifest, directory: string, runner: Run) {
  const target = selectedLocalPaths(runtime, manifest.name);
  const endpoint = await selectedEndpoint(runtime, manifest.name);
  if (endpoint) {
    const grants = (await readFile(join(directory, 'setup', 'grants.sql'), 'utf8')).replaceAll('$(ApplicationUser)', runtime.login);
    await initializeEndpoint(endpoint, runner, { profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/Ready' },
      { project: join(directory, 'sql', 'database.sqlproj'), output: target.compiled, intermediate: target.intermediate, grants, postDeploy: true });
    return;
  }
  await withStateLock(target.stateFile, async () => {
    await verifyLocal(runtime.sqlContainer, runner);
    let state: z.infer<typeof credentials>;
    try { state = await readCredentials(runtime, manifest.name); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const existing = await localAdminQuery(runtime.sqlContainer, 'master',
        `SET NOCOUNT ON; SELECT CASE WHEN DB_ID(N'${target.database}') IS NOT NULL OR SUSER_ID(N'${target.login}') IS NOT NULL THEN 1 ELSE 0 END;`, runner);
      if (existing.trim() !== '0') throw new Error('Selected SQL objects exist without recorded credentials; review binding instead of resetting data or passwords');
      state = { version: 1, workspace: runtime.id, name: manifest.name, container: runtime.sqlContainer,
        database: target.database, login: target.login, password: `SqlApps1!${randomBytes(32).toString('hex')}` };
      await saveJson(target.stateFile, state);
    }
    await localAdminQuery(runtime.sqlContainer, 'master', `
IF DB_ID(N'${target.database}') IS NULL CREATE DATABASE [${target.database}];
IF SUSER_ID(N'${target.login}') IS NULL CREATE LOGIN [${target.login}] WITH PASSWORD=N'${state.password}';
`, runner, [state.password]);
    await publishLocalSchema(runtime.sqlContainer, { database: target.database,
      project: join(directory, 'sql', 'database.sqlproj'), output: target.compiled, intermediate: target.intermediate,
      runPostDeploy: true }, runner);
    const grants = (await readFile(join(directory, 'setup', 'grants.sql'), 'utf8')).replaceAll('$(ApplicationUser)', target.login);
    await localAdminQuery(runtime.sqlContainer, target.database,
      `IF DATABASE_PRINCIPAL_ID(N'${target.login}') IS NULL CREATE USER [${target.login}] FOR LOGIN [${target.login}];\n${grants}`,
      runner, [state.password]);
    const dab = z.object({ entities: z.record(z.string(), z.object({ source: z.object({ object: z.string().regex(/^dbo\.[A-Za-z][A-Za-z0-9_]{0,127}$/) }) })) })
      .parse(JSON.parse(await readFile(join(directory, 'dab', 'dab-config.json'), 'utf8')));
    const ready = dab.entities[manifest.sessions.ready];
    if (!ready) throw new Error('Selected SQL readiness procedure is missing');
    const probe = await querySelectedLocal(runtime, manifest.name, `SET NOCOUNT ON; EXEC [dbo].[${ready.source.object.slice(4)}];`, runner);
    if (!probe.trim().split(/\r?\n/).includes('ready|1')) throw new Error('Selected application login/procedure probe failed; runtime never falls back to sa');
  });
}

export async function prepareSelectedLocalApplication(home: string, directory: string, runner: Run = run) {
  if (process.env.NODE_ENV === 'production') throw new Error('Selected local startup is disabled in production');
  const context = await selectedContext(home, directory);
  const endpoint = await selectedEndpoint(context.runtime, context.manifest.name);
  if (endpoint) {
    if (await portState(context.runtime.ports.gateway) !== 'free') throw new Error('Selected gateway port is occupied or unverifiable; no service was stopped.');
    await initializeDatabase(context.runtime, context.manifest, directory, runner);
    const config: unknown = JSON.parse(await readFile(join(directory, 'dab', 'dab-config.json'), 'utf8'));
    await saveJson(context.target.configFile, config);
    await startHostData(endpoint, config, runner);
    return context;
  }
  const { runtime, manifest, target } = context;
  await withStateLock(join(target.directory, 'startup'), async () => {
    if (await portState(runtime.ports.gateway) !== 'free') throw new Error('Selected gateway port is occupied or unverifiable; reuse the intended app without stopping unrelated processes');
    const existing = (await runner('docker', ['ps', '--all', '--filter', `name=^/${target.dataContainer}$`, '--format', '{{.Names}}'])).trim();
    const config = await readFile(join(directory, 'dab', 'dab-config.json'), 'utf8');
    if (existing) {
      await verifyData(runtime, manifest.name, runner);
      if (JSON.stringify(JSON.parse(await readFile(target.configFile, 'utf8'))) !== JSON.stringify(JSON.parse(config))) {
        throw new Error('Selected DAB configuration changed; explicitly stop the owned selected data service before updating');
      }
    } else if (await portState(runtime.ports.data) !== 'free') {
      throw new Error('Selected DAB port is occupied or unverifiable; no existing services were stopped');
    }
    const sqlPort = runtime.ports.sql;
    if (sqlPort === null) throw new Error('Selected SQL requires a known isolated port');
    const sqlPortState = await portState(sqlPort);
    if (sqlPortState === 'unknown') throw new Error('Selected SQL port cannot be verified; no resources were changed');
    if (sqlPortState === 'occupied') {
      const sql = (await runner('docker', ['ps', '--filter', `name=^/${runtime.sqlContainer}$`, '--format', '{{.Names}}'])).trim();
      if (sql !== runtime.sqlContainer) throw new Error('Selected SQL port belongs to another service; no resources were changed');
      await verifyContainerWorkspace(sql, runtime, sqlImage, { '1433/tcp': sqlPort }, runner);
    }
    console.log(`Selected source/artifact and ports verified (${manifest.name}, ${runtime.id}); starting owned SQL.`);
    await startLocalSql(runtime.sqlContainer, runner);
    console.log('Selected SQL engine ready; publishing the application schema and probing its execute-only login.');
    await initializeDatabase(runtime, manifest, directory, runner);
    console.log('Selected SQL schema/login/procedure ready; starting the selected DAB service.');
    const state = await readCredentials(runtime, manifest.name);
    if (existing) await runner('docker', ['start', target.dataContainer]);
    else {
      await saveJson(target.configFile, JSON.parse(config));
      await runner('docker', ['run', '--detach', '--name', target.dataContainer, '--label', 'sql-apps.local=data',
        ...runtime.labels, '--label', `sql-apps.application=${manifest.name}`, '--network', runtime.names.sqlNetwork,
        '--publish', `127.0.0.1:${runtime.ports.data}:5000`, '--env', 'SQL_CONNECTION_STRING',
        '--env', 'ASPNETCORE_URLS=http://+:5000', '--mount', `type=bind,source=${target.configFile},target=/App/dab-config.json,readonly`, dabImage],
      { env: { SQL_CONNECTION_STRING: connection(runtime, state) }, redact: [state.password] });
    }
  });
  return context;
}

export async function serveSelectedLocalApplication(home: string, directory: string, runner: Run = run) {
  if (process.env.NODE_ENV === 'production') throw new Error('Selected local startup is disabled in production');
  const { runtime, manifest } = await selectedContext(home, directory);
  await verifyData(runtime, manifest.name, runner);
  const loaded = z.object({ createApplication: z.custom<(options: DemoOptions) => Promise<FastifyInstance>>(value => typeof value === 'function') })
    .parse(await import(pathToFileURL(join(resolve(directory), 'server', 'application.mjs')).href));
  const app = await loaded.createApplication({ profile: 'local-simulation', origin: runtime.origins.app,
    dabUrl: runtime.origins.data, publicDirectory: join(resolve(directory), 'public') });
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      if (response.statusCode === 200) break;
      if (attempt === 29) throw new Error(`Selected SQL/DAB readiness failed (${response.statusCode}); inspect the owned data container`);
      await new Promise(done => setTimeout(done, 1_000));
    }
    await app.listen({ host: '127.0.0.1', port: runtime.ports.gateway });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`Selected ${manifest.name} ready at ${runtime.origins.app}; anonymous synthetic data only.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  return app;
}

export async function stopSelectedLocalData(home: string, name: string, runner: Run = run) {
  const runtime = runtimeFor(undefined, home);
  if (runtime.home !== runtimeFor().home) throw new Error('Run selected local commands from the explicitly bound runtime home');
  const target = selectedLocalPaths(runtime, name);
  await withStateLock(join(target.directory, 'startup'), async () => {
    const endpoint = await selectedEndpoint(runtime, name);
    if (endpoint) {
      await stopHostData(endpoint);
      return;
    }
    await verifyData(runtime, name, runner);
    await runner('docker', ['rm', '--force', target.dataContainer]);
  });
}
