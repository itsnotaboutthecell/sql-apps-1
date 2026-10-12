import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = join(root, 'dist', 'tooling-project-runtime-test-package');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

async function run(command, args, cwd) {
  try {
    return await execute(command, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SQL_APPS_PROJECT_HOME: undefined },
    });
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
  }
}

async function projectFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-generated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
      entities: {
        Ready: {
          source: { type: 'stored-procedure', object: 'dbo.Ready' },
          rest: { enabled: true, path: 'Ready', methods: ['get'] },
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
  await execute(process.execPath, [join(root, 'scripts', 'build-provenance.mjs')], { cwd: root });
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
  assert.equal(JSON.parse(setupCheck.stdout).home, project);
  for (const output of [workspace.stdout, build.stdout, guide.stdout, setupCheck.stdout, setupCheck.stderr]) {
    assert.doesNotMatch(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
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
  for (const args of [['--help'], ['setup', 'help'], ['consent', 'help'], ['local', 'help']]) {
    const result = await run(process.execPath, [bin, ...args], join(project, 'src'));
    assert.equal(result.code, undefined, `${args.join(' ')}: ${result.stderr}`);
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
