import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import sql from 'mssql';
import { z } from 'zod';
import { validateSqlTarget, sqlTargetFingerprint, type SqlTarget } from './sql-target.mjs';
import { saveJson, withStateLock } from './state-files.js';
import { runtimeFor, type WorkspaceRuntime } from './workspace.mjs';
import { roleBasedProcedureGrants, type RoleBasedProfile } from './role-based-profile.js';
import { projectPath, toolingAsset } from './runtime-roots.js';
import type { Run } from './process.js';
import { ensureLocalSqlPackage } from './local.js';

export type EndpointTarget = Exclude<SqlTarget, { provider: 'container' }>;
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
const identity = z.object({ engineEdition: z.number(), edition: z.string(), majorVersion: z.number(), database: z.string() });
const credentials = z.strictObject({
  version: z.literal(1), home: z.string(), workspace: z.string(), fingerprint: z.string(),
  login: identifier, password: z.string().regex(/^SqlApps1![a-f0-9]{64}$/),
});
export type EndpointCredentials = z.infer<typeof credentials>;
const identitySql = `SET NOCOUNT ON; SELECT CONVERT(int,SERVERPROPERTY('EngineEdition')) AS engineEdition,
CONVERT(nvarchar(128),SERVERPROPERTY('Edition')) AS edition,
CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS majorVersion, DB_NAME() AS [database];`;

export function verifyEndpointIdentity(target: EndpointTarget, value: unknown): void {
  const result = identity.parse(value);
  const correctEngine = target.provider === 'azure' ? result.engineEdition === 5 && result.edition === 'SQL Azure' :
    result.engineEdition === 4 && result.majorVersion === 17 && /^Express Edition(?:\s|$)/.test(result.edition);
  if (!correctEngine || result.database !== target.database) throw new Error('SQL endpoint identity does not match the approved provider/version/database.');
}

export function endpointConnection(target: EndpointTarget, login: string, password: string): string {
  validateSqlTarget(target);
  identifier.parse(login);
  if (['sa', 'dbo'].includes(login.toLowerCase())) throw new Error('SQL runtime must not use an administrator.');
  return `Server=${target.server}${target.provider === 'express' ? `,${target.port}` : ',1433'};Database=${target.database};` +
    `User Id=${login};Password="${password.replaceAll('"', '""')}";Encrypt=True;TrustServerCertificate=${target.provider === 'express' ? 'True' : 'False'};`;
}

export function endpointSchemaPlatform(target: EndpointTarget): string {
  return target.provider === 'express' ? 'Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider' :
    'Microsoft.Data.Tools.Schema.Sql.SqlAzureV12DatabaseSchemaProvider';
}

function statePath(runtime: WorkspaceRuntime, target: EndpointTarget) {
  return join(runtime.stateDirectory, `endpoint-${sqlTargetFingerprint(target)}.json`);
}

async function protect(text: string, run: Run, decrypt = false): Promise<string> {
  if (process.platform !== 'win32') return text;
  const command = "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');" +
    (decrypt
      ? "[Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
      : "[Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))");
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { input: text, sensitiveOutput: true, timeoutMs: 15000 });
}

export async function readProtectedJson(path: string, run: Run): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 ||
      process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Endpoint credentials require a protected regular file.');
  const envelope = z.strictObject({ version: z.literal(1), protection: z.enum(['current-user', 'file-mode']), payload: z.string() })
    .parse(JSON.parse(await readFile(path, 'utf8')));
  if (envelope.protection !== (process.platform === 'win32' ? 'current-user' : 'file-mode')) throw new Error('Endpoint credential protection does not match this host.');
  return JSON.parse(await protect(envelope.payload, run, true));
}

export async function saveProtectedJson(path: string, value: unknown, run: Run): Promise<void> {
  await saveJson(path, { version: 1, protection: process.platform === 'win32' ? 'current-user' : 'file-mode',
    payload: await protect(JSON.stringify(value), run) });
}

export async function readEndpointCredentials(runtime: WorkspaceRuntime, target: EndpointTarget, run: Run): Promise<EndpointCredentials> {
  const state = credentials.parse(await readProtectedJson(statePath(runtime, target), run));
  if (state.home !== runtime.home || state.workspace !== runtime.id || state.fingerprint !== sqlTargetFingerprint(target)) {
    throw new Error('Endpoint credentials belong to another target/workspace; no password was reset.');
  }
  return state;
}

async function saveCredentials(runtime: WorkspaceRuntime, target: EndpointTarget, state: EndpointCredentials, run: Run) {
  await saveProtectedJson(statePath(runtime, target), credentials.parse(state), run);
}

async function queryOnce(target: EndpointTarget, statement: string, run: Run, state?: EndpointCredentials, redact: readonly string[] = []) {
  let token: string | undefined;
  if (!state && target.provider === 'express') {
    const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      toolingAsset('scripts', 'sql-express.ps1'), '-Action', 'Query', '-Instance', target.instance, '-Database', target.database],
    { input: JSON.stringify({ sql: statement }), sensitiveOutput: true, timeoutMs: 60000 });
    return z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(output));
  }
  if (!state && target.provider === 'azure') {
    const account = z.object({ id: z.string(), tenantId: z.string() }).parse(JSON.parse(await run('az', ['account', 'show', '-o', 'json'])));
    if (account.id !== target.subscriptionId || account.tenantId !== target.tenantId) throw new Error('Azure account does not match the selected SQL subscription/tenant; select it explicitly before retrying.');
    token = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(await run('az',
      ['account', 'get-access-token', '--subscription', target.subscriptionId, '--tenant', target.tenantId,
        '--resource', 'https://database.windows.net/', '-o', 'json'], { sensitiveOutput: true }))).accessToken;
  }
  const pool = new sql.ConnectionPool({
    server: target.server, port: target.provider === 'express' ? target.port : 1433, database: target.database,
    options: { encrypt: true, trustServerCertificate: target.provider === 'express' },
    ...(state ? { user: state.login, password: state.password } :
      { authentication: { type: 'azure-active-directory-access-token' as const, options: { token: z.string().min(1).parse(token) } } }),
    pool: { min: 0, max: 1, idleTimeoutMillis: 30000 }, connectionTimeout: 15000, requestTimeout: 30000,
  });
  try {
    await pool.connect();
    const messages: Record<string, unknown>[] = [];
    const request = pool.request();
    request.on('info', info => messages.push({ message: info.message }));
    const result = await request.query<Record<string, unknown>>(statement);
    return [...Object.values(result.recordsets).flat(), ...messages];
  } catch (error) {
    let message = error instanceof Error ? error.message : 'SQL endpoint operation failed.';
    for (const secret of [state?.password, token, ...redact]) if (secret) message = message.replaceAll(secret, '[REDACTED]');
    const safe = new Error(`SQL endpoint operation failed: ${message}`);
    if (error instanceof Error && 'number' in error && error.number === 40613) Object.assign(safe, { number: 40613 });
    throw safe;
  } finally { await pool.close(); }
}

async function query(target: EndpointTarget, statement: string, run: Run, state?: EndpointCredentials, redact: readonly string[] = []): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; ; attempt++) {
    try { return await queryOnce(target, statement, run, state, redact); }
    catch (error) {
      if (target.provider !== 'azure' || attempt >= 3 || !(error instanceof Error) || !('number' in error) || error.number !== 40613) throw error;
      console.error(`Azure SQL is resuming (40613); retrying the unavailable-database operation (${attempt + 1}/3).`);
      await new Promise(done => setTimeout(done, 2000));
    }
  }
}

export async function endpointAdminQuery(target: EndpointTarget, statement: string, run: Run): Promise<Record<string, unknown>[]> {
  return query(target, statement, run);
}

export async function verifyEndpoint(target: EndpointTarget, run: Run): Promise<void> {
  validateSqlTarget(target);
  const rows = await query(target, identitySql, run);
  verifyEndpointIdentity(target, rows[0]);
}

export async function endpointRuntimeQuery(target: EndpointTarget, statement: string, run: Run,
  runtime = runtimeFor()): Promise<Record<string, unknown>[]> {
  return query(target, statement, run, await readEndpointCredentials(runtime, target, run));
}

export async function initializeEndpoint(target: EndpointTarget, run: Run, authorized: RoleBasedProfile,
  options: { project?: string; output?: string; intermediate?: string; grants?: string; postDeploy?: boolean } = {}): Promise<void> {
  const runtime = runtimeFor();
  await withStateLock(statePath(runtime, target), async () => {
    if (target.provider === 'express') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', toolingAsset('scripts', 'sql-express.ps1'),
        '-Action', 'Database', '-Instance', target.instance, '-Database', target.database],
      { timeoutMs: 60000 });
    }
    await verifyEndpoint(target, run);
    let state: EndpointCredentials;
    try { state = await readEndpointCredentials(runtime, target, run); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const login = runtime.login;
      const rows = await query(target, `SELECT USER_ID(N'${login}') AS principal;`, run);
      if (rows[0]?.principal != null) throw new Error('Runtime principal exists without protected credentials; no credential was reset.');
      state = { version: 1, home: runtime.home, workspace: runtime.id, fingerprint: sqlTargetFingerprint(target),
        login, password: `SqlApps1!${randomBytes(32).toString('hex')}` };
      await saveCredentials(runtime, target, state, run);
    }
    const output = options.output ?? join(runtime.stateDirectory, `schema-${sqlTargetFingerprint(target)}`);
    await ensureLocalSqlPackage(run);
    await run('dotnet', ['build', options.project ?? projectPath('sql', 'database.sqlproj'), '--output', output,
      `-p:DSP=${endpointSchemaPlatform(target)}`, `-p:BaseIntermediateOutputPath=${options.intermediate ?? join(output, 'obj')}${sep}`]);
    const server = target.provider === 'express' ? `lpc:.${target.instance.toUpperCase() === 'MSSQLSERVER' ? '' : `\\${target.instance}`}` : `${target.server},1433`;
    const connection = `Server=${server};Database=${target.database};Encrypt=True;` +
      (target.provider === 'express' ? 'TrustServerCertificate=True;Integrated Security=True;' : 'TrustServerCertificate=False;Authentication=Active Directory Default;');
    await run('dotnet', ['tool', 'run', 'sqlpackage', '--', '/Action:Publish',
      `/SourceFile:${join(output, 'database.dacpac')}`, `/TargetConnectionString:${connection}`,
      `/p:IgnorePostDeployScript=${options.postDeploy ? 'False' : 'True'}`,
      ...(target.provider === 'express' ? ['/p:ScriptDatabaseOptions=False'] : []),
      '/p:BlockOnPossibleDataLoss=True', '/p:DropObjectsNotInSource=False'],
    target.provider === 'azure' ? { env: { AZURE_TOKEN_CREDENTIALS: 'AzureCliCredential', AZURE_TENANT_ID: target.tenantId } } : {});
    const password = state.password.replaceAll("'", "''");
    await query(target, `IF USER_ID(N'${state.login}') IS NULL CREATE USER [${state.login}] WITH PASSWORD = '${password}';\nGRANT CONNECT TO [${state.login}];\n` +
      (options.grants ?? roleBasedProcedureGrants(JSON.parse(await readFile(projectPath('dab', 'dab-config.json'), 'utf8')), authorized, state.login)), run, undefined, [state.password]);
    verifyEndpointIdentity(target, (await query(target, identitySql, run, state))[0]);
    const result = await query(target, 'SELECT USER_NAME() AS principal, DB_NAME() AS [database];', run, state);
    if (result[0]?.principal !== state.login || result[0]?.database !== target.database) throw new Error('Least-privilege runtime SQL identity did not verify.');
  });
}
