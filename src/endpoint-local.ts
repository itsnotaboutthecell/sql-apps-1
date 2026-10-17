import { readFile } from 'node:fs/promises';
import { initializeEndpoint, endpointRuntimeQuery, endpointAdminQuery, readEndpointCredentials, verifyEndpoint, type EndpointTarget } from './sql-endpoint.js';
import { localDabConfig } from './local.js';
import { serveLocalApp } from './local-app.js';
import { startHostData, verifyHostData, stopHostData } from './local-data-process.js';
import { projectPath, toolingAsset } from './runtime-roots.js';
import { runtimeFor } from './workspace.mjs';
import type { RoleBasedProfile } from './role-based-profile.js';
import type { Run } from './process.js';
import { recordCreationCapability } from './creation-session.mjs';

export async function endpointLocalCommand(command: string, target: EndpointTarget, run: Run, profile?: RoleBasedProfile): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Development database routes are disabled in production.');
  if (['configure-express', 'configure-express-auth'].includes(command)) {
    if (target.provider !== 'express') throw new Error('Select an Express target before instance configuration.');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', toolingAsset('scripts', 'sql-express.ps1'),
      '-Action', command === 'configure-express-auth' ? 'ConfigureSqlAuthentication' : 'Configure',
      '-Instance', target.instance, '-Port', String(target.port), '-AllowRestart']);
    return;
  }
  if (command === 'verify') { await verifyEndpoint(target, run); return; }
  if (command === 'stop') { await stopHostData(target); return; }
  if (!profile) throw new Error(`${command} needs the application's role-based profile.`);
  if (command === 'app-check') {
    await endpointAdminQuery(target, await readFile(projectPath('sql', 'local', 'application-acceptance.sql'), 'utf8'), run);
    return;
  }
  if (['app', 'role-based-app', 'init'].includes(command)) {
    await initializeEndpoint(target, run, profile);
    const state = await readEndpointCredentials(runtimeFor(), target, run);
    const statement = (await readFile(projectPath('sql', 'local', 'acceptance.sql'), 'utf8')).replaceAll('$(LocalDabUser)', state.login);
    const rows = await endpointRuntimeQuery(target, statement, run);
    if (!rows.some(row => row.message === 'LOCAL SQL ACCEPTANCE PASSED')) throw new Error('Endpoint SQL acceptance did not report success.');
    await recordCreationCapability(runtimeFor().home, 'data', 'verified', 'Selected endpoint least-privilege SQL query and schema acceptance passed.');
    if (command === 'init') return;
  }
  const config = await localDabConfig(profile);
  if (['app', 'role-based-app', 'data'].includes(command)) await startHostData(target, config, run);
  if (['app', 'role-based-app', 'serve', 'role-based-serve'].includes(command)) {
    await verifyHostData(target, config);
    await serveLocalApp(runtimeFor().sqlContainer, profile);
    return;
  }
  if (command === 'data') return;
  if (command === 'test') {
    const state = await readEndpointCredentials(runtimeFor(), target, run);
    const rows = await endpointRuntimeQuery(target, (await readFile(projectPath('sql', 'local', 'acceptance.sql'), 'utf8'))
      .replaceAll('$(LocalDabUser)', state.login), run);
    if (!rows.some(row => row.message === 'LOCAL SQL ACCEPTANCE PASSED')) throw new Error('Endpoint SQL acceptance did not report success.');
    return;
  }
  if (command === 'app-test') {
    const { testLocalApp } = await import('./local-app-smoke.js');
    await testLocalApp(profile);
    return;
  }
  throw new Error(`Unsupported endpoint operation: ${command}. Database installation/provisioning is separately approved; no container was started.`);
}
