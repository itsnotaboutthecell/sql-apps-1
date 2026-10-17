import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withFileLock } from '../src/file-lock.mjs';
import { readProjectManifest } from '../src/project-contract.mjs';
import { portState, initializeWorkspace, workspaceIdentity } from '../src/workspace.mjs';
import { initialProgress, fingerprint } from '../src/creation-progress.mjs';
import { writeCreationJson } from '../src/creation-session.mjs';
import { creationImplementation, startCreationProcess, stopCreationProcess, openCreationBrowser } from './creation.mjs';

const execute = promisify(execFile);
const projectDirectories = ['.config', 'content', 'dab', 'docs', 'public', 'sql'];
const projectFiles = [
  '.dockerignore', '.env.example', '.gitignore', 'Dockerfile', 'LICENSE',
  'application.json', 'package-lock.json', 'package.json',
  'role-based-data.example.json', 'personal-free-api.example.json',
  'tsconfig.json', 'src/web/app.ts', 'creation-checks.json',
];

export function defaultProjectsRoot(userHome = homedir()) {
  return join(userHome, 'SqlAppsProjects');
}

function statePath(userHome) {
  return join(userHome, '.sql-apps', 'projects.json');
}

function withProjectsLock(userHome, action) {
  return withFileLock(`${statePath(userHome)}.lock`, action, 3000);
}

function slugify(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new Error('Provide a project name between 1 and 100 characters.');
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Project name must contain letters or numbers.');
  return slug;
}

function validState(value) {
  return value && value.version === 1 && typeof value.projectsRoot === 'string' &&
    isAbsolute(value.projectsRoot) && Array.isArray(value.projects) &&
    value.projects.every(project => project && typeof project.name === 'string' &&
      typeof project.slug === 'string' && typeof project.path === 'string' && isAbsolute(project.path) &&
      typeof project.createdAt === 'string' && Number.isFinite(Date.parse(project.createdAt))) &&
    (value.activeProject === null || typeof value.activeProject === 'string' && isAbsolute(value.activeProject)) &&
    Object.keys(value).every(key => ['version', 'projectsRoot', 'activeProject', 'projects'].includes(key));
}

export async function readProjectsState(options = {}) {
  const userHome = resolve(options.userHome ?? homedir());
  let state;
  try { state = JSON.parse(await readFile(statePath(userHome), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {
      version: 1, projectsRoot: defaultProjectsRoot(userHome), activeProject: null, projects: [],
    };
    if (error instanceof SyntaxError) throw new Error('Invalid SQL Apps project registry; review it without resetting state.');
    throw error;
  }
  if (!validState(state)) throw new Error('Invalid SQL Apps project registry; review it without resetting state.');
  return state;
}

async function saveProjectsState(state, userHome) {
  const directory = join(userHome, '.sql-apps');
  await mkdir(directory, { recursive: true });
  const path = statePath(userHome);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function setProjectsRoot(value, options = {}) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Project root must be an absolute path.');
  const userHome = resolve(options.userHome ?? homedir());
  return withProjectsLock(userHome, async () => {
    const state = await readProjectsState({ userHome });
    state.projectsRoot = resolve(value);
    await mkdir(state.projectsRoot, { recursive: true });
    await saveProjectsState(state, userHome);
    return state;
  });
}

async function copyProjectSource(source, target) {
  for (const name of projectDirectories) {
    const from = join(source, name);
    let info;
    try { info = await lstat(from); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Project scaffold input must be a directory: ${name}`);
    await cp(from, join(target, name), {
      recursive: true,
      filter: path => {
        const relative = path.slice(from.length).replaceAll('\\', '/');
        return !/(^|\/)(?:node_modules|dist|bin|obj|\.git|\.sql-apps)(?:\/|$)/.test(relative) &&
          !/^\/?public\/(?:app\.js|auth\/redirect\.js)$/.test(`${name}${relative}`);
      },
    });
  }
  for (const name of projectFiles) {
    const from = join(source, name);
    let info;
    try { info = await lstat(from); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Project scaffold input must be a file: ${name}`);
    await mkdir(dirname(join(target, name)), { recursive: true });
    await cp(from, join(target, name));
  }
}

function promoteToolingDependencies(packages, toolingPath) {
  const pending = [toolingPath, ...Object.keys(packages[''].devDependencies ?? {}).map(name => `node_modules/${name}`)];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const entry = packages[path];
    delete entry.dev;
    delete entry.devOptional;
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) {
      let parent = path, dependency;
      while (true) {
        const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`;
        if (packages[candidate]) { dependency = candidate; break; }
        if (!parent) break;
        const nested = parent.lastIndexOf('/node_modules/');
        parent = nested < 0 ? '' : parent.slice(0, nested);
      }
      if (dependency) pending.push(dependency);
      else if (!entry.optionalDependencies?.[name] && entry.peerDependenciesMeta?.[name]?.optional !== true) {
        throw new Error(`Scaffold lockfile is missing tooling dependency ${name}; restore the foundation lockfile before creating a project.`);
      }
    }
  }
  for (const path of Object.keys(packages)) {
    if (path && !visited.has(path)) delete packages[path];
  }
}

async function customizeProject(target, name, slug, tooling) {
  const toolingVersion = tooling.version;
  await writeFile(join(target, 'application.json'), `${JSON.stringify({ name: slug, selectedExamples: [] }, null, 2)}\n`);
  await writeFile(join(target, '.sql-apps-project.json'), `${JSON.stringify({
    version: 1,
    id: randomUUID(),
    name,
    slug,
    starter: 'data',
    profile: 'role-based-data',
    scaffoldVersion: 1,
    tooling: { package: '@microsoft/sql-apps', version: toolingVersion },
  }, null, 2)}\n`);
  await writeFile(join(target, 'role-based-data.json'),
    await readFile(join(target, 'role-based-data.example.json'), 'utf8'));
  await writeFile(join(target, 'personal-free-api.json'),
    await readFile(join(target, 'personal-free-api.example.json'), 'utf8'));
  const pkgPath = join(target, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  pkg.name = `sql-apps-${slug}`;
  pkg.sqlApps = { project: true };
  pkg.dependencies = { '@microsoft/sql-apps': toolingVersion };
  pkg.devDependencies = pkg.devDependencies?.['@types/node'] ? { '@types/node': pkg.devDependencies['@types/node'] } : {};
  pkg.scripts = {
    build: 'sql-apps build',
    guide: 'sql-apps guide',
    local: 'sql-apps local',
    publish: 'sql-apps publish',
    setup: 'sql-apps setup',
    'setup:check': 'sql-apps setup-check',
    'workspace:check': 'sql-apps workspace-check',
    'app:check': 'sql-apps check',
    'app:check-api': 'sql-apps check-api',
    consent: 'sql-apps consent',
  };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const lockPath = join(target, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.name = pkg.name;
  if (lock.packages?.['']) {
    lock.packages[''].name = pkg.name;
    lock.packages[''].sqlApps = { project: true };
    lock.packages[''].dependencies = pkg.dependencies;
    lock.packages[''].devDependencies = pkg.devDependencies;
    lock.packages['node_modules/@microsoft/sql-apps'] = {
      version: toolingVersion,
      license: tooling.license,
      dependencies: tooling.dependencies,
      bin: tooling.bin,
      engines: tooling.engines,
    };
    promoteToolingDependencies(lock.packages, 'node_modules/@microsoft/sql-apps');
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const appPath = join(target, 'src', 'web', 'app.ts');
  await writeFile(appPath, (await readFile(appPath, 'utf8')).replace("'../browser.js'", "'@microsoft/sql-apps/browser'"));
  const dockerPath = join(target, 'Dockerfile');
  const docker = (await readFile(dockerPath, 'utf8'))
    .replace(/^COPY (?:packages|scripts|plugins\/sql-apps|infra) .+\r?\n/gm, '')
    .replace('COPY application.json runtime-contract.json ./', 'COPY .sql-apps-project.json application.json role-based-data.json ./');
  await writeFile(dockerPath, docker);
  await writeFile(join(target, 'README.md'), `# ${name}\n\nA SQL Apps project.\n\n## Local development\n\n\`\`\`powershell\nnpm ci\nnpm run build\nnpm run setup -- plan --profile role-based-data\n\`\`\`\n`);
}

async function initializeRepository(target, runner = execute) {
  const options = { cwd: target, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  await runner('git', ['init'], options);
  await runner('git', ['add', '-A'], options);
  await runner('git', ['-c', 'user.name=SQL Apps', '-c', 'user.email=sql-apps@local', 'commit', '-m', 'Initial SQL Apps project'], options);
}

async function validateProject(path) {
  const root = await realpath(path);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const application = JSON.parse(await readFile(join(root, 'application.json'), 'utf8'));
  const manifest = await readProjectManifest(root);
  if (pkg.sqlApps?.project !== true || pkg.scripts?.local !== 'sql-apps local' ||
      pkg.dependencies?.['@microsoft/sql-apps'] !== manifest.tooling.version ||
      typeof application.name !== 'string' || application.selectedExamples?.length !== 0) throw new Error('The selected directory is not a SQL Apps project.');
  for (const file of ['src/web/app.ts', 'sql/database.sqlproj']) await lstat(join(root, file));
  return { root, pkg, application };
}

async function prospectivePath(value) {
  try { return await realpath(value); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(value);
    if (parent === value) throw error;
    return join(await prospectivePath(parent), basename(value));
  }
}

export async function planProjectCreation(sourceValue, name, options = {}) {
  const source = await realpath(sourceValue);
  const userHome = await realpath(resolve(options.userHome ?? homedir()));
  const state = await readProjectsState({ userHome });
  const toolingManifest = options.toolingManifest ?? await readFile(join(source, 'packages', 'sql-apps', 'package.json'), 'utf8');
  const root = await prospectivePath(state.projectsRoot);
  const destination = join(root, slugify(name));
  const nested = relative(source, destination);
  if (nested === '' || !nested.startsWith('..') && !isAbsolute(nested)) throw new Error('Application projects must be outside the foundation checkout.');
  const id = workspaceIdentity(destination);
  let basePort;
  const probe = options.probe ?? portState;
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = 20000 + ((parseInt(id.slice(0, 8), 16) + attempt) % 4000) * 10;
    if ((await Promise.all([0, 1, 2, 5].map(offset => probe(candidate + offset)))).every(state => state === 'free')) {
      basePort = candidate;
      break;
    }
  }
  if (!basePort) throw new Error('No free creation workspace block found; inspect occupied ports without stopping unrelated services.');
  const effects = [
    `Create ${destination} and initialize its Git repository.`,
    `Start an owned loopback status/proxy process on port ${basePort}; reserve private gateway ${basePort + 2}, DAB ${basePort + 1}, SQL ${basePort + 5}.`,
    'Persist nonsecret creation state in the user SQL Apps directory and open the local browser.',
    'Known later setup effects: dependency restore, build, SQL startup/schema publication and synthetic acceptance. Existing scoped setup approval and SQL terms still apply before those operations; no cloud resources are created.',
  ];
  return { version: 1, source, home: destination, name: name.trim(), userHome, workspaceId: id, basePort, effects,
    approval: fingerprint({ source, home: destination, name: name.trim(), basePort, effects,
      toolingManifest, implementation: await creationImplementation() }).slice(0, 12) };
}

export async function createProject(sourceValue, name, options = {}) {
  const source = await realpath(sourceValue);
  const toolingManifest = await readFile(join(source, 'packages', 'sql-apps', 'package.json'), 'utf8');
  const tooling = JSON.parse(toolingManifest);
  const userHome = resolve(options.userHome ?? homedir());
  const creation = options.progressive ? await planProjectCreation(source, name, { ...options, toolingManifest }) : null;
  if (creation && options.approval !== creation.approval) throw new Error('Review projects create-plan and explicitly approve its current id before starting the browser experience.');
  return withProjectsLock(userHome, async () => {
    const state = await readProjectsState({ userHome });
    await mkdir(state.projectsRoot, { recursive: true });
    const projectsRoot = await realpath(state.projectsRoot);
    const nested = relative(source, projectsRoot);
    if (nested === '' || !nested.startsWith('..') && !isAbsolute(nested)) {
      throw new Error('Project root must not be inside the SQL Apps foundation checkout.');
    }
    const slug = slugify(name);
    const destination = join(projectsRoot, slug);
    try {
      await lstat(destination);
      throw new Error(`A project folder named "${slug}" already exists in ${state.projectsRoot}.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(projectsRoot, `.${slug}-${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    let sessionDirectory, session, origin, destinationCreated = false;
    try {
      if (creation) {
        if (destination !== creation.home) throw new Error('Creation destination changed; review a new creation plan.');
        session = initialProgress({ home: destination, name: name.trim(), workspaceId: creation.workspaceId,
          publicOrigin: `http://127.0.0.1:${creation.basePort}`, gatewayOrigin: `http://127.0.0.1:${creation.basePort + 2}` });
        sessionDirectory = join(creation.userHome, '.sql-apps', 'creation-sessions', session.sessionId);
        await writeCreationJson(join(sessionDirectory, 'progress.json'), session);
        origin = await startCreationProcess(sessionDirectory, source);
        if (options.browser !== false) await openCreationBrowser(origin);
      }
      await copyProjectSource(source, temporary);
      await customizeProject(temporary, name.trim(), slug, tooling);
      if (options.initializeGit !== false) await initializeRepository(temporary, options.runner);
      await rename(temporary, destination);
      destinationCreated = true;
      if (creation) {
        await writeCreationJson(join(destination, '.sql-apps', 'creation-session.json'),
          { version: 1, home: destination, directory: sessionDirectory, sessionId: session.sessionId });
        await (options.initializeWorkspace ?? initializeWorkspace)(destination, creation.basePort, portState,
          { frontDoor: true, sessionId: session.sessionId });
      }
      const project = { name: name.trim(), slug, path: destination, createdAt: new Date().toISOString() };
      state.projects = [...state.projects.filter(item => item.path !== destination), project];
      state.activeProject = destination;
      await saveProjectsState(state, userHome);
      return { ...project, ...(origin ? { launchUrl: origin, reviewPending: true } : {}) };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (origin) {
        try { await stopCreationProcess(sessionDirectory); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Scaffolding and owned front-door cleanup failed; inspect the creation session.'); }
      }
      if (destinationCreated) await rm(destination, { recursive: true, force: true });
      if (sessionDirectory && error.code !== 'CREATION_PROCESS_CLEANUP_FAILED') {
        await rm(sessionDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  });
}

export async function openProject(value, options = {}) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Provide an absolute SQL Apps project path.');
  const userHome = resolve(options.userHome ?? homedir());
  const { root, application } = await validateProject(value);
  return withProjectsLock(userHome, async () => {
    const state = await readProjectsState({ userHome });
    const existing = state.projects.find(project => project.path === root);
    const project = existing ?? {
      name: application.name, slug: basename(root), path: root, createdAt: new Date().toISOString(),
    };
    state.projects = [...state.projects.filter(item => item.path !== root), project];
    state.activeProject = root;
    await saveProjectsState(state, userHome);
    return project;
  });
}

export async function main(args = process.argv.slice(2), source = resolve(import.meta.dirname, '..')) {
  const [command = 'list', value, ...extra] = args;
  const progressive = command === 'create' && extra.length === 2 && extra[0] === '--approval' && /^[a-f0-9]{12}$/.test(extra[1]);
  if (extra.length && !progressive || !['root', 'create-plan', 'create', 'list', 'open'].includes(command)) {
    throw new Error('Usage: projects <root [absolute-path]|create-plan <name>|create <name> [--approval <id>]|list|open <absolute-path>>');
  }
  if (command === 'root') {
    const state = value === undefined ? await readProjectsState() : await setProjectsRoot(value);
    console.log(state.projectsRoot);
  } else if (command === 'create') {
    if (!value) throw new Error('Provide a project name.');
    console.log(JSON.stringify(await createProject(source, value, progressive ? { progressive: true, approval: extra[1] } : {}), null, 2));
  } else if (command === 'create-plan') {
    if (!value) throw new Error('Provide a project name.');
    console.log(JSON.stringify(await planProjectCreation(source, value), null, 2));
  } else if (command === 'open') {
    if (!value) throw new Error('Provide an absolute SQL Apps project path.');
    console.log(JSON.stringify(await openProject(value), null, 2));
  } else {
    if (value !== undefined) throw new Error('projects list takes no arguments.');
    console.log(JSON.stringify(await readProjectsState(), null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'SQL Apps project operation failed.');
    process.exitCode = 1;
  });
}
