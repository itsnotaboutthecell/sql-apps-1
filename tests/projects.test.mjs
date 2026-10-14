import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projects = await import('../scripts/projects.mjs');
const plugin = await import('../plugins/sql-apps/scripts/sql-apps.mjs');
const workspace = await import('../scripts/workspace-check.mjs');

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
    'src/project-contract.mjs': await readFile(join(process.cwd(), 'src', 'project-contract.mjs'), 'utf8'),
    'src/tooling-context.mjs': await readFile(join(process.cwd(), 'src', 'tooling-context.mjs'), 'utf8'),
    'src/workspace.mjs': await readFile(join(process.cwd(), 'src', 'workspace.mjs'), 'utf8'),
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
  assert.match(await readFile(join(created.path, 'docs', 'guides', 'build-your-app.md'), 'utf8'), /Build your app/);
  const state = await projects.readProjectsState({ userHome });
  assert.equal(state.activeProject, created.path);
  assert.deepEqual(state.projects.map(project => project.path), [created.path]);
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
  for (const file of ['.sql-apps-project.json', 'package.json', 'application.json', 'runtime-contract.json']) {
    await writeFile(join(external, file), await readFile(join(first.path, file)));
  }
  await mkdir(join(external, 'src'), { recursive: true });
  await mkdir(join(external, 'sql'), { recursive: true });
  await writeFile(join(external, 'src', 'local-cli.ts'), '');
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
