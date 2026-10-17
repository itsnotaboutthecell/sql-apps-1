import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = join(root, 'dist', 'tooling-project-runtime-test-package');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

async function run(command, args, cwd, environment = {}) {
  try {
    return await execute(command, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...environment, SQL_APPS_PROJECT_HOME: undefined },
    });
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
  }
}

async function projectFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-generated-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = join(directory, 'customer-data');
  const tooling = join(project, 'node_modules', '@microsoft', 'sql-apps');
  await Promise.all([
    mkdir(join(project, 'src', 'web'), { recursive: true }),
    mkdir(join(project, 'public', 'auth'), { recursive: true }),
    mkdir(join(project, 'sql', 'local'), { recursive: true }),
    mkdir(join(project, 'dab'), { recursive: true }),
    mkdir(join(project, '.config'), { recursive: true }),
    mkdir(dirname(tooling), { recursive: true }),
  ]);
  await cp(staged, tooling, { recursive: true });
  await Promise.all([
    cp(join(root, 'node_modules', 'typescript'), join(project, 'node_modules', 'typescript'), { recursive: true }),
    cp(join(root, 'node_modules', 'esbuild'), join(project, 'node_modules', 'esbuild'), { recursive: true }),
    cp(join(root, 'node_modules', '@esbuild'), join(project, 'node_modules', '@esbuild'), { recursive: true }),
  ]);
  const files = {
    '.sql-apps-project.json': {
      version: 1,
      id: 'b91d4857-9570-4d4b-a740-918471ca7e26',
      name: 'Customer Data',
      slug: 'customer-data',
      starter: 'data',
      profile: 'role-based-data',
      scaffoldVersion: 1,
      tooling: { package: '@microsoft/sql-apps', version },
    },
    'package.json': {
      name: 'customer-data',
      private: true,
      type: 'module',
      sqlApps: { project: true },
      dependencies: { '@microsoft/sql-apps': version },
      scripts: {
        build: 'sql-apps build',
        guide: 'sql-apps guide',
        local: 'sql-apps local',
        setup: 'sql-apps setup',
        'setup:check': 'sql-apps setup-check',
        'workspace:check': 'sql-apps workspace-check',
      },
    },
    'package-lock.json': {
      name: 'customer-data',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@microsoft/sql-apps': version } },
      },
    },
    'application.json': { name: 'customer-data', selectedExamples: [] },
    'role-based-data.json': {
      profile: 'role-based-data',
      requiredRole: 'CustomerReader',
      readinessPath: '/api/Ready',
    },
    'tsconfig.json': {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist/src',
        rootDir: 'src',
        strict: true,
      },
      include: ['src/**/*.ts'],
    },
    'src/index.ts': 'export const projectName = "customer-data";\n',
    'src/web/app.ts': 'document.body.dataset.project = "customer-data";\n',
    'src/web/auth-redirect.ts': 'document.body.dataset.redirect = "ready";\n',
    'src/web/developer.ts': 'document.body.dataset.developer = "ready";\n',
    'src/web/developer.html': '<!doctype html><title>Developer</title>\n',
    'public/index.html': '<!doctype html><title>Customer Data</title>\n',
    'public/style.css': 'body { font-family: sans-serif; }\n',
    'public/auth/redirect.html': '<!doctype html><title>Redirect</title>\n',
    'sql/database.sqlproj': '<Project Sdk="Microsoft.Build.Sql/2.0.0" />\n',
    'sql/ready.sql': 'CREATE PROCEDURE dbo.Ready AS SELECT 1 AS ready;\n',
    'sql/local/acceptance.sql': 'SELECT 1;\n',
    'sql/local/application-acceptance.sql': 'SELECT 1;\n',
    'dab/dab-config.json': {
      runtime: {
        rest: { enabled: true, path: '/api' },
        host: {
          mode: 'production',
          authentication: {
            provider: 'AzureAD',
            jwt: { audience: "@env('API_CLIENT_ID')", issuer: "@env('ENTRA_ISSUER')" },
          },
        },
      },
      entities: {
        Ready: {
          source: { type: 'stored-procedure', object: 'dbo.Ready' },
          rest: { enabled: true, methods: ['get'] },
          permissions: [{ role: 'CustomerReader', actions: ['execute'] }],
        },
      },
    },
    '.config/dotnet-tools.json': { version: 1, isRoot: true, tools: {} },
  };
  for (const [name, value] of Object.entries(files)) {
    const path = join(project, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return { project: await realpath(project), tooling: await realpath(tooling) };
}

before(async () => {
  const { inspectSource } = await import('../scripts/workspace-check.mjs');
  const source = await inspectSource(root, { toolingHome: root, foundation: true });
  if (!source.build?.ready) {
    await execute(process.execPath, [join(root, 'scripts', 'build-provenance.mjs')], { cwd: root });
  }
  await rm(staged, { recursive: true, force: true });
  const { buildToolingPackage } = await import('../scripts/build-tooling-package.mjs');
  await buildToolingPackage(staged);
});

after(() => rm(staged, { recursive: true, force: true }));

test('tooling context resolves source, package and ancestor project homes explicitly', async t => {
  const { project, tooling } = await projectFixture(t);
  const context = await import('../src/tooling-context.mjs');
  assert.equal(await context.toolingHome(import.meta.url), root);
  assert.equal(
    await context.toolingHome(pathToFileURL(join(tooling, 'dist', 'scripts', 'guide.mjs')).href),
    tooling,
  );
  assert.equal(await context.projectHome({}, join(project, 'src', 'web')), project);
  assert.equal(await context.projectHome({ SQL_APPS_PROJECT_HOME: project }, root), project);
  const foundation = join(project, 'foundation');
  await mkdir(foundation);
  await writeFile(join(foundation, 'package.json'), JSON.stringify({ name: 'sql-apps' }));
  assert.equal(await context.installedTooling(foundation), undefined,
    'a foundation without a project manifest must not adopt an ancestor application package');
});

test('installed tooling mismatches and incomplete packages fail instead of falling back to the foundation', async t => {
  const { project, tooling } = await projectFixture(t);
  const context = await import('../src/tooling-context.mjs');
  const manifestPath = join(tooling, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '999.0.0' }));
  await assert.rejects(context.installedTooling(project), /does not match the project pin/);
  const plugin = await import('../plugins/sql-apps/scripts/sql-apps.mjs');
  await assert.rejects(plugin.workspaceReport(project, {
    cwd: root, environment: { SQL_APPS_HOME: project }, userHome: project,
  }), /does not match the project pin/);
  await rm(manifestPath);
  await assert.rejects(context.installedTooling(project), { code: 'ENOENT' });
});

test('packaged project commands run from nested paths without using the foundation checkout', async t => {
  const { project, tooling } = await projectFixture(t);
  const nested = join(project, 'src', 'web');
  const bin = join(tooling, 'bin', 'sql-apps.mjs');
  const workspace = await run(process.execPath, [bin, 'workspace-check'], nested);
  assert.equal(workspace.code, undefined, workspace.stderr);
  const report = JSON.parse(workspace.stdout);
  assert.equal(report.bound.home, project);
  assert.equal(report.bound.project.tooling.version, version);
  assert.equal(report.executionAllowed, true);

  const build = await run(process.execPath, [bin, 'build'], nested);
  assert.equal(build.code, undefined, `${build.stdout}\n${build.stderr}`);
  const provenance = JSON.parse(await readFile(join(project, 'dist', 'build-provenance.json'), 'utf8'));
  assert.equal(provenance.home, project);
  assert.match(provenance.toolingFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(project, 'dist', 'src', 'index.js'), 'utf8').then(Boolean), true);
  assert.equal(await readFile(join(project, 'public', 'app.js'), 'utf8').then(Boolean), true);

  const guide = await run(process.execPath, [bin, 'guide', '--json'], nested);
  assert.equal(guide.code, undefined, guide.stderr);
  assert.equal(JSON.parse(guide.stdout).home, project);

  const setupCheck = await run(process.execPath, [bin, 'setup-check', '--json'], nested);
  const diagnostic = JSON.parse(setupCheck.stdout);
  assert.equal(diagnostic.home, project);
  assert.equal(diagnostic.checks.find(check => check.id === 'dependencies').status, 'ready',
    'TypeScript hoisted beside the tooling package is a valid installed dependency');
  const plan = await run(process.execPath, [bin, 'setup', 'plan', '--json'], nested);
  assert.doesNotMatch(plan.stderr, /Run setup-check from a validated SQL Apps project/);
  assert.equal(JSON.parse(plan.stdout).home, project,
    'the packaged planner passes validated project context to the prerequisite checker');
  for (const output of [workspace.stdout, build.stdout, guide.stdout, setupCheck.stdout, setupCheck.stderr, plan.stdout, plan.stderr]) {
    assert.doesNotMatch(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('the plugin uses installed project tooling and agrees with package build provenance', async t => {
  const { project, tooling } = await projectFixture(t);
  const build = await run(process.execPath, [join(tooling, 'bin', 'sql-apps.mjs'), 'build'], project);
  assert.equal(build.code, undefined, build.stderr);
  const plugin = await import('../plugins/sql-apps/scripts/sql-apps.mjs');
  const environment = { SQL_APPS_HOME: project, COPILOT_HOME: join(project, 'absent-profile') };
  const report = await plugin.workspaceReport(project, { cwd: root, environment, userHome: project });
  assert.equal(report.bound.toolingHome, tooling);
  assert.equal(report.bound.build.code, 'BUILD_CURRENT');
  const launcher = join(root, 'plugins', 'sql-apps', 'scripts', 'sql-apps.mjs');
  const guide = await run(process.execPath, [launcher, 'guide'], project, environment);
  assert.equal(guide.code, undefined, guide.stderr);
  assert.equal(JSON.parse(guide.stdout).home, project);
  const plan = await run(process.execPath, [launcher, 'setup', 'plan', '--json'], project, environment);
  assert.equal(JSON.parse(plan.stdout).home, project, plan.stderr);
});

test('a factory project builds its UI and publishing artifact without foundation implementation source', async t => {
  const { project, tooling } = await projectFixture(t);
  const userHome = join(dirname(project), 'factory-user');
  await mkdir(userHome);
  const { createProject } = await import('../scripts/projects.mjs');
  const created = await createProject(root, 'Independent App', { userHome, initializeGit: false });
  await assert.rejects(readFile(join(created.path, 'src', 'local-cli.ts')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(created.path, 'scripts', 'setup.mjs')), { code: 'ENOENT' });
  const installed = join(created.path, 'node_modules', '@microsoft', 'sql-apps');
  await mkdir(dirname(installed), { recursive: true });
  await cp(tooling, installed, { recursive: true });
  for (const dependency of ['typescript', 'esbuild', '@esbuild', '@azure/msal-browser', '@azure/msal-common', 'zod', '@types/node', 'undici-types']) {
    const destination = join(created.path, 'node_modules', dependency);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, 'node_modules', dependency), destination, { recursive: true });
  }
  const bin = join(installed, 'bin', 'sql-apps.mjs');
  const types = await run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], created.path);
  assert.equal(types.code, undefined, `${types.stdout}\n${types.stderr}`);
  const build = await run(process.execPath, [bin, 'build'], created.path);
  assert.equal(build.code, undefined, `${build.stdout}\n${build.stderr}`);
  assert.ok((await readFile(join(created.path, 'public', 'app.js'), 'utf8')).length > 0);
  assert.ok((await readFile(join(created.path, 'public', 'auth', 'redirect.js'), 'utf8')).length > 0);
  const checked = await run(process.execPath, [bin, 'check'], created.path);
  assert.equal(checked.code, undefined, `${checked.stdout}\n${checked.stderr}`);
  assert.doesNotMatch(checked.stdout, /customized UI/);
  const publisher = pathToFileURL(join(installed, 'dist', 'src', 'personal-free-build.js')).href;
  const artifact = join(created.path, 'dist', 'publish-fixture');
  const publishBuild = await run(process.execPath, ['--input-type=module', '-e',
    `import { buildPersonalFreeArtifact } from ${JSON.stringify(publisher)}; await buildPersonalFreeArtifact(process.cwd(), ${JSON.stringify(artifact)});`],
  created.path, { SQL_APPS_TOOLING_HOME: installed });
  assert.equal(publishBuild.code, undefined, publishBuild.stderr);
  assert.ok((await readFile(join(artifact, 'static', 'app.js'), 'utf8')).length > 0);
});

test('project rebuild removes generated output whose source was deleted', async t => {
  const { project, tooling } = await projectFixture(t);
  const bin = join(tooling, 'bin', 'sql-apps.mjs');
  const source = join(project, 'src', 'removed.ts');
  const output = join(project, 'dist', 'src', 'removed.js');
  const unrelatedDist = join(project, 'dist', 'customer-note.txt');
  const unrelatedPublic = join(project, 'public', 'customer.js');
  await writeFile(source, 'export const removed = true;\n');
  await writeFile(unrelatedPublic, 'preserve\n');
  let result = await run(process.execPath, [bin, 'build'], project);
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(await readFile(output, 'utf8').then(Boolean), true);
  await writeFile(unrelatedDist, 'preserve\n');

  await rm(source);
  result = await run(process.execPath, [bin, 'build'], project);
  assert.equal(result.code, undefined, result.stderr);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  assert.equal(await readFile(unrelatedDist, 'utf8'), 'preserve\n');
  assert.equal(await readFile(unrelatedPublic, 'utf8'), 'preserve\n');
});

test('project rebuild refuses to clean a linked generated output', async t => {
  const { project, tooling } = await projectFixture(t);
  const bin = join(tooling, 'bin', 'sql-apps.mjs');
  const result = await run(process.execPath, [bin, 'build'], project);
  assert.equal(result.code, undefined, result.stderr);

  const external = join(dirname(project), 'external-output');
  await mkdir(external);
  await writeFile(join(external, 'sentinel.txt'), 'preserve\n');
  await rm(join(project, 'dist', 'src'), { recursive: true });
  await symlink(external, join(project, 'dist', 'src'), process.platform === 'win32' ? 'junction' : 'dir');

  const rejected = await run(process.execPath, [bin, 'build'], project);
  assert.notEqual(rejected.code, undefined);
  assert.match(rejected.stderr, /Runtime inputs must not be symlinks/);
  assert.equal(await readFile(join(external, 'sentinel.txt'), 'utf8'), 'preserve\n');
});

test('packaged selected-example validation rejects generated projects before foundation inspection', async t => {
  const { project, tooling } = await projectFixture(t);
  const originalProject = process.env.SQL_APPS_PROJECT_HOME;
  const originalTooling = process.env.SQL_APPS_TOOLING_HOME;
  process.env.SQL_APPS_PROJECT_HOME = project;
  process.env.SQL_APPS_TOOLING_HOME = tooling;
  try {
    const applicationBuild = await import(
      `${pathToFileURL(join(root, 'dist', 'src', 'application-build.js')).href}?application=${Date.now()}`,
    );
    await assert.rejects(
      applicationBuild.checkSelectedApplication(project, join(project, 'missing-artifact'), 'local-simulation'),
      /foundation-only selected-example/,
    );
  } finally {
    if (originalProject === undefined) delete process.env.SQL_APPS_PROJECT_HOME;
    else process.env.SQL_APPS_PROJECT_HOME = originalProject;
    if (originalTooling === undefined) delete process.env.SQL_APPS_TOOLING_HOME;
    else process.env.SQL_APPS_TOOLING_HOME = originalTooling;
  }
});

test('every packaged command target resolves outside the project and read-only commands dispatch', async t => {
  const { project, tooling } = await projectFixture(t);
  const bin = join(tooling, 'bin', 'sql-apps.mjs');
  const module = await import(`${pathToFileURL(bin).href}?commands=${Date.now()}`);
  for (const target of Object.values(module.COMMANDS)) {
    assert.equal(resolve(tooling, target).startsWith(tooling), true);
    assert.equal(resolve(tooling, target).startsWith(project + '\\dist'), false);
  }
  for (const args of [['--help'], ['setup', 'help'], ['creation', 'help'], ['consent', 'help'], ['local', 'help']]) {
    const result = await run(process.execPath, [bin, ...args], join(project, 'src'));
    assert.equal(result.code, undefined, `${args.join(' ')}: ${result.stderr}`);
  }
});

test('installed tooling owns a pre-build front door and bundles every creation asset outside the foundation', async t => {
  const { project, tooling } = await projectFixture(t);
  const load = path => import(pathToFileURL(join(tooling, 'dist', path)).href);
  const { initialProgress } = await load('src/creation-progress.mjs');
  const { writeCreationJson, readCreationJson } = await load('src/creation-session.mjs');
  const { startCreationProcess, stopCreationProcess } = await load('scripts/creation.mjs');
  const reserve = createServer();
  await new Promise(done => reserve.listen(0, '127.0.0.1', done));
  const port = reserve.address().port;
  await new Promise(done => reserve.close(done));
  const directory = join(dirname(project), 'creation-session');
  const snapshot = initialProgress({ home: project, name: 'Installed project', workspaceId: 'installed-fixture',
    publicOrigin: `http://127.0.0.1:${port}`, gatewayOrigin: `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}` });
  await writeCreationJson(join(directory, 'progress.json'), snapshot);
  await writeCreationJson(join(project, '.sql-apps', 'creation-session.json'),
    { version: 1, home: project, directory, sessionId: snapshot.sessionId });
  await startCreationProcess(directory, tooling);
  try {
    for (const path of ['/', '/__sql_apps/style.css', '/__sql_apps/progress.js', '/__sql_apps/endpoint', '/__sql_apps/endpoint.js']) {
      const response = await fetch(`${snapshot.publicOrigin}${path}`);
      assert.equal(response.status, 200, `${path} must be bundled and served by installed tooling`);
      assert.ok((await response.text()).length);
    }
    const result = await run(process.execPath, [join(tooling, 'bin', 'sql-apps.mjs'), 'creation', 'status'], join(project, 'src'));
    assert.equal(result.code, undefined, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.sessionId, snapshot.sessionId);
    assert.equal(status.connected, true);
    assert.equal(status.ready, false);
    assert.equal(status.usable, false);
    const receipt = await readCreationJson(join(directory, 'process.json'));
    await writeCreationJson(join(directory, 'process.json'), { ...receipt, pid: receipt.pid + 1 });
    await assert.rejects(stopCreationProcess(directory), /ownership/i);
    await writeCreationJson(join(directory, 'process.json'), receipt);
    assert.equal((await fetch(`${snapshot.publicOrigin}/__sql_apps/identity`)).status, 200);
  } finally {
    await stopCreationProcess(directory);
  }
});

test('generated project consent preserves domain grants and invalidates changed tooling scopes', async t => {
  const { project, tooling } = await projectFixture(t);
  const originalProject = process.env.SQL_APPS_PROJECT_HOME;
  const originalTooling = process.env.SQL_APPS_TOOLING_HOME;
  process.env.SQL_APPS_PROJECT_HOME = project;
  process.env.SQL_APPS_TOOLING_HOME = tooling;
  try {
    const nonce = Date.now();
    const consent = await import(`${pathToFileURL(join(tooling, 'dist', 'src', 'local-consent.mjs')).href}?consent=${nonce}`);
    const workspace = await import(`${pathToFileURL(join(tooling, 'dist', 'src', 'workspace.mjs')).href}?workspace=${nonce}`);
    await workspace.initializeWorkspace(project, 33000, async () => 'free');
    const request = { operation: 'role-based-app' };
    await consent.grantConsent(project, await consent.planConsent(project, request));
    await writeFile(join(project, 'sql', 'ready.sql'), 'CREATE PROCEDURE dbo.Ready AS SELECT 2 AS ready;\n');
    await writeFile(join(project, 'dab', 'dab-config.json'), '{"entities":{}}\n');
    assert.deepEqual((await consent.planConsent(project, request)).missing, []);

    const implementation = join(tooling, 'dist', 'src', 'role-based-profile.js');
    await writeFile(implementation, `${await readFile(implementation, 'utf8')}\n// changed implementation contract\n`);
    assert.deepEqual(
      (await consent.planConsent(project, request)).missing.map(item => item.scope),
      ['schema', 'services'],
    );
  } finally {
    if (originalProject === undefined) delete process.env.SQL_APPS_PROJECT_HOME;
    else process.env.SQL_APPS_PROJECT_HOME = originalProject;
    if (originalTooling === undefined) delete process.env.SQL_APPS_TOOLING_HOME;
    else process.env.SQL_APPS_TOOLING_HOME = originalTooling;
  }
});
