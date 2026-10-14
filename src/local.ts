import { readFile, unlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { saveJson, withStateLock } from './state-files.js';
import type { Run } from './process.js';
import { runtimeFor } from './workspace.mjs';
import { verifyContainerWorkspace } from './local-ownership.js';
import { pinnedDabImage } from './local-images.js';
import { type RoleBasedProfile, validateRoleBasedDab, roleBasedProcedureGrants } from './role-based-profile.js';
import { projectPath } from './runtime-roots.js';

const database = runtimeFor().database;
const login = runtimeFor().login;
function localPaths(container: string) {
  stateSchema.shape.container.parse(container);
  const runtime = runtimeFor(container);
  return {
    stateFile: runtime.names.sqlState,
    configFile: runtime.names.dataConfig,
    dataContainer: runtime.names.data,
  };
}
const stateSchema = z.strictObject({
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  password: z.string().regex(/^SqlApps1![a-f0-9]{64}$/),
});
type LocalState = z.infer<typeof stateSchema>;
const sqlRecoverySchema = z.strictObject({
  version: z.literal(1), workspace: z.string(), container: z.string(),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), password: z.string().min(1),
});
type SqlRecovery = z.infer<typeof sqlRecoverySchema>;
const sqlcmd = '/opt/mssql-tools18/bin/sqlcmd';
export const localOrigin = runtimeFor().origins.data;
export const sqlImage = 'sqldbpreview-dpgaeqhmgphzd4bk.azurecr.io/azure-sql/db-dev:latest';
export const dabImage = pinnedDabImage;

async function prepareSqlResources(container: string, run: Run, create: boolean, inspectMount = true): Promise<void> {
  const runtime = runtimeFor(container);
  if (runtime.mode !== 'isolated') return;
  const volume = `${container}-data`;
  const volumeExists = (await run('docker', ['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'])).trim();
  if (volumeExists) {
    const owner = z.object({ workspace: z.string(), role: z.string() }).parse(JSON.parse(await run('docker',
      ['volume', 'inspect', volume, '--format',
        '{"workspace":{{json (index .Labels "sql-apps.workspace")}},"role":{{json (index .Labels "sql-apps.local")}}}'])));
    if (owner.workspace !== runtime.id || owner.role !== 'sql') throw new Error('SQL volume belongs to another workspace; no credentials or volumes were reset');
    if (create) {
      throw new Error('Owned SQL volume exists without its credential-bearing container; data is preserved and credentials will not be reset');
    }
  } else if (!create) throw new Error('Owned SQL volume is missing; review existing mounts without recreating data');
  if (!create && inspectMount) {
    const mounts = z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() }))
      .parse(JSON.parse(await run('docker', ['inspect', container, '--format', '{{json .Mounts}}'])));
    if (!mounts.some(mount => mount.Type === 'volume' && mount.Name === volume && mount.Destination === '/var/opt/mssql')) {
      throw new Error('SQL container is not using its recorded workspace volume; refusing to restart it');
    }
  }
  const network = runtime.names.sqlNetwork;
  const present = (await run('docker', ['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.Name}}'])).trim();
  if (present) {
    const owner = z.object({ workspace: z.string(), role: z.string() }).parse(JSON.parse(await run('docker',
      ['network', 'inspect', network, '--format',
        '{"workspace":{{json (index .Labels "sql-apps.workspace")}},"role":{{json (index .Labels "sql-apps.local")}}}'])));
    if (owner.workspace !== runtime.id || owner.role !== 'sql-network') throw new Error('SQL bridge network belongs to another workspace');
  } else if (!create) throw new Error('Workspace SQL network is missing; review the existing container before reconnecting it');
  if (create && !volumeExists) {
    await run('docker', ['volume', 'create', '--label', 'sql-apps.local=sql', ...runtime.labels, volume]);
  }
  if (create && !present) {
    await run('docker', ['network', 'create', '--label', 'sql-apps.local=sql-network', ...runtime.labels, network]);
  }
}

export function localConnection(password: string, server = 'host.docker.internal,1433'): string {
  return `Server=${server};Database=${database};User Id=${login};Password="${password.replaceAll('"', '""')}";Encrypt=True;TrustServerCertificate=True;`;
}

async function createSqlContainer(container: string, password: string, run: Run): Promise<void> {
  const runtime = runtimeFor(container);
  await run('docker', ['run', '--detach', '--name', container, '--label', 'sql-apps.local=sql',
    ...runtime.labels,
    ...(runtime.mode === 'isolated' ? ['--network', runtime.names.sqlNetwork] : []),
    '--platform', 'linux/amd64', '--env', 'ACCEPT_EULA=Y', '--env', 'MSSQL_SA_PASSWORD',
    '--publish', `127.0.0.1:${runtime.ports.sql ?? ''}:1433`, '--mount',
    `type=volume,source=${container}-data,target=/var/opt/mssql`, sqlImage],
  { env: { MSSQL_SA_PASSWORD: password }, redact: [password] });
}

async function recoverLocalSql(container: string, run: Run): Promise<void> {
  const runtime = runtimeFor(container);
  if (process.env.NODE_ENV === 'production' || runtime.mode !== 'isolated' || !runtime.ownsSqlName || runtime.ports.sql === null) {
    throw new Error('SQL recovery is only available for the selected isolated workspace SQL container, never external or legacy SQL');
  }
  const sqlPort = runtime.ports.sql;
  const path = `${localPaths(container).stateFile}.recovery.json`;
  await withStateLock(path, async () => {
    let pending = await readSqlRecovery(container);
    if (pending && (pending.workspace !== runtime.id || pending.container !== container)) {
      throw new Error('SQL recovery state belongs to another workspace; no resources were changed');
    }
    const existing = (await run('docker', ['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'])).trim();
    let alreadyRunning = false;
    if (existing) {
      await verifyContainerWorkspace(container, runtime, sqlImage, { '1433/tcp': sqlPort }, run);
      const details = z.object({ status: z.string(), role: z.string(), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
        .parse(JSON.parse(await run('docker', ['inspect', container, '--format',
          '{"status":{{json .State.Status}},"role":{{json (index .Config.Labels "sql-apps.local")}},"imageId":{{json .Image}}}'])));
      alreadyRunning = Boolean(pending) && details.status === 'running';
      if (details.role !== 'sql' || !(details.status === 'exited' || (pending && ['created', 'running'].includes(details.status)))) {
        throw new Error('SQL recovery requires a stopped, workspace-owned SQL container; it never stops a running container');
      }
      const environment = z.array(z.string()).parse(JSON.parse(
        await run('docker', ['inspect', container, '--format', '{{json .Config.Env}}'])));
      const password = environment.find(value => value.startsWith('MSSQL_SA_PASSWORD='))?.slice('MSSQL_SA_PASSWORD='.length);
      if (!password) throw new Error('SQL administrator credentials are unavailable; recovery will not reset them');
      if (pending && (pending.imageId !== details.imageId || pending.password !== password)) {
        throw new Error('SQL image or credentials changed since interrupted recovery; review before modifying anything');
      }
      pending ??= { version: 1, workspace: runtime.id, container, imageId: details.imageId, password };
    }
    if (!pending) throw new Error('SQL container and recovery credentials are missing; data is untouched');
    await prepareSqlResources(container, run, false, Boolean(existing));
    const images = (await run('docker', ['image', 'inspect', sqlImage, pending.imageId, '--format', '{{.Id}}']))
      .trim().split(/\r?\n/);
    if (images.length !== 2 || !/^sha256:[a-f0-9]{64}$/.test(images[0]!) || images[0] !== images[1]) {
      throw new Error('The SQL image tag changed; review the requested image upgrade before recovery. Existing data is untouched.');
    }
    await saveJson(path, pending);
    if (!alreadyRunning) {
      if (existing) await run('docker', ['rm', container]);
      await createSqlContainer(container, pending.password, run);
    }
    await waitLocalSql(container, run);
    await unlink(path);
  });
}

async function readSqlRecovery(container: string): Promise<SqlRecovery | undefined> {
  try {
    return sqlRecoverySchema.parse(JSON.parse(await readFile(`${localPaths(container).stateFile}.recovery.json`, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function startLocalSql(container: string, run: Run): Promise<void> {
  stateSchema.shape.container.parse(container);
  const runtime = runtimeFor(container);
  if (await readSqlRecovery(container)) {
    throw new Error(`SQL recovery is incomplete. Data and original credentials are preserved; explicitly resume recover-sql ${container} before normal startup.`);
  }
  const existing = (await run('docker', ['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'])).trim();
  if (existing) {
    const owned = (await run('docker', ['inspect', container, '--format', '{{index .Config.Labels "sql-apps.local"}}'])).trim();
    if (owned !== 'sql') throw new Error('Container name is already in use; use init to reuse it or choose a different name');
    if (runtime.mode === 'isolated') {
      if (!runtime.ownsSqlName) throw new Error('External SQL containers can be selected for verify/init, but start-sql cannot modify them.');
      if (runtime.ports.sql === null) throw new Error('Workspace SQL port is missing');
      await verifyContainerWorkspace(container, runtime, sqlImage, { '1433/tcp': runtime.ports.sql }, run);
      await prepareSqlResources(container, run, false);
    }
    await run('docker', ['start', container]);
  } else {
    if (runtime.mode === 'isolated' && !runtime.ownsSqlName) throw new Error('Use the workspace SQL name for start-sql; external SQL containers must already exist and be explicitly selected for verify/init.');
    await prepareSqlResources(container, run, true);
    const password = `SqlApps1!${randomBytes(32).toString('hex')}`;
    await createSqlContainer(container, password, run);
  }
  await waitLocalSql(container, run);
}

async function waitLocalSql(container: string, run: Run): Promise<void> {
  const runtime = runtimeFor(container);
  let recoveryRetries = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = z.object({ StartedAt: z.string(), Status: z.string() })
      .parse(JSON.parse(await run('docker', ['inspect', container, '--format', '{{json .State}}'])));
    if (state.Status === 'exited') {
      const logs = await run('docker', ['logs', '--since', state.StartedAt, '--tail', '250', container]);
      if (recoveryRetries < 3 && logs.includes('Reconcile finished with') && /cannot\s*be\s*autostarted/.test(logs)) {
        recoveryRetries++;
        console.error(`Retrying Azure SQL preview startup after transient recovery error 904 (${recoveryRetries}/3).`);
        await run('docker', ['start', container]);
        continue;
      }
      if (logs.includes('Reconcile finished with') && /cannot\s*be\s*autostarted/.test(logs)) {
        throw new Error(`SQL container exited: Azure SQL preview control-plane reconciliation failed after bounded recovery retries; this is not evidence of revoked registry access. Data is preserved. ${
          runtime.mode === 'isolated' ? `After explicit approval, try recover-sql ${container} to recreate only the stopped container with the same image, credentials and data volume.` :
            `Inspect docker logs ${container}; do not delete its volume or reset credentials. Legacy/external recovery is not automatic.`}`);
      }
      throw new Error(`SQL container exited; inspect docker logs ${container}`);
    }
    const started = Date.parse(state.StartedAt);
    if (!Number.isFinite(started)) throw new Error('SQL container returned an invalid startup timestamp');
    let controlPlaneReady = false;
    try {
      const ready = await run('docker', ['exec', container, 'sh', '-c',
        'test -f /var/opt/mssql/.cp-shim/READY && stat -c %Y /var/opt/mssql/.cp-shim/READY']);
      if (!/^[0-9]+\s*$/.test(ready) || Number(ready) < Math.ceil(started / 1_000)) {
        throw new Error('Azure SQL preview control-plane initialization has not completed for this startup');
      }
      controlPlaneReady = true;
      await verifyLocal(container, run);
      return;
    }
    catch (error) {
      if (controlPlaneReady) {
        const logs = await run('docker', ['logs', '--since', state.StartedAt, '--tail', '250', container]);
        if (/Login failed for user 'sa'\. Reason: Password did not match/.test(logs)) {
          throw new Error('SQL container password no longer matches the preserved SQL volume; data was not reset', { cause: error });
        }
      }
      if (attempt === 59) throw new Error(`Local SQL startup did not become ready; inspect docker logs ${container}`, { cause: error });
      await new Promise(done => setTimeout(done, 2_000));
    }
  }
}

async function adminQuery(container: string, sql: string, run: Run, redact: readonly string[] = []): Promise<string> {
  return localAdminQuery(container, 'master', sql, run, redact);
}

export async function localAdminQuery(container: string, target: string, sql: string, run: Run, redact: readonly string[] = []): Promise<string> {
  stateSchema.shape.container.parse(container);
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/).parse(target);
  return run('docker', ['exec', '-i', container, 'sh', '-c',
    `SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" exec ${sqlcmd} -S localhost -U sa -C -b -l 2 -d "$1" -h -1 -W`,
    'sql', target], { input: sql, redact });
}

async function sqlHostPort(container: string, run: Run): Promise<string> {
  const bindings = z.array(z.object({ HostIp: z.string(), HostPort: z.string().regex(/^[0-9]+$/) }))
    .parse(JSON.parse(await run('docker', ['inspect', container, '--format', '{{json (index .NetworkSettings.Ports "1433/tcp")}}'])));
  const port = bindings.find(binding => ['127.0.0.1', '0.0.0.0'].includes(binding.HostIp))?.HostPort;
  if (!port) throw new Error('Publish the SQL container port 1433 to a local host port before initialization');
  return port;
}

export async function verifyLocal(container: string, run: Run): Promise<void> {
  stateSchema.shape.container.parse(container);
  const result = await adminQuery(container,
    "SET NOCOUNT ON; SELECT CONCAT(CONVERT(int,SERVERPROPERTY('EngineEdition')), '|', CONVERT(nvarchar(128),SERVERPROPERTY('Edition')));", run);
  if (result.trim() !== '5|SQL Azure') throw new Error('Local development requires the Azure SQL Database engine (EngineEdition 5 / SQL Azure)');
}

async function readLocal(container: string): Promise<LocalState> {
  const state = stateSchema.parse(JSON.parse(await readFile(localPaths(container).stateFile, 'utf8')));
  if (state.container !== container) throw new Error('Local state belongs to another SQL container');
  return state;
}

export async function publishLocalSchema(container: string, target: {
  database: string; project: string; output: string; intermediate?: string; runPostDeploy?: boolean;
}, run: Run): Promise<void> {
  stateSchema.shape.container.parse(container);
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/).parse(target.database);
  const environment = z.array(z.string()).parse(JSON.parse(await run('docker', ['inspect', container, '--format', '{{json .Config.Env}}'])));
  const adminPassword = environment.find(value => value.startsWith('MSSQL_SA_PASSWORD='))?.slice('MSSQL_SA_PASSWORD='.length);
  if (!adminPassword) throw new Error('Container must expose MSSQL_SA_PASSWORD for local schema publishing; it is never printed or persisted');
  const port = await sqlHostPort(container, run);
  const tools = z.object({ tools: z.object({ 'microsoft.sqlpackage': z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }) }) }).parse(JSON.parse(await readFile(projectPath('.config', 'dotnet-tools.json'), 'utf8')));
  const expected = tools.tools['microsoft.sqlpackage'].version;
  let verified = false;
  try {
    const version = (await run('dotnet', ['tool', 'run', 'sqlpackage', '--', '/Version'])).trim();
    verified = version === expected || version === `${expected}.0`;
  } catch {
    console.error('SqlPackage version probe failed; restoring the approved local tool manifest before schema publication.');
  }
  if (!verified) await run('dotnet', ['tool', 'restore']);
  await run('dotnet', ['build', target.project, '--output', target.output,
    ...(target.intermediate ? [`-p:BaseIntermediateOutputPath=${target.intermediate}${target.intermediate.endsWith(sep) ? '' : sep}`] : [])]);
  await run('dotnet', ['tool', 'run', 'sqlpackage', '--', '/Action:Publish', `/SourceFile:${join(target.output, 'database.dacpac')}`,
    `/TargetConnectionString:Server=127.0.0.1,${port};Database=${target.database};User Id=sa;Password="${adminPassword.replaceAll('"', '""')}";Encrypt=True;TrustServerCertificate=True;`,
    `/p:IgnorePostDeployScript=${target.runPostDeploy ? 'False' : 'True'}`,
    '/p:BlockOnPossibleDataLoss=True', '/p:DropObjectsNotInSource=False'],
  { redact: [adminPassword, adminPassword.replaceAll('"', '""')] });
}

export async function initLocal(container: string, run: Run, authorized: RoleBasedProfile): Promise<void> {
  const { stateFile } = localPaths(container);
  await withStateLock(stateFile, async () => {
    await verifyLocal(container, run);
    let state: LocalState;
    try { state = await readLocal(container); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      state = { container, password: `SqlApps1!${randomBytes(32).toString('hex')}` };
      await saveJson(stateFile, state);
    }
    await adminQuery(container, `
IF DB_ID(N'${database}') IS NULL CREATE DATABASE [${database}];
IF SUSER_ID(N'${login}') IS NULL CREATE LOGIN [${login}] WITH PASSWORD = N'${state.password}';
`, run, [state.password]);
    await publishLocalSchema(container, {
      database,
      project: projectPath('sql', 'database.sqlproj'),
      output: projectPath('dist', 'sql'),
    }, run);
    const grants = roleBasedProcedureGrants(
      JSON.parse(await readFile(projectPath('dab', 'dab-config.json'), 'utf8')), authorized, login,
    );
    try {
      await databaseQuery(state, `
IF DATABASE_PRINCIPAL_ID(N'${login}') IS NULL CREATE USER [${login}] FOR LOGIN [${login}];
${grants}
`, run, true);
    } catch (error) {
      throw new Error('Local app-user setup failed. Older preview images may reject login mapping; use start-sql with a new container name and the current azure-sql/db-dev image. Runtime will not fall back to sa.', { cause: error });
    }
    await testLocalSql(state, run);
  });
}

async function databaseQuery(state: LocalState, sql: string, run: Run, admin = false): Promise<string> {
  return run('docker', ['exec', '-i', ...(admin ? [] : ['--env', 'SQLCMDPASSWORD']), state.container,
    ...(admin ? ['sh', '-c',
      `SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" exec ${sqlcmd} -S localhost -U sa -C -b -d "$1" -h -1 -W`, 'sql', database]
      : [sqlcmd, '-S', 'localhost', '-U', login, '-C', '-b', '-d', database, '-h', '-1', '-W'])],
  { input: sql, ...(admin ? {} : { env: { SQLCMDPASSWORD: state.password } }), redact: [state.password] });
}

async function testLocalSql(state: LocalState, run: Run): Promise<void> {
  await verifyLocal(state.container, run);
  const sql = (await readFile(projectPath('sql', 'local', 'acceptance.sql'), 'utf8')).replaceAll('$(LocalDabUser)', login);
  const result = await databaseQuery(state, sql, run);
  if (!result.includes('LOCAL SQL ACCEPTANCE PASSED')) throw new Error('SQL acceptance did not report success');
}

export function localPrincipal(oid: string, scope = 'access_as_user', role = 'authenticated'): string {
  return Buffer.from(JSON.stringify({
    auth_typ: 'aad', name_typ: 'name', role_typ: 'roles',
    claims: [{ typ: 'name', val: oid }, { typ: 'roles', val: role },
      { typ: 'oid', val: oid }, { typ: 'scp', val: scope }],
  })).toString('base64');
}

export async function localDabConfig(authorized: RoleBasedProfile): Promise<unknown> {
  const config = JSON.parse(await readFile(projectPath('dab', 'dab-config.json'), 'utf8'));
  validateRoleBasedDab(config, authorized);
  config.runtime.host = { mode: 'development', authentication: { provider: 'AppService' } };
  return config;
}

export async function startLocalData(container: string, run: Run, authorized: RoleBasedProfile): Promise<void> {
  const runtime = runtimeFor(container);
  const state = await readLocal(container);
  const { dataContainer, configFile: path } = localPaths(container);
  const config = await localDabConfig(authorized);
  await verifyLocal(container, run);
  await databaseQuery(state, roleBasedProcedureGrants(config, authorized, login), run, true);
  await saveJson(path, config);
  const networks = z.record(z.string(), z.object({ IPAddress: z.ipv4() }))
    .parse(JSON.parse(await run('docker', ['inspect', container, '--format', '{{json .NetworkSettings.Networks}}'])));
  const network = Object.entries(networks)[0];
  if (!network || ['host', 'none'].includes(network[0])) throw new Error('Local SQL needs a Docker bridge network for DAB');
  const existing = (await run('docker', ['ps', '--all', '--filter', `name=^/${dataContainer}$`, '--format', '{{.Names}}'])).trim();
  if (existing) {
    await verifyOwnedData(dataContainer, run);
    await run('docker', ['rm', '--force', dataContainer]);
  }
  await run('docker', ['run', '--detach', '--name', dataContainer, '--label', 'sql-apps.local=data',
    ...runtime.labels, '--network', network[0], '--publish', `127.0.0.1:${runtime.ports.data}:5000`,
    '--env', 'SQL_CONNECTION_STRING', '--env', 'ASPNETCORE_URLS=http://+:5000',
    '--mount', `type=bind,source=${path},target=/App/dab-config.json,readonly`,
    dabImage],
  { env: { SQL_CONNECTION_STRING: localConnection(state.password, `${network[1].IPAddress},1433`) }, redact: [state.password] });
  for (let attempt = 0; attempt < 30; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Local DAB health check timed out')), 2_000);
    try {
      const response = await fetch(`${localOrigin}/health`, { signal: controller.signal });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch (error) {
      if (attempt === 29) throw new Error(`Local DAB readiness failed; inspect docker logs ${dataContainer}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    await new Promise(done => setTimeout(done, 1_000));
  }
  throw new Error(`Local DAB readiness failed; inspect docker logs ${dataContainer}`);
}

async function verifyOwnedData(container: string, run: Run): Promise<void> {
  const owner = (await run('docker', ['inspect', container, '--format', '{{index .Config.Labels "sql-apps.local"}}'])).trim();
  if (owner !== 'data') throw new Error('Refusing to modify a container without the sql-apps.local=data ownership label');
  const runtime = runtimeFor();
  if (runtime.mode === 'isolated') {
    await verifyContainerWorkspace(container, runtime, dabImage, { '5000/tcp': runtime.ports.data }, run);
  }
}

export async function localCommand(command: string, container: string, run: Run, authorized?: RoleBasedProfile): Promise<void> {
  const profile = () => {
    if (!authorized) throw new Error(`${command} needs role-based-data.json`);
    return authorized;
  };
  if (command === 'start-sql') await startLocalSql(container, run);
  else if (command === 'recover-sql') await recoverLocalSql(container, run);
  else if (command === 'verify') await verifyLocal(container, run);
  else if (command === 'init') await initLocal(container, run, profile());
  else if (command === 'test') await testLocalSql(await readLocal(container), run);
  else if (command === 'app-check') {
    const result = await databaseQuery(await readLocal(container),
      await readFile(projectPath('sql', 'local', 'application-acceptance.sql'), 'utf8'), run, true);
    if (!result.includes('CLEAN APPLICATION DATABASE PASSED')) throw new Error('Clean application database acceptance did not report success');
  }
  else if (command === 'data') await startLocalData(container, run, profile());
  else if (command === 'stop') {
    const data = localPaths(container).dataContainer;
    await verifyOwnedData(data, run);
    await run('docker', ['rm', '--force', data]);
  }
  else throw new Error(`Unknown local command: ${command}`);
}
