import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readSqlTarget } from './sql-target.mjs';

const [command = 'help', selection] = process.argv.slice(2);
const projectRoot = resolve(process.env.SQL_APPS_PROJECT_HOME ?? process.cwd());
const profileCommands = ['app', 'serve', 'role-based-app', 'role-based-serve', 'app-test', 'init', 'data'];
if (command === 'help') {
  console.log('Usage: npm run local -- <app|serve|app-test|app-check|start-sql|verify|init|test|data|stop> [sql-container-name]\nWorkspace: workspace-plan | workspace-init <base-port|legacy>. Select isolation or explicit legacy compatibility before app startup. workspace-plan is read-only; initialization records selection, never deletes existing resources. app starts SQL, Data API builder and the browser gateway using role-based-data.json and the authorized procedures in dab/dab-config.json; serve reuses running SQL and DAB. app-check inspects legacy sample objects without dropping data. No Azure subscription or Entra registration required. Loopback-only claim simulation is not production authentication. role-based-app and role-based-serve remain as aliases of app and serve.');
  console.log('SQL recovery: recover-sql [workspace-sql-container] explicitly recreates only a stopped isolated SQL container, preserving its image version, credentials, ports and labeled volume. Obtain approval first; no volume reset or external/legacy recovery.');
  console.log('Authentication: default local preview is simulated. SQL_APPS_LOCAL_AUTH=entra requires AZURE_TENANT_ID and API_CLIENT_ID and a registered workspace callback; local DAB still uses claim simulation.');
  console.log('Express maintenance: configure-express enables containment/loopback TCP and restarts the selected instance. configure-express-auth separately enables mixed-mode SQL authentication and restarts it, without enabling SA. Each requires its own reviewed one-operation administrator approval; ordinary startup never changes instance configuration.');
  console.log('Selected application: selected-app <artifact directory> provisions only its isolated SQL database/login and DAB, then serves the browser. selected-serve <artifact directory> reuses verified running services. selected-stop <application name> removes only that owned DAB container and preserves SQL data. Build with npm run app:build -- <name> local-simulation first. These commands never select an example in the default application.');
  console.log('Selected acceptance: selected-test <artifact directory> runs the opted-in example acceptance suite against its already-running local app; obtain approval for synthetic writes and scoped cleanup first.');
} else {
  const zod = await import('zod');
  try {
    const [
      { localCommand, localOrigin, sqlImage, dabImage },
      { readRoleBasedProfile, validateRoleBasedDab },
      { run },
      { startLocalApplication },
      { runtimeFor, proposeWorkspace, initializeWorkspace },
      { checkWorkspacePorts },
      { assertConsent },
      { readLocalAuthentication },
      { readSqlSources, roleBasedProcedureProblem },
    ] = await Promise.all([
      import('./local.js'),
      import('./role-based-profile.js'),
      import('./process.js'),
      import('./local-startup.js'),
      import('./workspace.mjs'),
      import('./local-ownership.js'),
      import('./local-consent.mjs'),
      import('./local-auth.mjs'),
      import('./role-based-rules.mjs'),
    ]);
    const containerSelection = command.startsWith('selected-') || ['workspace-plan', 'workspace-init'].includes(command) ? undefined : selection;
    const container = runtimeFor(containerSelection, projectRoot).sqlContainer;
    const sqlTarget = await readSqlTarget(projectRoot, container);
    if (sqlTarget.provider !== 'container' && containerSelection) throw new Error('A SQL container argument conflicts with the selected endpoint target.');
    if (['selected-app', 'selected-serve', 'selected-test'].includes(command) &&
        (!selection || process.argv.length !== 4)) throw new Error('Provide exactly one selected application artifact directory');
    const profile = (profileCommands.includes(command) || sqlTarget.provider !== 'container' && ['test', 'app-check'].includes(command))
      ? await readRoleBasedProfile(join(projectRoot, 'role-based-data.json'))
      : undefined;
    if (profile) {
      const dab: unknown = JSON.parse(await readFile(join(projectRoot, 'dab', 'dab-config.json'), 'utf8'));
      validateRoleBasedDab(dab, profile);
      const procedureProblem = roleBasedProcedureProblem(dab, await readSqlSources(projectRoot));
      if (procedureProblem) throw new Error(`${procedureProblem} Add each procedure to the SQL project under sql/ before startup.`);
    }
    const app = command === 'app' || command === 'role-based-app';
    const serve = command === 'serve' || command === 'role-based-serve';
    if (app || serve) readLocalAuthentication();
    await assertConsent(projectRoot, { operation: command, ...(selection === undefined ? {} : { selection }) });
    if (sqlTarget.provider !== 'container' && !command.startsWith('selected-') && !['workspace-plan', 'workspace-init'].includes(command)) {
      const { endpointLocalCommand } = await import('./endpoint-local.js');
      await endpointLocalCommand(command, sqlTarget, run, profile);
    } else if (command === 'selected-app' || command === 'selected-serve') {
      if (!selection) throw new Error('Provide exactly one selected application artifact directory');
      const { prepareSelectedLocalApplication, serveSelectedLocalApplication } = await import('./selected-local.js');
      if (command === 'selected-app') await prepareSelectedLocalApplication(projectRoot, selection);
      await serveSelectedLocalApplication(projectRoot, selection);
    } else if (command === 'selected-test') {
      if (!selection) throw new Error('Provide exactly one selected application artifact directory');
      const { checkSelectedApplication } = await import('./application-build.js');
      const manifest = await checkSelectedApplication(projectRoot, selection, 'local-simulation');
      console.log(await run(process.execPath, [join(projectRoot, 'examples', manifest.name, 'demo', 'smoke.mjs'), selection]));
    } else if (command === 'selected-stop') {
      if (!selection || process.argv.length !== 4) throw new Error('Provide exactly one selected application name');
      const { stopSelectedLocalData } = await import('./selected-local.js');
      await stopSelectedLocalData(projectRoot, selection);
    } else if (command === 'workspace-plan') {
      if (selection) throw new Error('workspace-plan takes no arguments');
      console.log(JSON.stringify(await proposeWorkspace(projectRoot), null, 2));
    } else if (command === 'workspace-init') {
      if (!selection) throw new Error('Explicitly select workspace-init <base-port> or workspace-init legacy after reviewing workspace-plan.');
      console.log(JSON.stringify(await initializeWorkspace(projectRoot, selection === 'legacy' ? 'legacy' : Number(selection)), null, 2));
    } else if ((app || serve) && profile) {
      if (process.env.NODE_ENV === 'production') throw new Error('Local development server is disabled in production');
      const { serveLocalApp } = await import('./local-app.js');
      if (app) {
        await startLocalApplication(container, {
          command: async (step, name) => {
            if (step === 'start-sql') {
              if (runtimeFor(name, projectRoot).mode === 'legacy-unselected') throw new Error('Explicit workspace selection required: run workspace-plan, then approve workspace-init <base-port> or workspace-init legacy.');
              await checkWorkspacePorts(name, run, { sql: sqlImage, data: dabImage });
            }
            await localCommand(step === 'start-sql' && !runtimeFor(name, projectRoot).ownsSqlName ? 'verify' : step, name, run, profile);
          },
          serve: name => serveLocalApp(name, profile),
        }, console.log);
      } else await serveLocalApp(container, profile);
    } else if (command === 'app-test' && profile) {
      const { testLocalApp } = await import('./local-app-smoke.js');
      await testLocalApp(profile);
    } else await localCommand(command, container, run, profile);
    if (!app && !serve && !['selected-app', 'selected-serve', 'workspace-plan', 'workspace-init'].includes(command)) {
      console.log(command === 'data' ? `Local DAB ready at ${localOrigin}; use npm run local -- app-test after serve` : `Local ${command} passed`);
    }
  } catch (error) {
    const messages = [error instanceof zod.z.ZodError ? `Configuration is invalid:\n${zod.z.prettifyError(error)}` :
      error instanceof Error ? error.message : 'Local operation failed'];
    const seen = new Set<unknown>([error]);
    const append = (nested: unknown, depth: number) => {
      if (!(nested instanceof Error) || seen.has(nested) || messages.length >= 20) return;
      seen.add(nested);
      messages.push(nested.message);
      if (nested instanceof AggregateError) {
        for (const item of nested.errors) append(item, depth);
      }
      if (depth > 0) append(nested.cause, depth - 1);
    };
    const causeDepth = command === 'app' ? 2 : 1;
    if (error instanceof AggregateError) {
      for (const nested of error.errors) append(nested, causeDepth);
    }
    if (error instanceof Error) append(error.cause, causeDepth - 1);
    for (const message of messages) console.error(message);
    process.exitCode = 1;
  }
}
