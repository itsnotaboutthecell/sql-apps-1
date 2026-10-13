import { readFile, access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function bindingPath() {
  return join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'sql-apps-local.json');
}

export async function validateHome(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('SQL Apps home must be an absolute checkout path');
  const root = await realpath(value);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const foundation = pkg.name === 'sql-apps';
  const validLocalScript = foundation ? pkg.scripts?.local === 'node dist/src/local-cli.js' :
    pkg.scripts?.local === 'sql-apps local';
  if ((!foundation && (pkg.sqlApps?.project !== true ||
       typeof pkg.dependencies?.['@microsoft/sql-apps'] !== 'string')) || !validLocalScript) {
    throw new Error('The selected directory is not this SQL Apps application checkout');
  }
  for (const file of ['src/local-cli.ts', 'sql/database.sqlproj',
    ...(foundation ? ['plugins/sql-apps/plugin.json'] : [])]) await access(join(root, file));
  return root;
}

async function activeProject(userHome) {
  let state;
  try { state = JSON.parse(await readFile(join(userHome, '.sql-apps', 'projects.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error('Invalid SQL Apps project registry; review it without resetting state.');
    throw error;
  }
  if (state?.version !== 1 || (state.activeProject !== null && typeof state.activeProject !== 'string')) {
    throw new Error('Invalid SQL Apps project registry; review it without resetting state.');
  }
  return state.activeProject ?? undefined;
}

export async function resolveHome(options = {}) {
  const environment = options.environment ?? process.env;
  const userHome = resolve(options.userHome ?? homedir());
  if (environment.SQL_APPS_HOME !== undefined) return validateHome(environment.SQL_APPS_HOME);
  let candidate = resolve(options.cwd ?? process.cwd());
  let foundation;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      if (pkg.sqlApps?.project === true) return validateHome(candidate);
      if (pkg.name === 'sql-apps') foundation = candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const active = await activeProject(userHome);
  if (active !== undefined) return validateHome(active);
  if (foundation !== undefined) return validateHome(foundation);
  let binding;
  const configuredBinding = join(environment.COPILOT_HOME || join(userHome, '.copilot'), 'sql-apps-local.json');
  try { binding = await readFile(configuredBinding, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (binding !== undefined) {
    const config = JSON.parse(binding);
    if (config.version !== 1 || Object.keys(config).some(key => !['version', 'home'].includes(key))) {
      throw new Error('Invalid SQL Apps local binding; rerun npm run plugin:install from the checkout');
    }
    return validateHome(config.home);
  }
  throw new Error('SQL Apps checkout not configured. Run npm run plugin:install there, or set SQL_APPS_HOME to its absolute path');
}

async function resolveToolHome(options = {}) {
  const environment = options.environment ?? process.env;
  const userHome = resolve(options.userHome ?? homedir());
  const configuredBinding = join(environment.COPILOT_HOME || join(userHome, '.copilot'), 'sql-apps-local.json');
  let binding;
  try { binding = JSON.parse(await readFile(configuredBinding, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('SQL Apps project creation requires an installed foundation binding. Run npm run plugin:install from the SQL Apps foundation checkout.');
    if (error instanceof SyntaxError) throw new Error('Invalid SQL Apps local binding; rerun npm run plugin:install from the foundation checkout.');
    throw error;
  }
  if (binding.version !== 1 || typeof binding.home !== 'string' ||
      Object.keys(binding).some(key => !['version', 'home'].includes(key))) {
    throw new Error('Invalid SQL Apps local binding; rerun npm run plugin:install from the foundation checkout.');
  }
  const home = await validateHome(binding.home);
  const pkg = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'));
  if (pkg.name !== 'sql-apps') throw new Error('The installed SQL Apps binding must point to the foundation checkout, not an application project.');
  return home;
}

export async function dispatchProjects(args, options = {}) {
  const home = await resolveToolHome(options);
  const projectMain = options.projectMain ??
    (await import(pathToFileURL(join(home, 'scripts', 'projects.mjs')).href)).main;
  return projectMain(args, home);
}

export async function workspaceReport(home, options = {}) {
  const inspector = join(home, 'scripts', 'workspace-check.mjs');
  try { await access(inspector); }
  catch (error) {
    throw new Error('Workspace preflight missing from the selected checkout; obtain the updated source before execution.', { cause: error });
  }
  const { checkWorkspace } = await import(pathToFileURL(inspector).href);
  const environment = options.environment ?? process.env;
  const userHome = resolve(options.userHome ?? homedir());
  const pkg = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'));
  let tools = home;
  let foundation = true;
  if (pkg.sqlApps?.project === true) {
    foundation = false;
    let candidate = resolve(options.cwd ?? process.cwd());
    while (true) {
      try {
        const current = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
        if (current.name === 'sql-apps') {
          tools = await validateHome(candidate);
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        tools = await resolveToolHome(options);
        break;
      }
      candidate = parent;
    }
  }
  let source = 'checkout';
  let explicit = false;
  if (environment.SQL_APPS_HOME !== undefined) {
    source = 'environment';
    explicit = true;
  } else if (await activeProject(userHome) === home) {
    source = 'active-project';
    explicit = true;
  } else {
    const configuredBinding = join(environment.COPILOT_HOME || join(userHome, '.copilot'), 'sql-apps-local.json');
    try { await access(configuredBinding); source = 'installed-binding'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return checkWorkspace({
    home,
    activeDirectory: options.cwd ?? process.cwd(),
    bindingSource: source,
    explicitHome: explicit,
    tooling: tools,
    foundation,
  });
}

export async function status(fetcher = fetch, origins = { app: 'http://127.0.0.1:18080', data: 'http://127.0.0.1:15000' }) {
  const services = [];
  for (const [name, url] of [
    ['gateway', `${origins.app}/health/live`],
    ['data-readiness', `${origins.app}/health/ready`],
    ['dab', `${origins.data}/health`],
  ]) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      services.push({ name, url, status: response.status, healthy: response.ok });
    } catch (error) {
      services.push({ name, url, healthy: false, error: error instanceof Error ? error.name : 'UnknownError' });
    }
  }
  return { services, healthy: services.every(service => service.healthy),
    scope: 'HTTP liveness/data readiness only; not SQL authorization or cloud acceptance' };
}

const commands = new Set(['app', 'serve', 'role-based-app', 'role-based-serve',
  'start-sql', 'verify', 'init', 'test', 'data', 'app-test', 'app-check', 'stop',
  'workspace-plan', 'workspace-init', 'recover-sql', 'selected-app', 'selected-serve', 'selected-stop', 'selected-test']);
const consentCommands = new Set(['consent-plan', 'consent-status', 'consent-grant', 'consent-grant-once',
  'consent-terms', 'consent-revoke', 'consent-run']);

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', container = 'sql-apps-sql'] = args;
  if (command === 'projects') {
    if (args.length > 3) throw new Error('Usage: projects <root [absolute-path]|create <name>|list|open <absolute-path>>');
    await dispatchProjects(args.slice(1));
    return;
  }
  const journey = command === 'setup';
  if (!journey && !consentCommands.has(command) && args.length > 2) throw new Error('Expected a command and its optional selection');
  if (command === 'help') {
    console.log('SQL Apps local plugin: projects <root|create|list|open> | home | workspace-check | guide | guide-save <absolute-brief.json> | status | setup-check [existing-sql-container] | ' + [...commands].join(' | '));
    console.log('role-based-setup-check [existing-sql-container] is an alias of setup-check. Local commands use the configured checkout; no cloud deployment command is exposed.');
    console.log('Pre-build consent: consent-plan|consent-status|consent-run <operation> [selection] | consent-grant|consent-grant-once <absolute-plan.json> | consent-terms <absolute-reviewed-document> | consent-revoke [scope|terms]. Record only explicitly approved scopes.');
    console.log('Pre-build journey: setup plan|status|run|resume [--workspace <base-port|legacy>] [--json]; setup approval|approve [--workspace <n>] [--approval <id>] is the one local approval; setup install-plan <tool> | setup install <absolute-reviewed-plan.json>. Install only after explicit approval.');
    return;
  }
  if (!['home', 'workspace-check', 'guide', 'guide-save', 'status', 'setup-check', 'role-based-setup-check', 'setup'].includes(command) && !commands.has(command) && !consentCommands.has(command)) throw new Error(`Unsupported plugin command: ${command}`);
  if (journey) {
    if (args.length > 10) throw new Error('Too many setup arguments');
  } else if (consentCommands.has(command)) {
    if (['consent-plan', 'consent-status', 'consent-run'].includes(command)) {
      if (args.length < 2 || args.length > 3) throw new Error('Provide an operation and its optional selection');
    } else if (command === 'consent-revoke') {
      if (args.length > 2) throw new Error('Provide at most one consent scope');
    } else if (args.length !== 2 || !isAbsolute(container)) throw new Error('Provide one absolute reviewed document/plan path');
  } else if (command === 'guide-save') {
    if (args.length !== 2 || !isAbsolute(container)) throw new Error('Provide an absolute project brief JSON path');
  } else if (command === 'guide') {
    if (args.length !== 1) throw new Error('guide takes no arguments');
  } else if (['selected-app', 'selected-serve', 'selected-test'].includes(command)) {
    if (args.length !== 2 || !isAbsolute(container)) throw new Error('Provide an absolute artifact directory for the selected application');
  } else if (command === 'selected-stop') {
    if (args.length !== 2 || !/^[a-z][a-z0-9-]{0,31}$/.test(container)) throw new Error('Invalid application selection');
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('Invalid SQL container name');
  const home = await resolveHome();
  if (command === 'home') { console.log(home); return; }
  const workspace = await workspaceReport(home);
  if (command === 'workspace-check') {
    console.log(JSON.stringify(workspace, null, 2));
    if (!workspace.executionAllowed) process.exitCode = 1;
    return;
  }
  if (!workspace.executionAllowed) {
    throw new Error(workspace.binding.code === 'EXPLICIT_HOME_REQUIRED' ?
      'Active checkout and installed binding differ. Select an explicit runtime home with SQL_APPS_HOME after reviewing workspace-check.' :
      `Selected runtime source is not ready: ${workspace.bound.code}. ${workspace.nextAction}`);
  }
  if (command === 'status') {
    const result = await status(fetch, workspace.runtime.origins);
    console.log(JSON.stringify({ home, ...result }, null, 2));
    if (!result.healthy) process.exitCode = 1;
    return;
  }
  const guided = command === 'guide' || command === 'guide-save';
  const setup = command === 'setup-check' || command === 'role-based-setup-check';
  const consent = consentCommands.has(command);
  const cli = journey ? join(home, 'scripts', 'setup.mjs') : consent ? join(home, 'scripts', 'local-consent.mjs') : guided ? join(home, 'scripts', 'guide.mjs') :
    setup ? join(home, 'scripts', 'setup-check.mjs') : join(home, 'dist', 'src', 'local-cli.js');
  try { await access(cli); }
  catch (error) {
    throw new Error(journey ? 'Setup coordinator missing from the bound checkout; obtain the updated project.' : consent ? 'Consent commands missing from the bound checkout; obtain the updated project.' : guided ? 'Guide missing from the bound checkout; obtain the updated project.' :
      setup ? 'Setup diagnostic missing from the bound checkout; obtain the updated project.' :
      'Local CLI not built. Review consent-plan build, then after approval use consent-run build in the configured checkout', { cause: error });
  }
  if (!journey && !guided && !setup && !consent && !workspace.bound.build.ready) {
    throw new Error(`Runtime build is not verified: ${workspace.bound.build.code}. ${workspace.bound.build.nextAction}`);
  }
  const childArgs = journey ? [cli, ...args.slice(1)] : consent ? [cli, command.replace('consent-', ''), ...args.slice(1)] :
    guided ? [cli, ...(command === 'guide-save' ? ['--save', container] : []), '--json'] :
    setup ? [cli, '--json', ...(command === 'role-based-setup-check' ? ['--profile', 'role-based-data'] : []),
      ...(args.length === 2 ? ['--container', container] : [])] :
    [cli, command, ...(args.length === 2 ? [container] : [])];
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, childArgs, { cwd: home, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Local CLI terminated by ${signal}`));
      else { process.exitCode = code ?? 1; done(); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Plugin command failed'); process.exitCode = 1; });
}
