import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFile, cp, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { before, test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = join(root, 'dist', 'tooling-package');

async function runNode(args, options = {}) {
  return execute(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function runNpm(args, options = {}) {
  const command = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm ${args.join(' ')}`]
    : args;
  return execute(command, commandArgs, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function pathsBelow(directory) {
  const paths = [];
  async function visit(current) {
    for (const entry of await readdir(current)) {
      const path = join(current, entry);
      const stat = await lstat(path);
      paths.push(relative(directory, path).replaceAll('\\', '/'));
      if (stat.isDirectory()) await visit(path);
    }
  }
  await visit(directory);
  return paths.sort();
}

before(async () => {
  const { inspectSource } = await import('../scripts/workspace-check.mjs');
  const source = await inspectSource(root, { toolingHome: root, foundation: true });
  if (!source.build?.ready) await runNode([join(root, 'scripts', 'build-provenance.mjs')]);
  await runNode([join(root, 'scripts', 'build-tooling-package.mjs')]);
});

test('tooling ships endpoint helpers, the pinned host DAB manifest and SQL-only provisioning', async () => {
  for (const file of [
    'dist/src/sql-target.mjs', 'dist/src/sql-endpoint.js', 'dist/src/endpoint-local.js',
    'dist/src/local-data-process.js', 'dist/src/azure-sql-development.js',
    'assets/scripts/sql-express.ps1', 'assets/infra/development-sql.bicep',
  ]) assert.ok((await lstat(join(staged, file))).isFile(), file);
  const manifest = JSON.parse(await readFile(join(staged, 'assets', '.config', 'host-dab', 'dotnet-tools.json'), 'utf8'));
  assert.equal(manifest.tools['microsoft.dataapibuilder'].version, '2.0.12');
});

test('tooling:pack uses a POSIX-portable package path', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['tooling:pack'],
    'npm run tooling:build && npm run tooling:check && npm pack ./dist/tooling-package',
  );
});

test('stages publishable package metadata with synchronized exact runtime dependencies', async () => {
  const [pkg, source, rootPackage] = await Promise.all([
    readFile(join(staged, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'packages', 'sql-apps', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const expectedDependencies = {
    ...rootPackage.dependencies,
    '@azure/static-web-apps-cli': rootPackage.devDependencies['@azure/static-web-apps-cli'],
    esbuild: rootPackage.devDependencies.esbuild,
    typescript: rootPackage.devDependencies.typescript,
  };

  for (const candidate of [source, pkg]) {
    assert.equal(candidate.name, '@microsoft/sql-apps');
    assert.equal(candidate.version, '0.2.2');
    assert.equal(candidate.type, 'module');
    assert.deepEqual(candidate.bin, { 'sql-apps': 'bin/sql-apps.mjs' });
    assert.equal(Object.hasOwn(candidate, 'private'), false);
    assert.deepEqual(candidate.files, ['bin', 'dist', 'assets']);
    assert.equal(candidate.license, 'MIT');
    assert.deepEqual(candidate.engines, { node: '>=22 <23 || >=24 <25' });
    assert.deepEqual(candidate.exports, {
      './project-contract': './dist/src/project-contract.mjs',
      './tooling-context': './dist/src/tooling-context.mjs',
      './browser': { types: './dist/src/browser.d.ts', default: './dist/src/browser.js' },
    });
    assert.deepEqual(candidate.dependencies, expectedDependencies);
    for (const version of Object.values(candidate.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    }
  }
});

test('staged tree contains only package files and immutable runtime assets', async () => {
  const paths = await pathsBelow(staged);
  const excluded = /(^|\/)(?:\.git|\.sql-apps|examples|tests|node_modules|plugins)(?:\/|$)|(^|\/)\.env[^/]*$/;
  assert.equal(paths.some(path => excluded.test(path)), false, paths.join('\n'));
  assert.equal(paths.some(path => path.startsWith('src/') || path.startsWith('scripts/')), false);
  assert(paths.includes('LICENSE'));
  assert(paths.includes('bin/sql-apps.mjs'));
  assert(paths.includes('dist/src/project-contract.mjs'));
  assert.equal(paths.includes('assets/src/web/auth-view.ts'), false);
  assert(paths.includes('assets/src/web/app.ts'));
  for (const path of paths) {
    assert.equal((await lstat(join(staged, path))).isSymbolicLink(), false, path);
  }
});

test('packaged check compares project UI with the shipped template', async t => {
  const project = await mkdtemp(join(tmpdir(), 'sql-apps-design-template-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await cp(join(staged, 'assets', 'src'), join(project, 'src'), { recursive: true });
  await cp(join(staged, 'assets', 'public'), join(project, 'public'), { recursive: true });
  for (const directory of ['dab', 'sql', 'tests', 'dist/tests', 'dist/src', 'docs']) {
    await mkdir(join(project, directory), { recursive: true });
  }
  await writeFile(join(project, 'application.json'), JSON.stringify({ name: 'fixture', selectedExamples: [] }));
  await writeFile(join(project, 'role-based-data.json'), JSON.stringify({
    requiredRole: 'AppUser', readinessPath: '/api/AppReady',
  }));
  await writeFile(join(project, 'public', 'app.js'), 'document.body.dataset.ready = "true";');
  for (const file of ['dist/src/client.js', 'dist/src/server.js']) await writeFile(join(project, file), '');
  for (const file of ['Dockerfile']) {
    await writeFile(join(project, file), 'COPY --from=build /app/dist/src ./dist/src');
  }
  const checker = join(staged, 'dist', 'scripts', 'check-application.mjs');
  const unchanged = await runNode([checker, project]);
  assert.doesNotMatch(unchanged.stdout, /Design warning|Design acceptance|Rendered coverage/);

  await writeFile(join(project, 'src', 'web', 'app.ts'),
    `${await readFile(join(project, 'src', 'web', 'app.ts'), 'utf8')}\ndocument.body.dataset.custom = "true";\n`);
  const customized = await runNode([checker, project]);
  assert.match(customized.stdout, /Design warning: customized UI/);
  assert.match(customized.stdout, /Rendered coverage: partial: 22 unreviewed cells/);
  assert.match(customized.stdout, /Design acceptance: partial: design intent missing; 22 unreviewed cells/);
});

test('bin help is project-independent and its validated command map targets packaged modules', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'sql-apps-bin-'));
  try {
    const bin = join(staged, 'bin', 'sql-apps.mjs');
    const result = await runNode([bin, '--help'], { cwd: empty });
    assert.match(result.stdout, /Usage: sql-apps <command>/);
    assert.equal(result.stderr, '');

    const module = await import(`${pathToFileURL(bin).href}?test=${Date.now()}`);
    assert.deepEqual(module.COMMANDS, {
      build: 'dist/scripts/build-provenance.mjs',
      setup: 'dist/scripts/setup.mjs',
      creation: 'dist/scripts/creation.mjs',
      'setup-check': 'dist/scripts/setup-check.mjs',
      guide: 'dist/scripts/guide.mjs',
      'workspace-check': 'dist/scripts/workspace-check.mjs',
      consent: 'dist/scripts/local-consent.mjs',
      local: 'dist/src/local-cli.js',
      publish: 'dist/src/personal-free-cli.js',
      check: 'dist/scripts/check-application.mjs',
      'check-api': 'dist/scripts/check-application-api.mjs',
    });
    const originalArgv = process.argv;
    const originalHome = process.env.SQL_APPS_PROJECT_HOME;
    let imported;
    try {
      await module.dispatch('setup', ['status'], empty, async specifier => { imported = specifier; });
      assert.equal(process.env.SQL_APPS_PROJECT_HOME, empty);
      assert.deepEqual(process.argv.slice(2), ['status']);
      assert.equal(fileURLToPath(imported), join(staged, 'dist', 'scripts', 'setup.mjs'));
    } finally {
      process.argv = originalArgv;
      if (originalHome === undefined) delete process.env.SQL_APPS_PROJECT_HOME;
      else process.env.SQL_APPS_PROJECT_HOME = originalHome;
    }
    await assert.rejects(runNode([bin, 'unknown'], { cwd: empty }), error => {
      assert.match(error.stderr, /Unknown command/);
      return true;
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('bin dispatches from the project root when invoked in a nested directory', async t => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-bin-project-')));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const packageRoot = join(fixture, 'package');
  const project = join(fixture, 'project');
  const nested = join(project, 'one', 'two');
  await Promise.all([
    mkdir(join(packageRoot, 'bin'), { recursive: true }),
    mkdir(join(packageRoot, 'dist', 'src'), { recursive: true }),
    mkdir(join(packageRoot, 'dist', 'scripts'), { recursive: true }),
    mkdir(nested, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(staged, 'bin', 'sql-apps.mjs'), join(packageRoot, 'bin', 'sql-apps.mjs')),
    copyFile(
      join(staged, 'dist', 'src', 'project-contract.mjs'),
      join(packageRoot, 'dist', 'src', 'project-contract.mjs'),
    ),
    writeFile(
      join(packageRoot, 'dist', 'scripts', 'setup.mjs'),
      'console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.SQL_APPS_PROJECT_HOME }));\n',
    ),
    writeFile(join(project, '.sql-apps-project.json'), `${JSON.stringify({
      version: 1,
      id: 'b91d4857-9570-4d4b-a740-918471ca7e26',
      name: 'Nested Project',
      slug: 'nested-project',
      starter: 'data',
      profile: 'role-based-data',
      scaffoldVersion: 1,
      tooling: { package: '@microsoft/sql-apps', version: '0.2.2' },
    })}\n`),
  ]);

  const result = await runNode([join(packageRoot, 'bin', 'sql-apps.mjs'), 'setup'], { cwd: nested });
  assert.deepEqual(JSON.parse(result.stdout), { cwd: project, home: project });
});

test('package tree validation rejects links', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'sql-apps-package-link-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'bin'));
  await writeFile(join(fixture, 'target'), 'target');
  try {
    await symlink(join(fixture, 'target'), join(fixture, 'bin', 'linked'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const { validatePackageTree } = await import('../scripts/check-tooling-package.mjs');
  await assert.rejects(validatePackageTree(fixture), /link/i);
});

test('tooling package check validates npm dry-run contents', async () => {
  const result = await runNode([join(root, 'scripts', 'check-tooling-package.mjs')]);
  assert.match(result.stdout, /Tooling package checks passed/);
});

test('tooling:check rejects an unexpected staged file without removing it', async t => {
  const unexpected = join(staged, 'unexpected.txt');
  await writeFile(unexpected, 'unexpected');
  t.after(() => rm(unexpected, { force: true }));

  await assert.rejects(runNpm(['run', 'tooling:check']), error => {
    assert.match(`${error.stdout}\n${error.stderr}`, /Unexpected top-level package path: unexpected\.txt/);
    return true;
  });
  assert.equal(await readFile(unexpected, 'utf8'), 'unexpected');
});

test('tooling:check rejects missing package.json files trees without rebuilding', async () => {
  for (const tree of ['bin', 'dist', 'assets']) {
    const source = join(staged, tree);
    const held = `${staged}-${tree}-${Date.now()}`;
    await rename(source, held);
    try {
      await assert.rejects(runNpm(['run', 'tooling:check']), error => {
        assert.match(`${error.stdout}\n${error.stderr}`, new RegExp(`Missing required package tree: ${tree}`));
        return true;
      });
    } finally {
      await rename(held, source);
    }
  }
});
