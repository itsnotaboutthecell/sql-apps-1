import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, realpath, lstat, mkdir, writeFile } from 'node:fs/promises';
import { totalmem, hostname, release } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { runtimeFor, describeWorkspace } from '../src/workspace.mjs';
import { readSqlSources, roleBasedDabProblem, roleBasedProcedureProblem, roleBasedProfileProblem } from '../src/role-based-rules.mjs';
import { readProjectManifest } from '../src/project-contract.mjs';
import { projectHome, toolingHome } from '../src/tooling-context.mjs';
import { recommendSqlRoutes, resolveSqlTarget } from '../src/sql-target.mjs';
import { loopbackFetch } from '../src/creation-checks.mjs';

const execute = promisify(execFile);
const containerPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function runProbe(command, args, root) {
  const options = { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false };
  if (command === 'npm' && process.platform === 'win32') {
    const { stdout } = await execute('where.exe', ['npm'], options);
    for (const candidate of stdout.trim().split(/\r?\n/)) {
      const cli = join(dirname(candidate), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (await exists(cli)) return (await execute(process.execPath, [cli, ...args], options)).stdout;
    }
    throw new Error('NPM_UNAVAILABLE');
  }
  return (await execute(command, args, options)).stdout;
}

async function portState(port) {
  return new Promise(done => {
    const server = createServer();
    const timer = setTimeout(() => { server.close(); done('unknown'); }, 2000);
    server.once('error', error => {
      clearTimeout(timer);
      done(error.code === 'EADDRINUSE' ? 'occupied' : 'unknown');
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      clearTimeout(timer);
      server.close(() => done('free'));
    });
  });
}

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !options.json) options.json = true;
    else if (args[i] === '--container' && !options.container && containerPattern.test(args[i + 1] ?? '')) options.container = args[++i];
    else if (args[i] === '--profile' && !options.profile && args[i + 1] === 'role-based-data') options.profile = args[++i];
    else if (args[i] === '--workspace' && !options.workspace && (args[i + 1] === 'legacy' || /^\d{5}$/.test(args[i + 1] ?? ''))) options.workspace = args[++i];
    else if (args[i] === '--sql-provider' && !options.sqlProvider && ['container', 'azure', 'express'].includes(args[i + 1])) options.sqlProvider = args[++i];
    else if (args[i] === '--sql-target' && !options.sqlTarget && isAbsolute(args[i + 1] ?? '')) options.sqlTarget = args[++i];
    else throw new Error('Usage: node scripts/setup-check.mjs [--json] [--container <existing-sql-container>] [--profile role-based-data] [--workspace <base-port|legacy>]');
  }
  return options;
}

export async function checkSetup(options = {}, injected = {}, context = {}) {
  const tools = resolve(options.toolingRoot ?? await toolingHome(import.meta.url));
  const root = resolve(options.root ?? (Object.keys(injected).length ? tools : await projectHome()));
  let proposed;
  if (options.workspace !== undefined) {
    if (typeof options.workspace !== 'string' || options.workspace !== 'legacy' && !/^\d{5}$/.test(options.workspace)) {
      throw new Error('Invalid setup workspace selection');
    }
    proposed = describeWorkspace(root, options.workspace === 'legacy' ? 'legacy' : Number(options.workspace));
  }
  const selected = runtimeFor(options.container, root);
  if (proposed && selected.mode !== 'legacy-unselected' &&
      (proposed.mode !== selected.mode || proposed.mode === 'isolated' && proposed.basePort !== selected.ports.gateway)) {
    throw new Error('Requested workspace differs from the existing selection; inspect it without overwriting.');
  }
  const runtime = proposed ? runtimeFor(options.container, root, proposed) : selected;
  const sqlTarget = await resolveSqlTarget(root, runtime.sqlContainer, options);
  const endpoint = sqlTarget.provider !== 'container';
  if (options.container && !containerPattern.test(options.container)) throw new Error('Invalid SQL container name');
  if (options.profile && options.profile !== 'role-based-data') throw new Error('Invalid setup profile');
  const deps = {
    platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
    memoryBytes: totalmem(), read: path => readFile(path, 'utf8'), exists, port: portState, fetch, sqlSources: readSqlSources,
    run: (command, args) => runProbe(command, args, root), ...injected,
  };
  const checks = [];
  const add = (id, status, code, message, nextAction, required = true, toolState) =>
    checks.push({ id, status, code, message, nextAction, required, ...(toolState ? { toolState } : {}) });
  const failedTool = error => error.code === 'ENOENT' ? 'missing' : 'check-failed';
  const pkg = JSON.parse(await deps.read(join(root, 'package.json')));
  if (context.project === true) {
    const [manifest, toolingPackage] = await Promise.all([
      readProjectManifest(root),
      readFile(join(tools, 'package.json'), 'utf8').then(JSON.parse),
    ]);
    if (pkg.dependencies?.['@microsoft/sql-apps'] !== manifest.tooling.version ||
        toolingPackage.version !== manifest.tooling.version) {
      throw new Error('Project package, manifest and installed tooling versions must agree exactly');
    }
    if (toolingPackage.engines?.node !== '>=22 <23 || >=24 <25') {
      throw new Error('Node requirements changed; update the setup diagnostic before using it');
    }
  } else {
    if (pkg.name !== 'sql-apps') throw new Error('Run setup-check from a validated SQL Apps project');
    if (pkg.engines?.node !== '>=22 <23 || >=24 <25') throw new Error('Node requirements changed; update the setup diagnostic before using it');
  }
  if (!['win32', 'darwin', 'linux'].includes(deps.platform)) {
    add('platform', 'action-required', 'PLATFORM_REVIEW_REQUIRED', 'This operating system has no documented local setup route.',
      'Review host/container compatibility before installing anything; do not apply another OS recipe.');
  }
  const supportedNode = /^(22|24)\.\d+\.\d+$/.test(deps.nodeVersion);
  add('node', supportedNode ? 'ready' : 'action-required', supportedNode ? 'NODE_READY' : 'NODE_UNSUPPORTED',
    `Node.js ${deps.nodeVersion}.`, 'Use Node.js 22 or 24 LTS; preserve existing version-manager installations.',
    true, supportedNode ? 'ready' : 'unsupported');
  try {
    if (!/^\d+\.\d+\.\d+\s*$/.test(await deps.run('npm', ['--version']))) throw new Error('invalid version');
    add('npm', 'ready', 'NPM_READY', 'npm is available.', 'No installation needed.', true, 'ready');
  } catch (error) {
    add('npm', 'action-required', 'NPM_UNAVAILABLE', 'npm could not be verified.',
      'Check npm/PATH in a fresh terminal before reinstalling; an existing failing shim is not a missing installation.',
      true, failedTool(error));
  }
  try {
    const sdks = await deps.run('dotnet', ['--list-sdks']);
    if (!sdks.split(/\r?\n/).some(line => Number(/^(\d+)\./.exec(line)?.[1]) >= 8)) {
      add('dotnet', 'action-required', 'SDK_TOO_OLD', '.NET SDK 8 or later is missing (a runtime alone is not sufficient).',
        'Install a compatible .NET SDK using the getting-started guide.', true, 'unsupported');
    } else {
      try {
        const selected = (await deps.run('dotnet', ['--version'])).trim();
        if (!/^\d+\.\d+\.\d+$/.test(selected) || Number(selected.split('.')[0]) < 8) throw new Error('invalid SDK');
        add('dotnet', 'ready', 'SDK_READY', `Selected .NET SDK ${selected}.`, 'SDK selection is valid in this checkout.', true, 'ready');
      } catch {
        add('dotnet', 'action-required', 'SDK_SELECTION_FAILED', 'Installed SDKs do not resolve to a compatible SDK in this checkout.',
          'Review global.json and SDK selection with Copilot; do not silently replace it.', true, 'check-failed');
      }
    }
  } catch (error) {
    add('dotnet', 'action-required', 'SDK_UNAVAILABLE', '.NET SDK could not be checked.',
      'Check the SDK/PATH in a fresh terminal; install the SDK, not just the runtime, only if missing.',
      true, failedTool(error));
  }
  if (endpoint) {
    try {
      const lines = (await deps.run('dotnet', ['--list-runtimes'])).split(/\r?\n/).filter(line => line.trim());
      const runtimes = lines.map(line => /^(\S+)\s+(\d+\.\d+\.\d+(?:[-+]\S+)?)\s+\[.+\]\s*$/.exec(line));
      if (runtimes.some(runtime => !runtime)) throw new Error('Unrecognized runtime listing');
      const missing = ['Microsoft.NETCore.App', 'Microsoft.AspNetCore.App'].filter(name =>
        !runtimes.some(runtime => runtime[1] === name && /^8\.0\.\d+$/.test(runtime[2])));
      add('host-dab-runtime', missing.length ? 'action-required' : 'ready',
        missing.length ? 'HOST_DAB_RUNTIME_MISSING' : 'HOST_DAB_RUNTIME_READY',
        missing.length ? `Host DAB 2.0.12 requires the missing .NET 8 runtimes: ${missing.join(', ')}.` :
          'Host DAB .NET and ASP.NET Core 8 runtimes are installed.',
        missing.length ? 'Approve this SQL target selection first if not saved, then review setup install-plan dotnet for side-by-side SDK 8 installation; preserve existing SDKs.' :
          'No host runtime installation needed.', true, missing.length ? 'missing' : 'ready');
    } catch (error) {
      add('host-dab-runtime', 'action-required', 'HOST_DAB_RUNTIME_UNVERIFIED',
        'Host DAB .NET 8 runtimes could not be verified.',
        'Review dotnet --list-runtimes and PATH before approving an installation; an unknown probe failure is not a missing runtime.',
        true, failedTool(error));
    }
  }
  let engine;
  if (!endpoint) {
  try {
    if (!/^Docker version \d+\.\d+\.\d+/i.test((await deps.run('docker', ['--version'])).trim())) throw new Error('invalid Docker version');
    add('docker-cli', 'ready', 'DOCKER_CLI_READY', 'Docker CLI is available.', 'Check the engine below.', true, 'ready');
    try {
      const result = JSON.parse(await deps.run('docker', ['info', '--format',
        '{"OSType":{{json .OSType}},"Architecture":{{json .Architecture}},"MemTotal":{{json .MemTotal}}}']));
      if (result.OSType !== 'linux' || typeof result.Architecture !== 'string') {
        add('docker-engine', 'action-required', 'LINUX_ENGINE_REQUIRED', 'A Linux container engine could not be verified.',
          'Switch Docker to Linux containers; Windows containers cannot run this stack.');
      } else {
        engine = result;
        add('docker-engine', 'ready', 'DOCKER_ENGINE_READY', `Linux Docker engine (${result.Architecture}) is responding.`,
          'No engine restart needed.');
      }
    } catch {
      add('docker-engine', 'action-required', 'DOCKER_NOT_RUNNING', 'Docker engine did not respond with valid information.',
        'Start Docker Desktop or ask for help with the Linux service/socket permissions, then check again.');
    }
  } catch (error) {
    add('docker-cli', 'action-required', 'DOCKER_UNAVAILABLE', 'Docker CLI could not be verified.',
      'Check Docker/PATH before reinstalling; follow the OS-specific guide and review license eligibility.',
      true, failedTool(error));
    add('docker-engine', 'not-checked', 'ENGINE_NOT_CHECKED', 'Engine not checked without Docker CLI.', 'Install/start Docker, then retry.');
  }
  add('capacity', 'ready', 'CAPACITY_INFORMATION', `Host memory: ${Math.round(deps.memoryBytes / 1024 ** 3)} GiB; ` +
    (Number.isFinite(engine?.MemTotal) ? `Docker memory: ${Math.round(engine.MemTotal / 1024 ** 3)} GiB.` : 'Docker memory not available.'),
  'Check official Docker requirements and available disk space; download/build sizes vary. This is not a capacity certification.', false);
  const emulated = engine && !['amd64', 'x86_64'].includes(engine.Architecture) || !['x64', 'amd64'].includes(deps.architecture);
  add('sql-platform', 'ready', emulated ? 'SQL_X64_EMULATION' : 'SQL_X64_NATIVE',
    emulated ? 'The SQL preview requires x64 emulation on this host.' : 'Host architecture matches the x64 SQL preview.',
    emulated ? 'The existing launcher requests linux/amd64; verify Docker supports emulation before starting.' : 'No emulation configuration expected.', false);
  if (engine) {
    if (options.container) {
      try {
        const state = JSON.parse(await deps.run('docker', ['container', 'inspect', options.container, '--format',
          '{"status":{{json .State.Status}},"owner":{{json (index .Config.Labels "sql-apps.local")}},"image":{{json .Config.Image}}}']));
        const running = state.status === 'running';
        add('sql-image', running ? 'ready' : 'action-required', running ? 'SQL_CONTAINER_SELECTED' : 'SQL_CONTAINER_STOPPED',
          running ? 'Selected SQL container is running; its engine is not yet verified.' : 'Selected SQL container is not running.',
          'Obtain approval to reuse it and run local verify to check EngineEdition 5. Never replace/restart an unowned container automatically.');
      } catch {
        add('sql-image', 'action-required', 'SQL_CONTAINER_UNAVAILABLE', 'Selected container could not be inspected.',
          'Confirm the container name with its owner. Do not create a replacement under that name.');
      }
    } else {
      const source = await deps.read(context.project === true
        ? join(tools, 'dist', 'src', 'local.js')
        : join(root, 'src', 'local.ts'));
      const image = /const sqlImage = '([^']+)';/.exec(source)?.[1];
      if (!image) throw new Error('Cannot locate the project SQL image; update setup-check for the current runtime');
      try {
        const cached = JSON.parse(await deps.run('docker', ['image', 'inspect', image, '--format',
          '[{"Architecture":{{json .Architecture}},"Os":{{json .Os}}}]']));
        if (!Array.isArray(cached) || cached[0]?.Architecture !== 'amd64' || cached[0]?.Os !== 'linux') throw new Error('wrong image platform');
        add('sql-image', 'ready', 'SQL_IMAGE_CACHED', 'Project SQL preview image is cached locally.',
          'No registry download is needed for this image. Engine identity is verified during startup.');
      } catch {
        add('sql-image', 'action-required', 'SQL_IMAGE_ACCESS_REQUIRED', 'Project SQL preview image could not be verified in the local cache.',
          'Follow the official preview signup/registry access steps, or select an existing verified Azure SQL container. Do not paste credentials into chat.');
      }
    }
  } else add('sql-image', 'not-checked', 'SQL_NOT_CHECKED', 'SQL image/container not checked without the engine.', 'Start Docker, then rerun setup-check.');
  } else {
    add('sql-endpoint', 'ready', 'SQL_ENDPOINT_SELECTED', `Selected ${sqlTarget.provider} development database ${sqlTarget.database}.`,
      'Selection is not SQL readiness; startup verifies the approved engine/database and least-privilege principal.');
    if (sqlTarget.provider === 'express' && (deps.platform !== 'win32' || deps.architecture !== 'x64')) {
      add('sql-platform', 'action-required', 'EXPRESS_HOST_UNSUPPORTED', 'SQL Server 2025 Express requires Windows x64.', 'Select Azure SQL on this host.');
    } else if (sqlTarget.provider === 'express') {
      try {
        const helper = join(tools, await exists(join(tools, 'assets', 'runtime-contract.json')) ? 'assets' : '', 'scripts', 'sql-express.ps1');
        const inventory = JSON.parse(await deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', 'Inspect']));
        if (inventory.supported !== true) throw new Error('Express host requirements are unsupported or unverifiable.');
        if (!Array.isArray(inventory.instances)) throw new Error('invalid Express inventory');
        const instance = inventory.instances.find(item => item.instance?.toLowerCase() === sqlTarget.instance.toLowerCase());
        if (!instance) add('sql-express', 'action-required', 'EXPRESS_MISSING', 'The selected Express instance was not found.',
          'Review setup install-plan sql-express; only after approval run its exact installation plan, then separately review configure-express.', true, 'missing');
        else if (instance.majorVersion !== 17 || !/^Express Edition(?:\s|$)/.test(instance.edition)) add('sql-express', 'action-required', 'EXPRESS_VERSION_UNSUPPORTED',
          'The selected instance is not SQL Server 2025 Express.', 'Select a supported instance or Azure SQL. Do not upgrade or overwrite this instance automatically.', true, 'unsupported');
        else if (instance.verified && (instance.containedAuthentication !== 1 || !instance.loopbackPorts?.includes(sqlTarget.port))) {
          add('sql-express', 'action-required', 'EXPRESS_CONFIGURATION_REVIEW_REQUIRED', 'SQL Server 2025 Express identity verified; contained authentication or the selected loopback TCP configuration needs review.',
            'First approve the selected setup target, then review consent plan configure-express and grant it once. Run local configure-express only after specific approval for instance-wide containment, loopback TCP and restart. No changes were attempted.');
        } else if (instance.verified && instance.integratedSecurityOnly !== 0) {
          add('sql-express', 'action-required', 'EXPRESS_SQL_AUTHENTICATION_REVIEW_REQUIRED',
            'The contained runtime user requires SQL authentication; the selected instance is Windows-only or its authentication mode is unverified.',
            'Review consent plan configure-express-auth and grant it once only after approving instance-wide mixed mode and restart. This does not enable SA or create a server-level app login. No changes were attempted.');
        } else add('sql-express', instance.verified ? 'ready' : 'action-required', instance.verified ? 'EXPRESS_IDENTITY_VERIFIED' : 'EXPRESS_IDENTITY_UNVERIFIED',
          'Express registration was found; SQL identity verification is reported separately.',
          instance.verified ? 'Startup also verifies the selected loopback port, database and app principal. Containment/TCP/service changes require a separate configure-express grant-once.' :
            'Inspect the named Windows-authenticated instance and permissions before startup; no installation or restart was attempted.',
          true, instance.verified ? 'ready' : 'check-failed');
      } catch (error) {
        add('sql-express', 'action-required', 'EXPRESS_INSPECTION_FAILED', 'Express inspection could not complete.',
          `Review PowerShell policy and existing instances (${error.code ?? 'PROBE_FAILED'}); do not install over unknown state.`, true, 'check-failed');
      }
    }
    if (sqlTarget.provider === 'azure') {
      try {
        const account = JSON.parse(await deps.run('az', ['account', 'show', '--query', '{id:id,tenantId:tenantId}', '-o', 'json']));
        if (account.id !== sqlTarget.subscriptionId || account.tenantId !== sqlTarget.tenantId) throw new Error('account mismatch');
        add('azure-account', 'ready', 'AZURE_ACCOUNT_SELECTED', 'Azure CLI account matches the approved SQL target.', 'No login or resource changes were performed.');
      } catch {
        add('azure-account', 'action-required', 'AZURE_ACCOUNT_REVIEW_REQUIRED', 'Azure CLI/login/account selection could not be verified.',
          'Review official Azure CLI installation/login and select the intended subscription/tenant explicitly, or offer Express. No login was attempted.');
      }
    }
  }
  let containers = [];
  if (engine) {
    try {
      const output = await deps.run('docker', ['ps', '--format', '{"owner":{{json (.Label "sql-apps.local")}},"workspace":{{json (.Label "sql-apps.workspace")}},"ports":{{json .Ports}}}']);
      containers = output.trim() ? output.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
      if (containers.some(value => typeof value.owner !== 'string' || typeof value.ports !== 'string')) throw new Error('invalid container list');
    } catch {
      add('ownership', 'not-checked', 'OWNERSHIP_NOT_CHECKED', 'Existing Docker port ownership could not be checked.',
        'Inspect only safe project ownership labels before reusing services.', false);
    }
  }
  const ports = [[runtime.ports.gateway, null], [runtime.ports.data, 'data']];
  if (runtime.ports.internalGateway) ports.push([runtime.ports.internalGateway, null]);
  for (const [port, owner] of ports) {
    const state = await deps.port(port);
    if (state === 'free') add(`port-${port}`, 'ready', 'PORT_FREE', `Local port ${port} is free.`, 'Available for application startup.');
    else if (state === 'occupied' && owner && endpoint) add(`port-${port}`, 'ready', 'HOST_SERVICE_OWNERSHIP_PENDING',
      `Host data port ${port} is occupied; runtime ownership still needs verification.`, 'Startup/serve must match the recorded process start, target and configuration before reuse.', false);
    else if (state === 'occupied' && owner && containers.some(value => value.owner === owner &&
      (runtime.mode !== 'isolated' || value.workspace === runtime.id) &&
      new RegExp(`127\\.0\\.0\\.1:${port}->`).test(value.ports))) {
      add(`port-${port}`, 'ready', 'OWNED_SERVICE_RUNNING', `Port ${port} is used by a labeled project service.`,
        'Check the intended checkout/container before reuse; a label alone does not prove readiness.');
    } else {
      let healthy = false;
      if ([runtime.ports.gateway, runtime.ports.internalGateway].includes(port) && state === 'occupied') {
        try {
          const response = port === runtime.ports.internalGateway && !injected.fetch
            ? await loopbackFetch(`http://127.0.0.1:${port}/health/live`, { headers: { host: new URL(runtime.origins.app).host }, signal: AbortSignal.timeout(2000) })
            : await deps.fetch(`${runtime.origins.app}/health/live`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
          await response.text();
          healthy = response.ok || runtime.ports.internalGateway && response.status === 503 && response.headers.get('x-sql-apps-creation') === 'pending';
        } catch { healthy = false; }
      }
      add(`port-${port}`, 'action-required', healthy ? 'EXISTING_GATEWAY_CHECK_OWNERSHIP' : state === 'occupied' ? 'PORT_OCCUPIED' : 'PORT_NOT_CHECKED',
        healthy ? `An existing gateway responds on port ${port}; its ownership is unverified.` : `Port ${port} is occupied or could not be checked.`,
        'Identify the existing process/service with the user. Reuse only the intended application; never kill it automatically.');
    }
  }
  {
    const guidance = 'Copy role-based-data.example.json to role-based-data.json, choose your application role and read-only readiness path, then implement that procedure and its DAB entity (docs/reference/role-based-data.md).';
    let text;
    try { text = await deps.read(join(root, 'role-based-data.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (text === undefined) {
      add('role-based-config', 'action-required', 'ROLE_BASED_CONFIG_MISSING', 'role-based-data.json is not configured yet.', guidance, false);
    } else {
      let config;
      try { config = JSON.parse(text); } catch { config = undefined; }
      const problem = config === undefined ? 'role-based-data.json is not valid JSON.' : roleBasedProfileProblem(config);
      let dabProblem;
      let procedureProblem;
      if (!problem) {
        let dab;
        try { dab = JSON.parse(await deps.read(join(root, 'dab', 'dab-config.json'))); dabProblem = roleBasedDabProblem(dab, config); }
        catch (error) { if (error.code && error.code !== 'ENOENT') throw error; dabProblem = 'dab/dab-config.json is missing or not valid JSON.'; }
        if (!dabProblem) procedureProblem = roleBasedProcedureProblem(dab, await deps.sqlSources(root));
      }
      if (problem) add('role-based-config', 'action-required', 'ROLE_BASED_CONFIG_INVALID', problem, guidance, false);
      else if (dabProblem) add('role-based-config', 'action-required', 'ROLE_BASED_DAB_INVALID', dabProblem,
        'Edit dab/dab-config.json to list only your stored-procedure entities, as shown in docs/reference/role-based-data.md, then rerun setup plan.', false);
      else if (procedureProblem) add('role-based-config', 'action-required', 'ROLE_BASED_PROCEDURE_MISSING', procedureProblem,
        'Add each procedure (CREATE PROCEDURE schema.name) to the SQL project under sql/, or remove its DAB entity, then rerun setup plan.', false);
      else add('role-based-config', 'ready', 'ROLE_BASED_CONFIG_READY',
        `role-based-data.json requires ${config.requiredRole}; DAB serves ${config.readinessPath}.`,
        'Startup still checks that the readiness procedure exists and responds.', false);
    }
  }
  let compilerPackage = join(root, 'node_modules', 'typescript', 'package.json');
  if (context.project === true) {
    for (const location of [root, tools]) {
      try {
        compilerPackage = createRequire(join(location, 'package.json')).resolve('typescript/package.json');
        break;
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
      }
    }
  }
  for (const [id, path, action] of [
    ['dependencies', relative(root, compilerPackage),
    'After approval, use consent-run restore (guarded npm ci) from this project. Initial downloads need internet.'],
    ['build', 'dist/src/local-cli.js', 'After dependencies and approval, use consent-run build (the guarded build).'],
  ]) {
    const present = await deps.exists(join(root, path));
    add(id, present ? 'ready' : 'action-required', present ? `${id.toUpperCase()}_PRESENT` : `${id.toUpperCase()}_MISSING`,
      present ? `${id} files are present (not a freshness/correctness check).` : `${id} files are missing.`, action, false);
  }
  const image = checks.find(check => check.id === 'sql-image');
  const sqlRoutes = recommendSqlRoutes([
    { provider: 'container', availability: image?.status === 'ready' ? 'ready' :
      ['SQL_IMAGE_ACCESS_REQUIRED', 'SQL_NOT_CHECKED'].includes(image?.code) ? 'unavailable' : 'unknown',
      code: image?.code ?? 'SQL_NOT_CHECKED',
      nextAction: image?.nextAction ?? 'Inspect container readiness before selecting a different database.' },
    { provider: 'azure', availability: 'action-required', code: 'AZURE_SQL_REVIEW_REQUIRED',
      nextAction: 'Offer a selected Azure SQL development database or explicitly approved database-only provisioning; review access, data use and costs first. This does not publish the app.' },
    { provider: 'express', availability: deps.platform === 'win32' && deps.architecture === 'x64' ? 'action-required' : 'unavailable',
      code: deps.platform === 'win32' && deps.architecture === 'x64' ? 'EXPRESS_REVIEW_REQUIRED' : 'EXPRESS_HOST_UNSUPPORTED',
      nextAction: 'Last resort: detect SQL Server 2025 Express on supported Windows x64, then review reuse or installation. Never automatically upgrade an older instance.' },
  ], endpoint || options.container || options.sqlTarget || options.sqlProvider ||
    await exists(join(root, '.sql-apps', 'sql-target.json')) ? sqlTarget.provider : undefined);
  return { version: 1, platform: deps.platform, architecture: deps.architecture, root, home: root, sqlRoutes,
    workspace: { id: runtime.id, mode: runtime.mode, ports: runtime.ports, origins: runtime.origins },
    ready: checks.filter(check => check.required).every(check => check.status === 'ready'), checks,
    scope: 'Read-only prerequisite check, not SQL authorization, complete offline-cache, ownership or runtime acceptance. See docs/guides/getting-started.md.' };
}

export async function inspectDependencies(home, probe = (command, args) => runProbe(command, args, home)) {
  const pkg = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(home, 'package-lock.json'), 'utf8'));
  const tools = JSON.parse(await readFile(join(home, '.config', 'dotnet-tools.json'), 'utf8'));
  const require = createRequire(join(home, 'package.json'));
  const checks = [];
  let probeTimedOut = false;
  const timedOut = error => Boolean(error?.killed);
  // Cold dotnet/npm starts after idle can exceed the probe timeout; retry once and keep timeouts distinct from broken tools.
  const patientProbe = async (command, args) => {
    try { return await probe(command, args); }
    catch (error) { if (!timedOut(error)) throw error; }
    return probe(command, args);
  };
  const timeoutAction = 'The readiness probe timed out twice; this is not evidence of a missing dependency. Rerun setup plan before approving any restore.';
  for (const group of ['dependencies', 'devDependencies']) {
    const declared = pkg[group] ?? {};
    const locked = lock.packages?.['']?.[group] ?? {};
    if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(locked).sort())) {
      checks.push({ id: group, ready: false, code: 'LOCKFILE_MISMATCH' });
    }
    for (const name of Object.keys(declared)) {
      try {
        const installed = JSON.parse(await readFile(join(home, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
        const version = lock.packages?.[`node_modules/${name}`]?.version;
        const subpathOnly = installed.exports !== null && typeof installed.exports === 'object' &&
          !Array.isArray(installed.exports) && Object.keys(installed.exports).length > 0 &&
          Object.keys(installed.exports).every(key => key.startsWith('./'));
        if (installed.bin) {
          const bins = typeof installed.bin === 'string' ? [installed.bin] : Object.values(installed.bin);
          if (bins.length === 0 || bins.some(bin => typeof bin !== 'string' || !bin || isAbsolute(bin) || bin.split(/[\\/]/).includes('..'))) {
            throw new Error(`Invalid executable paths in ${name}`);
          }
          const packageRoot = await realpath(join(home, 'node_modules', ...name.split('/')));
          for (const bin of bins) {
            const executable = await realpath(join(packageRoot, bin));
            const contained = relative(packageRoot, executable);
            if (!contained || contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
                contained === '..' || isAbsolute(contained) || !(await lstat(executable)).isFile()) {
              throw new Error(`Invalid executable paths in ${name}`);
            }
          }
        }
        if (!installed.bin || installed.main || installed.exports && !subpathOnly) {
          const entry = require.resolve(name.startsWith('@types/') ? `${name}/package.json` : name);
          await access(entry);
        }
        checks.push({ id: name, ready: typeof version === 'string' && installed.name === name && installed.version === version,
          code: installed.version === version ? 'PACKAGE_RESOLVED' : 'PACKAGE_VERSION_MISMATCH' });
      } catch (error) {
        if (!['ENOENT', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
        checks.push({ id: name, ready: false, code: 'PACKAGE_UNRESOLVED' });
      }
    }
  }
  if (checks.every(check => check.ready)) {
    try {
      const tree = JSON.parse(await patientProbe('npm', ['ls', '--all', '--json', '--offline']));
      const valid = node => node && typeof node === 'object' && !Array.isArray(node) &&
        !node.missing && !node.invalid && (!node.problems || Array.isArray(node.problems) && node.problems.length === 0) &&
        Object.values(node.dependencies ?? {}).every(valid);
      checks.push({ id: 'npm-tree', ready: valid(tree), code: valid(tree) ? 'NPM_TREE_VERIFIED' : 'NPM_TREE_UNVERIFIED' });
    } catch (error) {
      if (timedOut(error)) {
        probeTimedOut = true;
        checks.push({ id: 'npm-tree', ready: false, code: 'NPM_TREE_PROBE_TIMEOUT', nextAction: timeoutAction });
      } else {
        checks.push({ id: 'npm-tree', ready: false, code: 'NPM_TREE_UNVERIFIED',
          nextAction: 'Inspect npm ls --all --json --offline before approving dependency restore.' });
      }
    }
  }
  const npmReady = checks.every(check => check.ready);
  const sqlChecks = [];
  for (const [name, tool] of Object.entries(tools.tools ?? {})) {
    if (!Array.isArray(tool.commands) || tool.commands.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(tool.commands[0]) ||
        !/^\d+\.\d+\.\d+$/.test(tool.version) || tool.commands[0] !== 'sqlpackage') {
      throw new Error('Unsupported SQL tool manifest; review setup diagnostics');
    }
    try {
      const output = await patientProbe('dotnet', ['tool', 'run', tool.commands[0], '--', '/Version']);
      sqlChecks.push({ id: name, ready: [tool.version, `${tool.version}.0`].includes(output.trim()), code: 'SQL_TOOL_VERSION_CHECKED' });
    } catch (error) {
      if (timedOut(error)) {
        probeTimedOut = true;
        sqlChecks.push({ id: name, ready: false, code: 'SQL_TOOL_PROBE_TIMEOUT', nextAction: timeoutAction });
      } else {
        sqlChecks.push({ id: name, ready: false, code: 'SQL_TOOL_UNAVAILABLE',
          nextAction: 'Review dotnet tool restore and required runtimes; a failed probe does not authorize a system install.' });
      }
    }
  }
  const sqlToolsReady = sqlChecks.length > 0 && sqlChecks.every(check => check.ready);
  return { ready: npmReady && sqlToolsReady, npmReady, sqlToolsReady, probeTimedOut, checks: [...checks, ...sqlChecks] };
}

export async function runSetupCommand(file, args, home) {
  await new Promise((done, reject) => {
    const child = spawn(file, args, { cwd: home, shell: false, windowsHide: true,
      stdio: ['inherit', 2, 2], env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('Setup command timed out; inspect any active installer before retrying.'), { code: 'ETIMEDOUT' }));
    }, 15 * 60 * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) reject(Object.assign(new Error('Setup command failed; review process output.'), { code, signal }));
      else done();
    });
  });
}

async function setupHost() {
  const host = { name: hostname(), platform: process.platform, architecture: process.arch, release: release() };
  if (process.platform === 'linux') {
    const content = await readFile('/etc/os-release', 'utf8');
    host.distro = /^ID=["']?([^"'\r\n]+)["']?$/m.exec(content)?.[1] ?? 'unknown';
    host.distroVersion = /^VERSION_ID=["']?([^"'\r\n]+)["']?$/m.exec(content)?.[1] ?? 'unknown';
  }
  return host;
}

export async function planInstallation(value, tool, injected = {}) {
  const home = await realpath(value);
  if (!['node', 'npm', 'dotnet', 'docker', 'sql-express'].includes(tool)) throw new Error('Choose node, npm, dotnet, docker or sql-express; cloud tools are not local prerequisites.');
  const host = injected.host ?? await setupHost();
  const probe = injected.probe ?? ((file, args) => runProbe(file, args, home));
  if (tool === 'sql-express') {
    const tools = await toolingHome(import.meta.url);
    const helper = join(tools, await exists(join(tools, 'assets', 'runtime-contract.json')) ? 'assets' : '', 'scripts', 'sql-express.ps1');
    const plan = { version: 1, planId: randomUUID(), home, host, tool,
      source: 'https://www.microsoft.com/en-us/download/details.aspx?id=108836', outcome: 'manual', command: null,
      installer: { version: '17.0.1000.7',
        url: 'https://download.microsoft.com/download/7ab8f535-7eb8-4b16-82eb-eca0fa2d38f3/SQL2025-SSEI-Expr.exe',
        sha256: '1C677A33B318481C3217128835F8405CF0026621DCD04B13EB6CB0982E823F27',
        arguments: ['/IACCEPTSQLSERVERLICENSETERMS', '/ENU', '/ACTION=Install', '/quiet', '/InstallPath="C:\\Program Files\\Microsoft SQL Server"'] },
      helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'),
      effects: ['Install SQL Server 2025 Express and its Windows service using the Microsoft bootstrapper; download media and write outside this checkout.',
        'The exact helper command accepts SQL Server license terms: https://aka.ms/useterms. Review and explicitly accept them before approving this installation.',
        'Review Microsoft privacy terms (https://privacy.microsoft.com/privacystatement). Cache the verified bootstrapper under current-user LocalAppData\\SqlApps\\Installers; SQL setup downloads additional media and writes Windows installer logs.',
        'Requires an approved administrator terminal/UAC interaction; never self-elevates, reboots, upgrades an older instance or opens firewall ports.',
        'Creates the default SQLEXPRESS instance. Existing instance registration prevents installation. Containment, loopback TCP and service restart need separate configuration approval.'],
      nextAction: 'SQL Express requires supported Windows x64. Reuse a compatible instance or review installation; other platforms should use Azure SQL.' };
    if (host.platform !== 'win32' || host.architecture !== 'x64') return plan;
    let inventory;
    try { inventory = JSON.parse(await probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', 'Inspect'])); }
    catch (error) { return { ...plan, nextAction: `Express inventory failed (${error.code ?? 'INSPECTION_FAILED'}); inspect the existing installation/PowerShell policy before retrying. No installation was attempted.` }; }
    if (inventory?.supported !== true || !Array.isArray(inventory.instances) ||
        inventory.instances.some(item => typeof item?.instance !== 'string' || !Number.isInteger(item.majorVersion) || typeof item.edition !== 'string')) {
      return { ...plan, nextAction: 'Express inventory is unsupported or malformed; no installation is authorized.' };
    }
    const compatible = inventory.instances.filter(item => item.majorVersion === 17 && /^Express Edition(?:\s|$)/.test(item.edition));
    if (compatible.length) return { ...plan, outcome: compatible.every(item => item.verified === true) ? 'ready' : 'manual', instances: compatible,
      nextAction: 'Compatible Express registration found. Select and verify its actual SQL identity/loopback endpoint; no installation is needed or authorized. Unverified SQL probes require diagnosis, never reinstallation.' };
    if (inventory.instances.some(item => item.instance.toUpperCase() === 'SQLEXPRESS')) return { ...plan,
      nextAction: 'SQLEXPRESS already exists but is not a compatible SQL Server 2025 Express registration. Diagnose/reuse explicitly; never install over or automatically upgrade it.' };
    return { ...plan, outcome: 'approval-required', command: { file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', 'Install'] },
      nextAction: 'Review the pinned source/hash, license and administrator/service effects. Only after explicit approval, execute the absolute reviewed plan through setup install; then select and separately approve instance configuration.' };
  }
  const report = await (injected.report ?? (() => checkSetup({ root: home })))();
  let state = report.checks.find(check => check.id === (tool === 'docker' ? 'docker-cli' : tool))?.toolState;
  if (tool === 'dotnet' && state === 'ready') {
    state = report.checks.find(check => check.id === 'host-dab-runtime')?.toolState ?? state;
  }
  const source = tool === 'docker' ? 'https://docs.docker.com/get-started/get-docker/' :
    tool === 'dotnet' ? 'https://learn.microsoft.com/dotnet/core/install/' : 'https://nodejs.org/en/download';
  const plan = { version: 1, planId: randomUUID(), home, host, tool, source, outcome: 'manual', command: null,
    effects: [], nextAction: 'Review the official installer for this OS/CPU. Preserve existing tools; reopen the terminal and check setup again.' };
  if (state === 'ready') return { ...plan, outcome: 'ready', nextAction: 'No installation needed.' };
  if (state !== 'missing') return { ...plan,
    nextAction: 'Resolve the installed tool/version/PATH check before installing. Do not overwrite a version manager or broken shim.' };
  if (tool === 'node' || tool === 'npm') return { ...plan,
    nextAction: 'Bootstrap Node 22 or 24 with npm through an explicitly approved official installer, preserving version managers. This Node command cannot install its own missing runtime.' };
  let command;
  try {
    if (host.platform === 'win32') {
      if (!/^v?\d+\.\d+\.\d+/i.test((await probe('winget', ['--version'])).trim())) {
        return { ...plan, nextAction: 'WinGet returned no recognizable version; resolve its check before installing.' };
      }
      command = { file: 'winget', args: ['install', '--exact', '--id',
        tool === 'dotnet' ? 'Microsoft.DotNet.SDK.8' : 'Docker.DockerDesktop', '--source', 'winget', '--disable-interactivity'] };
    } else if (host.platform === 'darwin') {
      if (!/^Homebrew \d+\.\d+\.\d+/i.test((await probe('brew', ['--version'])).trim())) {
        return { ...plan, nextAction: 'Homebrew returned no recognizable version; resolve its check before installing.' };
      }
      command = { file: 'brew', args: ['install', '--cask', tool === 'dotnet' ? 'dotnet-sdk@8' : 'docker-desktop'] };
    } else if (host.platform === 'linux') {
      const suite = { ubuntu: { '22.04': 'jammy', '24.04': 'noble' }, debian: { '12': 'bookworm', '13': 'trixie' } }[host.distro]?.[host.distroVersion];
      if (!suite) return plan;
      const name = tool === 'dotnet' ? 'dotnet-sdk-8.0' : 'docker-ce';
      const policy = await probe('apt-cache', ['policy', name]);
      const candidate = /^\s*Candidate:\s*(\S+)$/m.exec(policy)?.[1];
      if (!candidate || !/^[0-9][a-zA-Z0-9.+:~_-]*$/.test(candidate)) return plan;
      const lines = policy.split(/\r?\n/);
      const start = lines.findIndex(line => new RegExp(`^\\s+(?:\\*\\*\\*\\s+)?${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+\\s*$`).test(line));
      const origins = [];
      for (const line of start < 0 ? [] : lines.slice(start + 1)) {
        if (/^\s+(?:\*\*\*\s+)?\S+\s+\d+\s*$/.test(line)) break;
        const origin = /^\s+\d+\s+(https?:\/\/\S+)\s+(\S+)/.exec(line);
        if (origin) origins.push({ url: new URL(origin[1]), suite: origin[2] });
      }
      const trusted = origin => {
        const { url } = origin;
        if (url.username || url.password || url.port || !new RegExp(`^${suite}(?:-updates|-security|-backports)?/`).test(origin.suite)) return false;
        const path = url.pathname.replace(/\/$/, '');
        if (tool === 'docker') return url.protocol === 'https:' && url.hostname === 'download.docker.com' &&
          path === `/linux/${host.distro}`;
        if (url.hostname === 'packages.microsoft.com') return url.protocol === 'https:' &&
          path === `/${host.distro}/${host.distroVersion}/prod`;
        return host.distro === 'ubuntu' &&
          (['archive.ubuntu.com', 'security.ubuntu.com'].includes(url.hostname) && path === '/ubuntu' ||
            url.hostname === 'ports.ubuntu.com' && path === '/ubuntu-ports');
      };
      if (!origins.length || !origins.every(trusted) || tool === 'dotnet' && !/^8\./.test(candidate)) return plan;
      command = { file: 'sudo', args: ['-n', 'apt-get', 'install', '--no-upgrade', '--', `${name}=${candidate}`] };
    } else return plan;
  } catch (error) {
    if (error.code === 'ENOENT') return { ...plan, nextAction: 'Package manager is missing. Use the official installer; do not install a manager implicitly.' };
    return { ...plan, nextAction: 'Package-manager inspection failed. Review its version/repository check before installing; no changes were made.' };
  }
  return { ...plan, outcome: 'approval-required', command,
    effects: ['Download and install the named system package and its dependencies; write outside the checkout.',
      'May require administrator authentication, terminal/editor restart or manual installer/license completion.',
      ...(tool === 'docker' ? ['Review Docker licensing and networking/service effects before approval. Do not auto-accept terms, enable WSL or reboot.'] : []),
      ...(tool === 'dotnet' ? ['Install the SDK 8 servicing line side-by-side, including .NET and ASP.NET Core 8 runtimes; preserve existing SDKs and re-probe afterward.'] : [])],
    nextAction: 'Review this entire plan. Only after explicit approval, save it outside tracked source and run setup install with that absolute plan path.' };
}

export async function installReviewed(path, value, injected = {}) {
  const home = await realpath(value);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Reviewed installation plan must be a bounded regular JSON file.');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Reviewed installation plan is too large.');
  const approved = JSON.parse(text.replace(/^\uFEFF/, ''));
  const current = await planInstallation(home, approved.tool, injected);
  const contract = plan => JSON.stringify({ ...plan, planId: undefined });
  if (!/^[a-f0-9-]{36}$/.test(approved.planId ?? '') || contract(approved) !== contract(current) ||
      current.outcome !== 'approval-required') throw new Error('Installation plan changed or is stale; recheck and review a new plan.');
  const directory = join(home, '.sql-apps');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Installation state must not be a symlink.');
  try {
    await writeFile(join(directory, `install-${approved.planId}.json`),
      JSON.stringify({ version: 1, consumedAt: new Date().toISOString(), tool: approved.tool,
        contract: createHash('sha256').update(contract(approved)).digest('hex') }),
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Installation approval was already consumed; review a new plan before retrying.');
    throw error;
  }
  try { await (injected.runner ?? runSetupCommand)(current.command.file, current.command.args, home); }
  catch (error) {
    if (approved.tool === 'sql-express' && error.code === 3010) return {
      version: 1, planId: approved.planId, ready: false, outcome: 'restart-required', code: 'INSTALL_RESTART_REQUIRED',
      nextAction: 'SQL Express requires a user-approved restart. Do not reinstall; inspect status after the restart and review configuration separately.',
    };
    return { version: 1, planId: approved.planId, ready: false, outcome: 'failed',
      code: error.code === 'ETIMEDOUT' ? 'INSTALL_TIMEOUT' : error.code === 'ENOENT' ? 'INSTALLER_UNAVAILABLE' : 'INSTALL_FAILED',
      nextAction: 'Inspect installer output, permissions, network and any active installer. Approval was consumed; retry only after reviewing a new plan.' };
  }
  const after = await planInstallation(home, approved.tool, injected);
  return { version: 1, planId: approved.planId, ready: after.outcome === 'ready',
    outcome: after.outcome === 'ready' ? 'ready' : 'restart-required',
    nextAction: after.outcome === 'ready' ? 'Tool re-probed successfully; resume setup.' :
      'Installation returned successfully but readiness is unverified. Complete any manual steps, reopen the host/terminal and recheck; do not reinstall automatically.' };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const report = await checkSetup({ ...options, root: await projectHome() }, {}, { project: true });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`SQL Apps setup check (${report.platform}/${report.architecture})`);
    for (const check of report.checks) console.log(`[${check.status}] ${check.message}\n  Next: ${check.nextAction}`);
    console.log(report.scope);
    console.log(report.ready ? 'Prerequisites checked. Approve downloads/build/startup next.' : 'Action needed. Follow the guide or ask Copilot to help with the checks above.');
  }
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    const message = 'Setup check could not complete. No installation or resource changes were performed.';
    if (process.argv.includes('--json')) console.log(JSON.stringify({
      version: 1, ready: false, checks: [{
        id: 'diagnostic', status: 'action-required', code: 'DIAGNOSTIC_FAILED', message,
        nextAction: 'Confirm this checkout, file permissions and usage: node scripts/setup-check.mjs [--json] [--container <existing-sql-container>] [--profile role-based-data] [--workspace <base-port|legacy>].',
        required: true,
      }],
    }, null, 2));
    else console.error(`${message} Confirm this checkout, command arguments and file permissions.`);
    process.exitCode = 1;
  });
}
