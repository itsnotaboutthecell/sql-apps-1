import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { creationSession } from '../src/creation-session.mjs';
import { stopCreationProcess } from '../scripts/creation.mjs';

const projects = await import('../scripts/projects.mjs');
const plugin = await import('../plugins/sql-apps/scripts/sql-apps.mjs');
const workspace = await import('../scripts/workspace-check.mjs');
const execute = promisify(execFile);

function runNpm(args, cwd) {
  const command = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  return execute(command, process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args,
  { cwd, windowsHide: true, maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false',
      npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000' } });
}

async function sourceFixture(t) {
  const source = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-source-')));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (const directory of ['.config', 'dab', 'docs/guides', 'functions/src', 'infra', 'public', 'scripts', 'sql', 'src']) {
    await mkdir(join(source, directory), { recursive: true });
  }
  const files = {
    '.config/dotnet-tools.json': '{}',
    'dab/dab-config.json': '{"entities":{}}',
    'docs/guides/build-your-app.md': '# Build your app',
    'functions/src/index.ts': 'export {};',
    'infra/personal-free.bicep': '',
    'public/index.html': '<h1>SQL Apps</h1>',
    'public/style.css': '',
    'scripts/build-provenance.mjs': '',
    'scripts/check-application.mjs': '',
    'scripts/workspace-check.mjs': await readFile(join(process.cwd(), 'scripts', 'workspace-check.mjs'), 'utf8'),
    'sql/database.sqlproj': '<Project />',
    'src/local-cli.ts': '',
    'src/web/app.ts': "import { SqlAppsClient } from '../browser.js';\n",
    'src/project-contract.mjs': await readFile(join(process.cwd(), 'src', 'project-contract.mjs'), 'utf8'),
    'src/tooling-context.mjs': await readFile(join(process.cwd(), 'src', 'tooling-context.mjs'), 'utf8'),
    'src/workspace.mjs': await readFile(join(process.cwd(), 'src', 'workspace.mjs'), 'utf8'),
    'src/sql-target.mjs': await readFile(join(process.cwd(), 'src', 'sql-target.mjs'), 'utf8'),
    'packages/sql-apps/package.json': JSON.stringify({ name: '@microsoft/sql-apps', version: '1.2.3' }),
    '.dockerignore': '.sql-apps\n',
    '.env.example': '',
    '.gitignore': '.sql-apps/\n',
    'Dockerfile': 'FROM node:22',
    'application.json': '{"name":"sql-apps-foundation","selectedExamples":[]}',
    'package.json': JSON.stringify({
      name: 'sql-apps',
      version: '1.2.3',
      private: true,
      type: 'module',
      scripts: {
        build: 'node scripts/build-provenance.mjs',
        local: 'node dist/src/local-cli.js',
        'plugin:check': 'node scripts/check-plugin.mjs',
        'plugin:install': 'node scripts/install-plugin.mjs',
      },
    }),
    'package-lock.json': JSON.stringify({
      name: 'sql-apps',
      version: '1.2.3',
      lockfileVersion: 3,
      packages: { '': { name: 'sql-apps', version: '1.2.3' } },
    }),
    'runtime-contract.json': '{"version":1,"capabilities":["local","setup-check"]}',
    'role-based-data.example.json': JSON.stringify({
      profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/AppReady',
    }),
    'personal-free-api.example.json': JSON.stringify({
      version: 1,
      authenticationProvider: 'aad',
      routes: [{ method: 'GET', path: '/api/AppReady', procedure: { name: 'AppReady', parameters: {} } }],
    }),
    'tsconfig.json': '{}',
    'tsconfig.runtime.json': '{}',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(source, path, '..'), { recursive: true });
    await writeFile(join(source, path), content);
  }
  await mkdir(join(source, 'plugins', 'sql-apps'), { recursive: true });
  await writeFile(join(source, 'plugins', 'sql-apps', 'plugin.json'), '{}');
  await mkdir(join(source, 'examples', 'todo'), { recursive: true });
  await writeFile(join(source, 'examples', 'todo', 'README.md'), 'not project content');
  return source;
}

test('default project root is SqlAppsProjects under the user profile', () => {
  const userHome = join(tmpdir(), 'sql-apps-user');
  assert.equal(projects.defaultProjectsRoot(userHome), join(userHome, 'SqlAppsProjects'));
});

test('the plugin can guide an unrestored project through its explicit foundation bootstrap', async t => {
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-bootstrap-')));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const created = await projects.createProject(process.cwd(), 'Bootstrap App', { userHome, initializeGit: false });
  const copilotHome = join(userHome, 'copilot');
  await mkdir(copilotHome);
  await writeFile(join(copilotHome, 'sql-apps-local.json'), JSON.stringify({ version: 1, home: process.cwd() }));
  const source = await workspace.inspectSource(created.path, { toolingHome: process.cwd() });
  assert.equal(source.bootstrap, true);
  const launcher = resolve('plugins', 'sql-apps', 'scripts', 'sql-apps.mjs');
  const result = await execute(process.execPath, [launcher, 'guide'], {
    cwd: created.path,
    env: { ...process.env, SQL_APPS_HOME: created.path, COPILOT_HOME: copilotHome,
      SQL_APPS_PROJECT_HOME: undefined, SQL_APPS_TOOLING_HOME: undefined },
  });
  assert.equal(JSON.parse(result.stdout).home, created.path);
  for (const command of [['verify'], ['consent-run', 'build']]) {
    await assert.rejects(execute(process.execPath, [launcher, ...command], {
      cwd: created.path,
      env: { ...process.env, SQL_APPS_HOME: created.path, COPILOT_HOME: copilotHome,
        SQL_APPS_PROJECT_HOME: undefined, SQL_APPS_TOOLING_HOME: undefined },
    }), error => /Restore the pinned project tooling/.test(error.stderr));
  }
});

test('a changed tooling manifest invalidates an approved progressive creation plan', async t => {
  const source = await sourceFixture(t);
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-stale-plan-')));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const plan = await projects.planProjectCreation(source, 'Approved App', { userHome });
  const manifestPath = join(source, 'packages', 'sql-apps', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '1.2.4';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const changed = await projects.planProjectCreation(source, 'Approved App', { userHome });
  assert.notEqual(changed.approval, plan.approval);
});

test('progressive creation uses the canonical path for a linked project root', async t => {
  const source = resolve(import.meta.dirname, '..');
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-linked-root-')));
  t.after(() => rm(userHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const actualRoot = join(userHome, 'actual-projects');
  const linkedRoot = join(userHome, 'linked-projects');
  await mkdir(actualRoot);
  await symlink(actualRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await projects.setProjectsRoot(linkedRoot, { userHome });
  const plan = await projects.planProjectCreation(source, 'Linked App', { userHome });
  const created = await projects.createProject(source, 'Linked App', {
    userHome, progressive: true, approval: plan.approval, browser: false, initializeGit: false,
  });
  const session = await creationSession(created.path);
  await stopCreationProcess(session.directory);
  assert.equal(created.path, join(actualRoot, 'linked-app'));
});

test('a workspace initialization failure removes the renamed project and owned session', async t => {
  const source = await sourceFixture(t);
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-rollback-')));
  let createdPath;
  t.after(async () => {
    if (createdPath) {
      const session = await creationSession(createdPath);
      if (session) await stopCreationProcess(session.directory);
    }
    await rm(userHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await projects.setProjectsRoot(join(userHome, 'projects'), { userHome });
  const plan = await projects.planProjectCreation(source, 'Rollback App', { userHome });
  const result = await projects.createProject(source, 'Rollback App', {
    userHome, progressive: true, approval: plan.approval, browser: false, initializeGit: false,
    initializeWorkspace: async () => { throw new Error('workspace initialization failed'); },
  }).then(project => { createdPath = project.path; return project; }, error => error);
  assert.ok(result instanceof Error, 'the injected post-rename workspace failure must abort creation');
  assert.match(result.message, /workspace initialization failed/);
  await assert.rejects(access(join(userHome, 'projects', 'rollback-app')), { code: 'ENOENT' });
  assert.deepEqual((await projects.readProjectsState({ userHome })).projects, []);
  const sessions = join(userHome, '.sql-apps', 'creation-sessions');
  assert.deepEqual(await readdir(sessions), []);
});

test('a fresh generated project installs its exact tooling version with npm ci from a registry', async t => {
  const source = await sourceFixture(t);
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-install-')));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const packageDirectory = join(source, 'packages', 'sql-apps');
  const sharedDirectory = join(source, 'packages', 'shared-runtime');
  await mkdir(sharedDirectory);
  const tooling = { name: '@microsoft/sql-apps', version: '1.2.3',
    dependencies: { 'shared-runtime': '1.0.0' }, bin: { 'sql-apps': 'cli.mjs' } };
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(tooling));
  await writeFile(join(packageDirectory, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("fixture tooling 1.2.3");\n');
  await writeFile(join(sharedDirectory, 'package.json'), '{"name":"shared-runtime","version":"1.0.0"}');
  const rootPackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  rootPackage.devDependencies = { 'shared-runtime': '1.0.0' };
  await writeFile(join(source, 'package.json'), JSON.stringify(rootPackage));
  const rootLock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
  rootLock.packages[''].devDependencies = rootPackage.devDependencies;
  rootLock.packages['node_modules/shared-runtime'] = { version: '1.0.0', dev: true };
  await writeFile(join(source, 'package-lock.json'), JSON.stringify(rootLock));
  const tarballs = new Map();
  for (const [name, directory] of [['sql-apps', packageDirectory], ['shared-runtime', sharedDirectory]]) {
    const pack = JSON.parse((await runNpm(['pack', '--ignore-scripts', '--json'], directory)).stdout)[0];
    tarballs.set(name, await readFile(join(directory, pack.filename)));
  }
  const created = await projects.createProject(source, 'Fresh install', { userHome, initializeGit: false });
  let registry;
  const server = createServer((request, response) => {
    const name = request.url?.toLowerCase() === '/@microsoft%2fsql-apps' ? 'sql-apps' :
      request.url === '/shared-runtime' ? 'shared-runtime' : null;
    const tarballName = request.url?.slice(1).replace(/\.tgz$/, '');
    if (request.url?.endsWith('.tgz') && tarballs.has(tarballName)) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarballs.get(tarballName));
    } else if (name) {
      const metadata = name === 'sql-apps' ? tooling : { name: 'shared-runtime', version: '1.0.0' };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: metadata.name, 'dist-tags': { latest: metadata.version }, versions: {
        [metadata.version]: { ...metadata, dist: {
          tarball: `${registry}/${name}.tgz`,
          integrity: `sha512-${createHash('sha512').update(tarballs.get(name)).digest('base64')}`,
        } },
      } }));
    } else response.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  registry = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(done => server.close(done)));
  const result = await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false',
    '--omit=dev', '--fetch-retries=0', '--fetch-timeout=10000',
    '--cache', '.npm-cache', `--registry=${registry}`], created.path).catch(error => error);
  assert.equal(result.code, undefined, `${result.stdout}\n${result.stderr}`);
  const installed = JSON.parse(await readFile(join(created.path, 'node_modules', '@microsoft', 'sql-apps', 'package.json'), 'utf8'));
  assert.equal(installed.version, '1.2.3');
  assert.deepEqual(installed.bin, tooling.bin);
  const shared = JSON.parse(await readFile(join(created.path, 'node_modules', 'shared-runtime', 'package.json'), 'utf8'));
  assert.equal(shared.version, '1.0.0', 'a tooling runtime dependency must not be pruned as an app dev dependency');
  const cli = await execute(process.execPath, [join(created.path, 'node_modules', '@microsoft', 'sql-apps', 'cli.mjs')]);
  assert.equal(cli.stdout.trim(), 'fixture tooling 1.2.3');
});

test('create scaffolds an independent named project and records it as active', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-user-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const created = await projects.createProject(source, 'To Do', { userHome, initializeGit: false });
  assert.equal(created.name, 'To Do');
  assert.equal(created.slug, 'to-do');
  assert.equal(created.path, join(userHome, 'SqlAppsProjects', 'to-do'));
  assert.deepEqual(JSON.parse(await readFile(join(created.path, 'application.json'), 'utf8')),
    { name: 'to-do', selectedExamples: [] });
  const pkg = JSON.parse(await readFile(join(created.path, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'sql-apps-to-do');
  assert.deepEqual(pkg.sqlApps, { project: true });
  assert.equal(pkg.dependencies['@microsoft/sql-apps'], '1.2.3');
  assert.equal(pkg.scripts.local, 'sql-apps local');
  assert.equal(pkg.scripts.publish, 'sql-apps publish');
  assert.equal(JSON.parse(await readFile(join(created.path, 'personal-free-api.json'), 'utf8')).version, 1);
  assert.match(await readFile(join(created.path, '.gitignore'), 'utf8'), /^\.sql-apps\/$/m);
  assert.equal(JSON.parse(await readFile(join(created.path, '.sql-apps-project.json'), 'utf8')).tooling.version, '1.2.3');
  await assert.rejects(access(join(created.path, 'plugins')), { code: 'ENOENT' });
  await assert.rejects(access(join(created.path, 'examples')), { code: 'ENOENT' });
  await assert.rejects(access(join(created.path, 'scripts', 'projects.mjs')), { code: 'ENOENT' });
  await assert.rejects(access(join(created.path, 'scripts')), { code: 'ENOENT' });
  await assert.rejects(access(join(created.path, 'src', 'local-cli.ts')), { code: 'ENOENT' });
  await assert.rejects(access(join(created.path, 'src', 'tooling-context.mjs')), { code: 'ENOENT' });
  assert.match(await readFile(join(created.path, 'src', 'web', 'app.ts'), 'utf8'), /@microsoft\/sql-apps\/browser/);
  assert.deepEqual(pkg.dependencies, { '@microsoft/sql-apps': '1.2.3' });
  assert.deepEqual(pkg.devDependencies, {});
  assert.match(await readFile(join(created.path, 'docs', 'guides', 'build-your-app.md'), 'utf8'), /Build your app/);
  const state = await projects.readProjectsState({ userHome });
  assert.equal(state.activeProject, created.path);
  assert.deepEqual(state.projects.map(project => project.path), [created.path]);
});

test('generated app validation guidance uses available project scripts', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-validation-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const created = await projects.createProject(source, 'Validation App', { userHome, initializeGit: false });
  const pkg = JSON.parse(await readFile(join(created.path, 'package.json'), 'utf8'));
  const validation = await readFile(join('plugins', 'sql-apps', 'skills', 'sql-apps-validation', 'SKILL.md'), 'utf8');
  const generated = validation.split('## Generated applications')[1]?.split('\n## ')[0];
  assert.ok(generated, 'Generated applications need validation guidance separate from foundation commands');
  const commands = Array.from(generated.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g), match => match[1]);
  assert.ok(commands.length > 0, 'Document the scaffolded build command');
  for (const command of commands) {
    assert.ok(Object.hasOwn(pkg.scripts, command), `Generated apps do not declare npm run ${command}`);
  }
  assert.match(generated, /npx --no-install tsc --noEmit/);
  assert.doesNotMatch(generated, /\bnpm test\b/);
  assert.equal(pkg.scripts['app:check'], 'sql-apps check');
  for (const command of ['test', 'typecheck', 'plugin:check', 'sql:build', 'dab:validate', 'infra:build']) {
    assert.equal(pkg.scripts[command], undefined, `${command} must not be assumed in a generated application`);
  }

  const boundary = await readFile(join('docs', 'maintainers', 'application-boundary.md'), 'utf8');
  const evidence = boundary.split('## Required evidence')[1]?.split('\n## ')[0];
  assert.ok(evidence, 'Keep application evidence separate from foundation CI');
  for (const [, command] of evidence.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
    assert.ok(Object.hasOwn(pkg.scripts, command), `Application evidence assumes undeclared npm run ${command}`);
  }
  assert.doesNotMatch(evidence, /\bnpm test\b/);
});

test('create refuses an existing project folder without changing the registry', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-collision-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const root = join(userHome, 'SqlAppsProjects');
  await mkdir(join(root, 'to-do'), { recursive: true });
  await assert.rejects(projects.createProject(source, 'To Do', { userHome, initializeGit: false }),
    /already exists/);
  assert.deepEqual((await projects.readProjectsState({ userHome })).projects, []);
});

test('create rejects a project root nested inside the scaffold source', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-nested-root-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  await projects.setProjectsRoot(join(source, 'docs', 'projects'), { userHome });
  await assert.rejects(
    projects.createProject(source, 'Nested App', { userHome, initializeGit: false }),
    /Project root must not be inside the SQL Apps foundation checkout/,
  );
  assert.deepEqual((await projects.readProjectsState({ userHome })).projects, []);
});

test('concurrent project creation preserves every registry entry', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-concurrent-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  await Promise.all([
    projects.createProject(source, 'First App', { userHome, initializeGit: false }),
    projects.createProject(source, 'Second App', { userHome, initializeGit: false }),
  ]);
  const state = await projects.readProjectsState({ userHome });
  assert.deepEqual(state.projects.map(project => project.slug).sort(), ['first-app', 'second-app']);
});

test('open registers an existing SQL Apps project and list reports all projects', async t => {
  const source = await sourceFixture(t);
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-open-')));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const first = await projects.createProject(source, 'First App', { userHome, initializeGit: false });
  const external = join(userHome, 'elsewhere', 'second-app');
  await mkdir(external, { recursive: true });
  for (const file of ['.sql-apps-project.json', 'package.json', 'application.json']) {
    await writeFile(join(external, file), await readFile(join(first.path, file)));
  }
  await mkdir(join(external, 'src', 'web'), { recursive: true });
  await mkdir(join(external, 'sql'), { recursive: true });
  await writeFile(join(external, 'src', 'web', 'app.ts'), '');
  await writeFile(join(external, 'sql', 'database.sqlproj'), '<Project />');
  const opened = await projects.openProject(external, { userHome });
  assert.equal(opened.path, external);
  const state = await projects.readProjectsState({ userHome });
  assert.equal(state.activeProject, external);
  assert.deepEqual(state.projects.map(project => project.path), [first.path, external]);
});

test('plugin accepts generated projects and resolves the current or active project before its foundation binding', async t => {
  const source = await sourceFixture(t);
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-project-routing-')));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const created = await projects.createProject(source, 'Current App', { userHome, initializeGit: false });
  assert.equal(await plugin.validateHome(created.path), created.path);
  assert.equal(await plugin.resolveHome({ cwd: created.path, userHome, environment: {} }), created.path);
  assert.equal(await plugin.resolveHome({ cwd: userHome, userHome, environment: {} }), created.path);
  assert.equal(await plugin.resolveHome({ cwd: source, userHome, environment: {} }), created.path);
  assert.equal(await plugin.resolveHome({
    cwd: userHome, userHome, environment: { SQL_APPS_HOME: source },
  }), source);
});

test('an active project selected from the foundation is an explicit workspace selection', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-active-workspace-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const created = await projects.createProject(source, 'Active App', { userHome, initializeGit: false });
  const report = await plugin.workspaceReport(created.path, { cwd: source, userHome, environment: {} });
  assert.equal(report.binding.source, 'active-project');
  assert.equal(report.binding.explicit, true);
  assert.equal(report.executionAllowed, true);
});

test('generated projects pass source inspection without carrying plugin implementation files', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-inspection-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const created = await projects.createProject(source, 'Inspected App', { userHome, initializeGit: false });
  const report = await workspace.inspectSource(created.path, { toolingHome: source });
  assert.equal(report.ready, true);
  assert.equal(report.application.name, 'inspected-app');
});

test('plugin project dispatch uses the bound foundation as scaffold source without resolving an app first', async t => {
  const source = await sourceFixture(t);
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-project-dispatch-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const copilotHome = join(userHome, '.copilot');
  await mkdir(copilotHome, { recursive: true });
  await writeFile(join(copilotHome, 'sql-apps-local.json'), JSON.stringify({ version: 1, home: source }));
  const calls = [];
  await plugin.dispatchProjects(['create', 'A New App'], {
    userHome,
    environment: { COPILOT_HOME: copilotHome },
    projectMain: async (args, home) => calls.push({ args, home }),
  });
  assert.deepEqual(calls, [{ args: ['create', 'A New App'], home: source }]);
});
