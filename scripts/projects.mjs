import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withFileLock } from '../src/file-lock.mjs';

const execute = promisify(execFile);
const projectDirectories = ['.config', 'content', 'dab', 'docs', 'functions', 'infra', 'public', 'scripts', 'sql', 'src'];
const projectFiles = [
  '.dockerignore', '.env.example', '.gitignore', 'Dockerfile', 'LICENSE',
  'application.json', 'local-settings.example.json', 'package-lock.json', 'package.json',
  'role-based-data.example.json', 'runtime-contract.json', 'tsconfig.json', 'tsconfig.runtime.json',
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
          !/^\/?public\/(?:app\.js|auth\/redirect\.js)$/.test(`${name}${relative}`) &&
          !(name === 'scripts' && /^\/?(?:projects|install-plugin|check-plugin)\.mjs$/.test(relative));
      },
    });
  }
  for (const name of projectFiles) {
    const from = join(source, name);
    let info;
    try { info = await lstat(from); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Project scaffold input must be a file: ${name}`);
    await cp(from, join(target, name));
  }
}

async function customizeProject(target, name, slug) {
  await writeFile(join(target, 'application.json'), `${JSON.stringify({ name: slug, selectedExamples: [] }, null, 2)}\n`);
  const pkgPath = join(target, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  pkg.name = `sql-apps-${slug}`;
  pkg.sqlApps = { project: true };
  if (pkg.scripts) {
    delete pkg.scripts['plugin:check'];
    delete pkg.scripts['plugin:install'];
    delete pkg.scripts.projects;
    pkg.scripts.test = 'npm run build && npm run typecheck && npm run app:check';
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const lockPath = join(target, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.name = pkg.name;
  if (lock.packages?.['']) {
    lock.packages[''].name = pkg.name;
    lock.packages[''].sqlApps = { project: true };
    if (lock.packages[''].scripts) {
      delete lock.packages[''].scripts['plugin:check'];
      delete lock.packages[''].scripts['plugin:install'];
    }
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
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
  const contract = JSON.parse(await readFile(join(root, 'runtime-contract.json'), 'utf8'));
  if (pkg.sqlApps?.project !== true || pkg.scripts?.local !== 'node dist/src/local-cli.js' ||
      typeof application.name !== 'string' || application.selectedExamples?.length !== 0 ||
      contract.version !== 1) throw new Error('The selected directory is not a SQL Apps project.');
  for (const file of ['src/local-cli.ts', 'sql/database.sqlproj']) await lstat(join(root, file));
  return { root, pkg, application };
}

export async function createProject(sourceValue, name, options = {}) {
  const source = await realpath(sourceValue);
  const userHome = resolve(options.userHome ?? homedir());
  return withProjectsLock(userHome, async () => {
    const state = await readProjectsState({ userHome });
    await mkdir(state.projectsRoot, { recursive: true });
    const projectsRoot = await realpath(state.projectsRoot);
    const nested = relative(source, projectsRoot);
    if (nested === '' || !nested.startsWith('..') && !isAbsolute(nested)) {
      throw new Error('Project root must not be inside the SQL Apps foundation checkout.');
    }
    const slug = slugify(name);
    const destination = join(state.projectsRoot, slug);
    try {
      await lstat(destination);
      throw new Error(`A project folder named "${slug}" already exists in ${state.projectsRoot}.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(state.projectsRoot, `.${slug}-${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await copyProjectSource(source, temporary);
      await customizeProject(temporary, name.trim(), slug);
      if (options.initializeGit !== false) await initializeRepository(temporary, options.runner);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    const project = { name: name.trim(), slug, path: destination, createdAt: new Date().toISOString() };
    state.projects = [...state.projects.filter(item => item.path !== destination), project];
    state.activeProject = destination;
    await saveProjectsState(state, userHome);
    return project;
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
  if (extra.length || !['root', 'create', 'list', 'open'].includes(command)) {
    throw new Error('Usage: projects <root [absolute-path]|create <name>|list|open <absolute-path>>');
  }
  if (command === 'root') {
    const state = value === undefined ? await readProjectsState() : await setProjectsRoot(value);
    console.log(state.projectsRoot);
  } else if (command === 'create') {
    if (!value) throw new Error('Provide a project name.');
    console.log(JSON.stringify(await createProject(source, value), null, 2));
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
