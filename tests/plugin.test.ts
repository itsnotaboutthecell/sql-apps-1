import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../src/process.js';

const launcher = resolve('plugins', 'sql-apps', 'scripts', 'sql-apps.mjs');
const moduleUrl = pathToFileURL(launcher).href;
const workspaceUrl = pathToFileURL(resolve('scripts', 'workspace-check.mjs')).href;
const recordFixture = (home: string) => run(process.execPath, ['--input-type=module', '-e',
  `import { recordBuild } from ${JSON.stringify(workspaceUrl)}; await recordBuild(process.env.SQL_APPS_HOME, undefined, undefined, { foundation: true, toolingHome: process.env.SQL_APPS_HOME });`],
{ env: { SQL_APPS_HOME: home } });
const probe = async (code: string, env: NodeJS.ProcessEnv = {}) =>
  run(process.execPath, ['--input-type=module', '-e', `import { resolveHome, status, main } from ${JSON.stringify(moduleUrl)}; ${code}`], { env });

test('local plugin bundle validates its manifests, matching skill names and isolated sources', async () => {
  assert.match(await run(process.execPath, [resolve('scripts', 'check-plugin.mjs')]), /six focused skills, MIT license/);
  assert.equal(await readFile(resolve('plugins', 'sql-apps', 'LICENSE'), 'utf8'), await readFile('LICENSE', 'utf8'));
});

test('SQL Apps identity is consistent across packages, platform manifests and marketplaces', async () => {
  const repository = 'https://github.com/microsoft/sql-apps';
  for (const path of [
    'plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json',
    '.grok-plugin/plugin.json', '.kimi-plugin/plugin.json', 'plugins/sql-apps/plugin.json',
  ]) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(manifest.name, 'sql-apps', path);
    assert.equal(manifest.homepage, repository, path);
    assert.equal(manifest.repository, repository, path);
    assert.equal(manifest.version, '0.2.0', path);
    assert.deepEqual(manifest.author, { name: 'Microsoft SQL team (mssql)', url: 'https://github.com/microsoft' }, path);
    if (manifest.interface) {
      assert.equal(manifest.interface.displayName, 'SQL Apps');
      assert.equal(manifest.interface.websiteURL, repository);
      assert.equal(manifest.interface.developerName, 'Microsoft SQL team (mssql)');
    }
  }
  for (const path of ['.github/plugin/marketplace.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    const marketplace = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(marketplace.name, 'sql-apps-skills', path);
    assert.equal(marketplace.plugins.length, 1, path);
    assert.equal(marketplace.plugins[0].name, 'sql-apps', path);
    if (marketplace.owner) assert.deepEqual(marketplace.owner, { name: 'Microsoft', url: 'https://www.microsoft.com' }, path);
    if (typeof marketplace.plugins[0].source === 'string') {
      assert.equal(marketplace.plugins[0].source, './plugins/sql-apps');
    } else {
      assert.deepEqual(marketplace.plugins[0].source, { source: 'local', path: './' });
      assert.equal(marketplace.interface.displayName, 'SQL Apps Skills');
    }
  }
  const kimi = JSON.parse(await readFile('kimi-marketplace.json', 'utf8')).plugins[0];
  assert.equal(kimi.id, 'sql-apps');
  assert.equal(kimi.displayName, 'SQL Apps');
  assert.equal(kimi.source, repository);
  assert.equal(JSON.parse(await readFile('gemini-extension.json', 'utf8')).name, 'sql-apps');
  for (const [path, name] of [
    ['package.json', 'sql-apps'], ['functions/package.json', 'sql-apps-functions'],
    ['functions/local-package.json', 'sql-apps-local-functions'],
  ] as const) assert.equal(JSON.parse(await readFile(path, 'utf8')).name, name);
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(lock.name, 'sql-apps');
  assert.equal(lock.packages[''].name, 'sql-apps');
  assert.deepEqual(JSON.parse(await readFile('application.json', 'utf8')), { name: 'sql-apps-foundation', selectedExamples: [] });
  assert.match(await readFile('skills/sql-apps-getting-started/SKILL.md', 'utf8'), /^---\r?\nname: sql-apps-getting-started\r?\n/);
});

test('SQL Apps UI, wordmark and private-state exclusions use the new brand', async () => {
  const html = await readFile('public/index.html', 'utf8');
  assert.match(html, /<title>SQL Apps<\/title>/);
  assert.match(html, /<h1>SQL Apps<\/h1>/);
  assert.match(await readFile('content/icons/sql-apps-wordmark.svg', 'utf8'), /<title id="title">SQL Apps<\/title>/);
  for (const path of ['.gitignore', '.dockerignore']) {
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
    assert.ok(lines.includes(path === '.gitignore' ? '.sql-apps/' : '.sql-apps'));
    assert.ok(lines.includes('sql-apps.json'));
    assert.ok(lines.includes('functions/local.settings.json'));
  }
});

test('product guidance keeps persona selectors out of application screens', async () => {
  const html = await readFile(resolve('public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Alice|Bob|development-user|select-user/i);
  const application = await readFile(resolve('src', 'web', 'app.ts'), 'utf8');
  assert.doesNotMatch(application, /development-user|select-user|choose a development user/i);
});

test('product guidance documents authentication boundaries and hosting accurately', async () => {
  const authentication = await readFile(resolve('docs', 'reference', 'authentication.md'), 'utf8');
  for (const requirement of [
    /SQL_APPS_LOCAL_AUTH/, /\/auth\/redirect\.html/,
    /App Service.*preferred future/i, /Container Apps.*current/i,
    /SWA CLI.*mock/i, /does not prove cloud DAB identity/i,
    /Build -> Sign in -> Give access -> Publish/,
  ]) assert.match(authentication, requirement);
});

test('completed job output wraps long hashes in the shared browser UI', async () => {
  const css = await readFile(resolve('public', 'style.css'), 'utf8');
  assert.match(css, /#jobs\s+li\s*\{[^}]*overflow-wrap:\s*anywhere\s*;?[^}]*\}/);
});

test('setup safety is enforced by executable coordinator paths', async () => {
  const launcherSource = await readFile(launcher, 'utf8');
  assert.doesNotMatch(launcherSource, /Run npm run build/, 'missing-build guidance must use the guarded consent-run build path');
  assert.match(launcherSource, /consent-run build/);
  const setup = await readFile(resolve('scripts', 'setup.mjs'), 'utf8');
  assert.match(setup, /setup approve needs --approval/);
  assert.match(setup, /Setup stopped at/);
  assert.match(setup, /no automatic restart was performed/);
});

test('application boundary retains the proven SQL storage and mutation rules', async () => {
  const boundary = await readFile('docs/maintainers/application-boundary.md', 'utf8');
  for (const requirement of [
    /UTF-16 code units/, /DATALENGTH/, /nvarchar\(max\)/i,
    /enum membership.*byte length/is, /collation/i,
    /OUTPUT.*INTO.*THROW.*SELECT/is,
    /positive control/i, /HTTP201/, /DatabaseOperationFailed/,
  ]) assert.match(boundary, requirement);
});

test('SQL Apps delegates general visual design and retains app-specific state requirements', async () => {
  const design = await readFile(resolve('plugins', 'sql-apps', 'skills', 'sql-apps-design', 'SKILL.md'), 'utf8');
  assert.match(design, /maintained frontend or design skill/);
  assert.match(design, /loading, empty, error, disabled, save, and reload states/i);
  assert.doesNotMatch(design, /references\/|craft floor|style recipes/i);
  const guide = await readFile(resolve('docs', 'guides', 'build-your-app.md'), 'utf8');
  assert.match(guide, /`sql-apps-design` skill/);
});

test('agent guidance stays concise, stack-neutral and script-led', async () => {
  const read = (path: string) => readFile(resolve(path), 'utf8');
  const gettingStarted = await read('skills/sql-apps-getting-started/SKILL.md');
  const application = await read('plugins/sql-apps/skills/sql-apps-application/SKILL.md');
  const local = await read('plugins/sql-apps/skills/sql-apps-local/SKILL.md');
  const cloud = await read('plugins/sql-apps/skills/sql-apps-cloud-preview/SKILL.md');
  const validation = await read('plugins/sql-apps/skills/sql-apps-validation/SKILL.md');
  const design = await read('plugins/sql-apps/skills/sql-apps-design/SKILL.md');
  const buildGuide = await read('docs/guides/build-your-app.md');
  const runGuide = await read('docs/guides/run-locally.md');
  const guideReference = await read('docs/reference/guide.md');
  const roleBasedReference = await read('docs/reference/role-based-data.md');
  const evaluations = await read('docs/maintainers/agent-evaluations.md');
  const readme = await read('README.md');

  assert.match(buildGuide, /guide-save|guide\.mjs --save/, 'the build guide must show the mutating save command');
  assert.match(application, /saved brief/i);
  assert.match(application, /ask only.*missing/i);
  assert.match(application, /requested.*useful slice/i);
  assert.doesNotMatch(application, /Then implement the first useful change/);
  assert.doesNotMatch(application, /npm run build[\s\S]*npm test/, 'the application skill must delegate command selection');
  assert.doesNotMatch(local, /setup-check/, 'setup plan is the normal prerequisite probe');
  assert.match(cloud, /azure-prepare[\s\S]*azure-validate[\s\S]*azure-deploy/);
  assert.match(cloud, /azure-cost/);
  assert.match(cloud, /compatibility path for existing projects/);
  assert.doesNotMatch(readme, /Static Web Apps candidate/);
  assert.doesNotMatch(readme, /uses TypeScript, Azure SQL Database, Data API builder, Blob Storage and Azure Functions/);
  await assert.rejects(read('docs/superpowers/plans/2026-10-10-bakery-ordering.md'));
  await assert.rejects(read('docs/superpowers/specs/2026-10-10-bakery-ordering-design.md'));
  assert.match(await read('docs/README.md'), /Temporary implementation plans.*not product guidance/is);

  assert.match(design, /maintained frontend or design skill/);
  assert.match(design, /Product screens show real account and access states/);
  assert.doesNotMatch(design, /references\/|craft floor|style recipes/i);

  const statusPhrase = /implemented.*built.*running.*workflow[- ]verified/gi;
  const skillMentions = [gettingStarted, application, local, cloud, validation, design]
    .reduce((count, content) => count + (content.match(statusPhrase)?.length ?? 0), 0);
  assert.equal(skillMentions, 1, 'the validation skill owns structured status vocabulary');
  for (const [path, content] of [
    ['README.md', readme],
    ['docs/guides/run-locally.md', runGuide],
    ['docs/reference/guide.md', guideReference],
    ['docs/reference/role-based-data.md', roleBasedReference],
    ['docs/maintainers/agent-evaluations.md', evaluations],
  ] as const) assert.doesNotMatch(content, statusPhrase, path);
  assert.doesNotMatch(design, /Done \/ Working \/ Next \/ Blocked/);
});

test('plugin launcher binds the actual checkout independently of plugin cache/session directory', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'sql-apps-plugin-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const home = resolve('.');
  await writeFile(join(profile, 'sql-apps-local.json'), JSON.stringify({ version: 1, home }));
  assert.equal((await probe('process.chdir(process.env.COPILOT_HOME); console.log(await resolveHome());',
    { COPILOT_HOME: profile, SQL_APPS_HOME: undefined })).trim(), home);
  assert.equal((await probe('console.log(await resolveHome());', { SQL_APPS_HOME: home })).trim(), home);
});

test('plugin launcher reports invalid bindings and commands rather than falling back silently', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'sql-apps-plugin-invalid-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await mkdir(join(profile, 'not-sql-apps'));
  await writeFile(join(profile, 'sql-apps-local.json'), '{ invalid');
  await assert.rejects(probe('process.chdir(process.env.COPILOT_HOME); await resolveHome();',
    { COPILOT_HOME: profile, SQL_APPS_HOME: undefined }), /JSON|SyntaxError/);
  await assert.rejects(probe('await resolveHome();', { SQL_APPS_HOME: join(profile, 'not-sql-apps') }), /ENOENT/);
  await assert.rejects(run(process.execPath, [launcher, 'deploy']), /Unsupported plugin command/);
  await assert.rejects(run(process.execPath, [launcher, 'verify', 'invalid;container']), /Invalid SQL container name/);
});

test('plugin status is bounded, read-only and distinguishes healthy, HTTP failure and connection failure', async () => {
  const result = await probe(`
    let calls = 0;
    const result = await status(async (url, options) => {
      if (!options.signal || options.redirect !== 'error') throw new Error('Missing bounded probe options');
      calls++;
      if (calls === 1) return new Response('{}', { status: 200 });
      if (calls === 2) return new Response('{}', { status: 503 });
      throw new TypeError('Network unavailable');
    });
    console.log(JSON.stringify(result));`);
  const body = JSON.parse(result);
  assert.equal(body.healthy, false);
  assert.equal(body.services.length, 3);
  assert.equal(body.services[0].healthy, true);
  assert.equal(body.services[1].status, 503);
  assert.equal(body.services[2].error, 'TypeError');
  const good = JSON.parse(await probe("console.log(JSON.stringify(await status(async () => new Response('{}'))));"));
  assert.equal(good.healthy, true);
});

test('plugin dispatch uses checkout cwd, passes literal arguments and preserves CLI failure', async t => {
  const home = await mkdtemp(join(tmpdir(), 'sql apps dispatch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const folder of ['src', 'sql', 'plugins/sql-apps', 'dist/src', 'scripts']) await mkdir(join(home, folder), { recursive: true });
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'sql-apps', scripts: { local: 'node dist/src/local-cli.js' } }));
  for (const file of ['src/local-cli.ts', 'sql/database.sqlproj', 'plugins/sql-apps/plugin.json']) await writeFile(join(home, file), '');
  await writeFile(join(home, 'src', 'workspace.mjs'), await readFile(resolve('src', 'workspace.mjs')));
  await writeFile(join(home, 'application.json'), JSON.stringify({ name: 'fixture', selectedExamples: [] }));
  await writeFile(join(home, 'runtime-contract.json'), JSON.stringify({ version: 1, capabilities: ['local', 'setup-check'] }));
  await writeFile(join(home, 'scripts', 'workspace-check.mjs'), await readFile(resolve('scripts', 'workspace-check.mjs')));
  await writeFile(join(home, 'src', 'project-contract.mjs'), await readFile(resolve('src', 'project-contract.mjs')));
  await writeFile(join(home, 'src', 'tooling-context.mjs'), await readFile(resolve('src', 'tooling-context.mjs')));
  await assert.rejects(run(process.execPath, [launcher, 'verify'], { env: { SQL_APPS_HOME: home } }), /not built/);
  await writeFile(join(home, 'dist/src/local-cli.js'),
    'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); if(process.argv[2]==="test") process.exitCode=7;');
  await recordFixture(home);
  const output = JSON.parse(await run(process.execPath, [launcher, 'verify', 'custom-sql'], { env: { SQL_APPS_HOME: home } }));
  assert.equal(output.cwd, home);
  assert.deepEqual(output.args, ['verify', 'custom-sql']);
  for (const command of ['role-based-app', 'role-based-serve']) {
    const selected = JSON.parse(await run(process.execPath, [launcher, command, 'custom-sql'], { env: { SQL_APPS_HOME: home } }));
    assert.equal(selected.cwd, home);
    assert.deepEqual(selected.args, [command, 'custom-sql']);
  }
  const artifact = join(home, '.sql-apps', 'selected artifact; literal');
  for (const command of ['selected-app', 'selected-serve', 'selected-test']) {
    const selected = JSON.parse(await run(process.execPath, [launcher, command, artifact], { env: { SQL_APPS_HOME: home } }));
    assert.equal(selected.cwd, home);
    assert.deepEqual(selected.args, [command, artifact]);
    await assert.rejects(run(process.execPath, [launcher, command, 'relative-artifact'], { env: { SQL_APPS_HOME: home } }), /absolute artifact/);
  }
  const stopped = JSON.parse(await run(process.execPath, [launcher, 'selected-stop', 'inventory'], { env: { SQL_APPS_HOME: home } }));
  assert.deepEqual(stopped.args, ['selected-stop', 'inventory']);
  const configuredStatus = JSON.parse(await probe(`
    const { initializeWorkspace } = await import(${JSON.stringify(pathToFileURL(resolve('src', 'workspace.mjs')).href)});
    await initializeWorkspace(process.env.SQL_APPS_HOME, 31000, async () => 'free');
    globalThis.fetch = async () => new Response('{}');
    await main(['status']);`, { SQL_APPS_HOME: home }));
  assert.deepEqual(configuredStatus.services.map((service: { url: string }) => service.url), [
    'http://127.0.0.1:31000/health/live', 'http://127.0.0.1:31000/health/ready', 'http://127.0.0.1:31001/health',
  ]);
  await writeFile(join(home, 'scripts/setup-check.mjs'),
    'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); if(process.argv.includes("fail-sql")) process.exitCode=7;');
  const setup = JSON.parse(await run(process.execPath, [launcher, 'setup-check', 'custom-sql'], { env: { SQL_APPS_HOME: home } }));
  assert.equal(setup.cwd, home);
  assert.deepEqual(setup.args, ['--json', '--container', 'custom-sql']);
  const roleBasedSetup = JSON.parse(await run(process.execPath, [launcher, 'role-based-setup-check', 'custom-sql'], { env: { SQL_APPS_HOME: home } }));
  assert.deepEqual(roleBasedSetup.args, ['--json', '--profile', 'role-based-data', '--container', 'custom-sql']);
  await rm(join(home, 'dist'), { recursive: true });
  await writeFile(join(home, 'scripts/setup.mjs'),
    'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
  const journey = JSON.parse(await run(process.execPath,
    [launcher, 'setup', 'plan', '--profile', 'role-based-data', '--workspace', '30000', '--json'],
    { env: { SQL_APPS_HOME: home } }));
  assert.equal(journey.cwd, home);
  assert.deepEqual(journey.args, ['plan', '--profile', 'role-based-data', '--workspace', '30000', '--json']);
  await writeFile(join(home, 'scripts/guide.mjs'),
    'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
  const guided = JSON.parse(await run(process.execPath, [launcher, 'guide'], { env: { SQL_APPS_HOME: home } }));
  assert.equal(guided.cwd, home);
  assert.deepEqual(guided.args, ['--json']);
  const briefPath = join(home, 'equipment brief.json');
  const savedGuide = JSON.parse(await run(process.execPath, [launcher, 'guide-save', briefPath], { env: { SQL_APPS_HOME: home } }));
  assert.equal(savedGuide.cwd, home);
  assert.deepEqual(savedGuide.args, ['--save', briefPath, '--json']);
  await assert.rejects(run(process.execPath, [launcher, 'guide-save', 'relative.json'], { env: { SQL_APPS_HOME: home } }), /absolute project brief/);
  await assert.rejects(run(process.execPath, [launcher, 'guide', 'extra'], { env: { SQL_APPS_HOME: home } }), /no arguments/);
  const beforeBuild = JSON.parse(await run(process.execPath, [launcher, 'setup-check'], { env: { SQL_APPS_HOME: home } }));
  assert.deepEqual(beforeBuild.args, ['--json']);
  await writeFile(join(home, 'scripts/local-consent.mjs'),
    'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
  for (const [command, args] of [
    ['consent-plan', ['role-based-app', 'custom-sql']],
    ['consent-status', ['build']],
    ['consent-grant', [briefPath]],
    ['consent-grant-once', [briefPath]],
    ['consent-terms', [briefPath]],
    ['consent-revoke', ['terms']],
    ['consent-run', ['build']],
  ] as const) {
    const consent = JSON.parse(await run(process.execPath, [launcher, command, ...args], { env: { SQL_APPS_HOME: home } }));
    assert.equal(consent.cwd, home);
    assert.deepEqual(consent.args, [command.replace('consent-', ''), ...args]);
  }
  await assert.rejects(run(process.execPath, [launcher, 'consent-grant', 'relative.json'], { env: { SQL_APPS_HOME: home } }), /absolute/);
  await assert.rejects(run(process.execPath, [launcher, 'consent-plan'], { env: { SQL_APPS_HOME: home } }), /operation/);
  await assert.rejects(run(process.execPath, [launcher, 'setup-check', 'fail-sql'], { env: { SQL_APPS_HOME: home } }), /failed \(7\)/);
  await mkdir(join(home, 'dist/src'), { recursive: true });
  await writeFile(join(home, 'dist/src/local-cli.js'), 'process.exitCode=7;');
  await recordFixture(home);
  await assert.rejects(run(process.execPath, [launcher, 'test'], { env: { SQL_APPS_HOME: home } }), /failed \(7\)/);
});
