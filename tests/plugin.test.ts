import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
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
const skillPaths = [
  'skills/sql-apps-getting-started/SKILL.md',
  ...['application', 'local', 'validation', 'cloud-preview', 'diagnostics', 'design']
    .map(name => `plugins/sql-apps/skills/sql-apps-${name}/SKILL.md`),
];

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
    assert.equal(manifest.version, '0.2.2', path);
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
  assert.equal(JSON.parse(await readFile('package.json', 'utf8')).name, 'sql-apps');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(lock.name, 'sql-apps');
  assert.equal(lock.packages[''].name, 'sql-apps');
  assert.deepEqual(JSON.parse(await readFile('application.json', 'utf8')), { name: 'sql-apps', selectedExamples: [] });
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
    /Personal-free Azure deployment/,
    /Static Web Apps built-in authentication/i, /does not prove cloud DAB identity/i,
    /Build -> Sign in -> Give access -> Publish/,
  ]) assert.match(authentication, requirement);
});

test('readiness output wraps long values in the shared browser UI', async () => {
  const css = await readFile(resolve('public', 'style.css'), 'utf8');
  assert.match(css, /pre\s*\{[^}]*overflow-wrap:\s*anywhere\s*;?[^}]*\}/);
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

test('SQL Apps routes new apps and meaningful UI changes through intentional design', async () => {
  const gettingStarted = await readFile(resolve('skills', 'sql-apps-getting-started', 'SKILL.md'), 'utf8');
  const application = await readFile(resolve('plugins', 'sql-apps', 'skills', 'sql-apps-application', 'SKILL.md'), 'utf8');
  const design = await readFile(resolve('plugins', 'sql-apps', 'skills', 'sql-apps-design', 'SKILL.md'), 'utf8');
  const validation = await readFile(resolve('plugins', 'sql-apps', 'skills', 'sql-apps-validation', 'SKILL.md'), 'utf8');
  const pluginReference = await readFile(resolve('docs', 'reference', 'copilot-plugin.md'), 'utf8');
  const runGuide = await readFile(resolve('docs', 'guides', 'run-locally.md'), 'utf8');
  assert.match(application, /before implementing a new user-facing app or meaningful UI change[\s\S]*sql-apps-design/i);
  assert.doesNotMatch(application, /sql-apps-design` for substantial|substantial visual work/i);
  assert.match(application, /basic shell.*small scope.*(?:not|never).*unfinished visual quality/is);

  assert.match(gettingStarted, /every new user-facing app and meaningful UI change[\s\S]*through `sql-apps-design`/i);
  assert.match(gettingStarted, /owns the design pass/i);
  assert.doesNotMatch(gettingStarted, /optional design|design is optional/i);

  assert.match(design, /starter CSS.*not.*design direction/is);
  assert.match(design, /typography, spacing, color, and layout.*hierarchy/i);
  assert.match(design, /each surface one clear primary action/i);
  assert.match(design, /secondary and destructive actions.*distinct/i);
  assert.match(design, /wrapping long content/i);
  assert.match(design, /readable line lengths/i);
  assert.match(design, /keyboard focus[\s\S]*semantic structure[\s\S]*accessible labels/i);
  assert.match(design, /status.*text or iconography.*never color alone/i);
  assert.match(design, /account, setup, and administration secondary/i);
  for (const state of ['signed-out', 'authorized', 'no-access', 'loading', 'empty', 'error', 'saving', 'success', 'disabled']) {
    assert.match(design.toLowerCase(), new RegExp(state), `design guidance must cover ${state}`);
  }
  assert.match(design, /recurring task/i);
  assert.match(design, /two distinct compositions/i);
  assert.match(design, /empty, single-record, and populated states/i);
  assert.match(design, /desktop and narrow widths/i);
  assert.match(design, /Fix observed problems and re-review/i);
  assert.match(design, /Source review and compilation are not visual review/i);
  assert.match(design, /docs\/design-intent\.md/);
  assert.match(design, /docs\/design-review\.md/);
  assert.match(design, /sql-apps check/i);
  assert.match(design, /Functional acceptance and design acceptance are separate/i);
  assert.match(design, /first implementation is a candidate, not an approved design/i);
  assert.match(design, /representative primary-task screen at desktop and narrow widths together/i);
  assert.match(design, /first viewport[\s\S]*defining information[\s\S]*unrelated app[\s\S]*removed or demoted[\s\S]*three highest-impact/i);
  assert.match(design, /visible problem, task consequence and concrete change/i);
  assert.match(design, /not a loop count/i);
  assert.match(design, /Expand\*\* to remaining states once the composition stabilizes/i);
  assert.match(design, /Coverage is not quality/i);
  assert.match(validation, /render-critique-improve loop before broad coverage/i);
  assert.match(validation, /rendered coverage and design quality separately/i);
  assert.doesNotMatch(design, /references\/|craft floor|style recipes/i);
  assert.match(application, /basic shell is an implementation milestone, not final design acceptance/i);
  assert.match(application, /sql-apps-validation[\s\S]*four-verdict/i);
  const guide = await readFile(resolve('docs', 'guides', 'build-your-app.md'), 'utf8');
  assert.match(guide, /`sql-apps-design` skill[\s\S]*(?:every|all|normal)/i);

  assert.match(pluginReference, /`sql-apps-design`\s*\|[^\n]*every new user-facing app[^\n]*meaningful UI change/i);
  assert.match(pluginReference, /owns design direction and rendered review/i);
  assert.match(pluginReference, /real account\/access states/i);
  for (const state of ['loading', 'empty', 'error', 'saving', 'success', 'disabled']) {
    assert.match(pluginReference.toLowerCase(), new RegExp(`\\b${state}\\b`), `plugin reference must cover ${state}`);
  }
  assert.doesNotMatch(pluginReference, /small routing adapter|routing adapter/i);
  assert.match(await readFile(resolve('plugins/sql-apps/skills/sql-apps-validation/SKILL.md'), 'utf8'),
    /implemented\/built[\s\S]*running[\s\S]*functional acceptance[\s\S]*design acceptance/i);

  assert.match(runGuide, /route every new user-facing application and meaningful UI change through `sql-apps-design`/i);
  assert.doesNotMatch(runGuide, /all user-facing work/i);
  assert.match(runGuide, /host supports rendered review[\s\S]*desktop[\s\S]*narrow widths/i);
  assert.match(runGuide, /otherwise[\s\S]*exact blocked or unobserved evidence[\s\S]*do not claim visual acceptance/i);
  assert.doesNotMatch(runGuide, /substantial (?:UI|visual) work|when feasible/i);
});

test('SQL Apps design is self-contained and does not require external design skills', async () => {
  const paths = [
    'plugins/sql-apps/skills/sql-apps-design/SKILL.md',
    'skills/sql-apps-getting-started/SKILL.md',
    'docs/reference/copilot-plugin.md',
    'docs/reference/design-acceptance.md',
    'docs/maintainers/agent-evaluations.md',
  ];
  const contents = await Promise.all(paths.map(path => readFile(resolve(path), 'utf8')));
  for (const [index, content] of contents.entries()) {
    assert.doesNotMatch(content,
      /web-artifacts-builder|\bfrontend-design\b|manual fallback|stack-neutral fallback|discovers and invokes/i,
      `${paths[index]} must not route design through an external skill or fallback`);
  }
  const [design, gettingStarted, pluginReference, acceptance] = contents;
  assert.ok(design && gettingStarted && pluginReference && acceptance);
  assert.match(design, /Own the design pass/i);
  for (const content of [design, gettingStarted, pluginReference]) {
    assert.match(content, /no companion skill is required/i);
  }
  assert.match(acceptance, /^- Skill: sql-apps-design$/m);
  assert.ok(design.trim().split(/\s+/).length <= 400, 'Keep the design skill within a 400-word context budget');
});

test('SQL Apps requires rendered browser review with bounded evidence claims', async () => {
  const read = (path: string) => readFile(resolve(path), 'utf8');
  const gettingStarted = await read('skills/sql-apps-getting-started/SKILL.md');
  const application = await read('plugins/sql-apps/skills/sql-apps-application/SKILL.md');
  const local = await read('plugins/sql-apps/skills/sql-apps-local/SKILL.md');
  const validation = await read('plugins/sql-apps/skills/sql-apps-validation/SKILL.md');
  const boundary = await read('docs/maintainers/application-boundary.md');

  for (const [name, content] of [
    ['application', application], ['local', local], ['getting started', gettingStarted],
  ] as const) {
    assert.match(content, /sql-apps-validation/i, `${name} must hand evidence collection to validation`);
    assert.match(content, /required rendered (?:browser )?review/i, `${name} must preserve the rendered-review requirement`);
    assert.doesNotMatch(content, /semantic browser inspection|page handles|user-reported/i,
      `${name} must not duplicate the browser evidence procedure`);
  }
  assert.doesNotMatch(`${application}\n${local}`, /(?:before implementing|complete|for) user-facing work/i);

  assert.match(validation, /API\/SQL[\s\S]*browser workflow[\s\S]*rendered visual review/i);
  assert.match(validation, /verify the intended origin/i);
  assert.match(validation, /semantic browser inspection[\s\S]*real interactions/i);
  assert.match(validation, /desktop[\s\S]*narrow/i);
  assert.match(validation, /never invent.*(?:page )?handles|do not invent.*(?:page )?handles/i);
  assert.match(validation, /opening a tab.*not.*visual review|source review.*not.*visual review/is);
  assert.match(validation, /discover.*supported.*alternatives/i);
  assert.match(validation, /if blocked[\s\S]*exact evidence not observed/i);
  assert.match(validation, /origin[\s\S]*source\/build[\s\S]*viewport[\s\S]*state[\s\S]*artifact[\s\S]*findings[\s\S]*re-review/i);
  assert.match(validation, /screenshots.*do not prove.*(?:persistence|access)/i);
  assert.match(validation, /compile.*do not prove.*visual/i);
  assert.match(gettingStarted, /after authorized startup[\s\S]*real browser action[\s\S]*SQL save\/reload/i);
  assert.match(gettingStarted, /never claim unobserved checks passed/i);
  assert.match(boundary, /blocked[\s\S]*user-reported/i);
});

test('workflow skill descriptions use discovery triggers rather than workflow summaries', async () => {
  const contents = await Promise.all(skillPaths.map(path => readFile(resolve(path), 'utf8')));
  for (const [index, content] of contents.entries()) {
    const description = content.match(/^description: "?([^\r\n]+?)"?$/m)?.[1];
    assert.ok(description, `${skillPaths[index]} needs a description`);
    assert.ok(description.startsWith('Use when '), `${skillPaths[index]} needs a trigger-focused description`);
    assert.ok(!/\brouting\b|[.;]\s*route\b/i.test(description),
      `${skillPaths[index]} must keep routing instructions in its body`);
  }
});

test('validation distinguishes generated applications from foundation maintenance', async () => {
  const validation = await readFile(resolve('plugins/sql-apps/skills/sql-apps-validation/SKILL.md'), 'utf8');
  assert.ok(/Inspect `package\.json`/i.test(validation), 'Select checks from the actual target package');
  assert.ok(/sqlApps\.project/i.test(validation), 'Identify generated apps using their package metadata');
  assert.ok(/## Generated applications/.test(validation), 'Generated-app commands need their own scope');
  assert.ok(/## Foundation and plugin maintenance/.test(validation), 'Foundation checks need their own scope');
  const foundation = validation.split('## Foundation and plugin maintenance')[1]?.split('\n## ')[0];
  assert.ok(foundation?.includes('npm run plugin:check'), 'Keep plugin checking in the foundation scope');
  assert.ok(/full suite only/i.test(validation), 'Do not default every focused change to the full suite');
});

test('publisher guidance scopes maintainer checks without weakening deployment guards', async () => {
  const cloud = await readFile(resolve('plugins/sql-apps/skills/sql-apps-cloud-preview/SKILL.md'), 'utf8');
  assert.ok(/Initialize local configuration/i.test(cloud), 'Initialization writes local configuration');
  assert.ok(/For foundation publisher changes/i.test(cloud), 'Repository regression checks belong to publisher maintenance');
  assert.ok(!/Before presenting this route as executable/i.test(cloud), 'Routine publishing must not assume foundation tests');
  for (const requirement of [
    /project=sql-apps/, /deployment=personal-free/, /environment/,
    /Cost guard: verified/, /explicit approval/i, /never email/i,
    /0\.0\.0\.0/, /live Azure validation/i, /disclose unverified implementation or live canary checks/i,
  ]) assert.match(cloud, requirement);
});

test('diagnostics establishes local evidence before specialist routing', async () => {
  const diagnostics = await readFile(resolve('plugins/sql-apps/skills/sql-apps-diagnostics/SKILL.md'), 'utf8');
  const local = diagnostics.indexOf('## Diagnose the selected app');
  const specialist = diagnostics.indexOf('## Escalate the isolated issue');
  assert.ok(local >= 0 && specialist > local, 'Diagnose the SQL Apps boundary before loading platform specialists');
  assert.match(diagnostics, /positive control/i);
  assert.match(diagnostics, /explicit approval/i);
});

test('workflow skills stay within their shared context budget', async () => {
  const contents = await Promise.all(skillPaths.map(path => readFile(resolve(path), 'utf8')));
  const words = contents.reduce((total, content) => total + content.trim().split(/\s+/).length, 0);
  assert.ok(words <= 2800, `The seven active skills use ${words} words; expected at most 2800`);
});

test('design and review guidance preserves access, consent, state and stack boundaries', async () => {
  const read = (path: string) => readFile(resolve(path), 'utf8');
  const application = await read('plugins/sql-apps/skills/sql-apps-application/SKILL.md');
  const design = await read('plugins/sql-apps/skills/sql-apps-design/SKILL.md');
  const local = await read('plugins/sql-apps/skills/sql-apps-local/SKILL.md');
  const validation = await read('plugins/sql-apps/skills/sql-apps-validation/SKILL.md');
  const combined = [application, design, local, validation].join('\n');

  assert.match(design, /visual approval does not authorize schema, identity, data, or startup changes/i);
  assert.match(local, /never manufacture a grant, bypass a blocker/i);
  assert.match(application, /keep.*database.*access.*separate|database and access decisions.*separate/i);
  assert.doesNotMatch(combined, /must (?:use|install) (?:React|Tailwind|Bootstrap|Playwright|Puppeteer)|mandatory (?:framework|font|package|asset)/i);
  assert.doesNotMatch(combined, /saved design brief|design report schema|visual evidence database/i);
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
  const sharing = await read('docs/guides/sharing.md');
  const evaluations = await read('docs/maintainers/agent-evaluations.md');
  const readme = await read('README.md');

  assert.match(buildGuide, /guide-save|guide\.mjs --save/, 'the build guide must show the mutating save command');
  assert.match(application, /saved brief/i);
  assert.match(application, /ask only.*missing/i);
  assert.match(application, /requested.*useful slice/i);
  assert.doesNotMatch(application, /Then implement the first useful change/);
  assert.doesNotMatch(application, /npm run build[\s\S]*npm test/, 'the application skill must delegate command selection');
  assert.doesNotMatch(local, /setup-check/, 'setup plan is the normal prerequisite probe');
  assert.match(cloud, /personal-free[\s\S]*only bundled cloud profile/i);
  assert.match(cloud, /npm run publish -- init[\s\S]*npm run publish -- plan[\s\S]*npm run publish -- deploy/);
  assert.match(cloud, /no Static Web Apps SLA[\s\S]*potentially \$0|potentially \$0[\s\S]*no Static Web Apps SLA/i);
  assert.match(cloud, /only bundled cloud profile/i);
  assert.match(cloud, /Container Apps Consumption[\s\S]*candidate—not a bundled profile/i);
  assert.match(cloud, /azure-prepare[\s\S]*azure-validate[\s\S]*azure-deploy/);
  assert.match(cloud, /budgets are not spending caps/i);
  assert.match(cloud, /manual recovery/i);
  assert.doesNotMatch(cloud, /npm run publish -- (?:container|aca)/i, 'SQL Apps must not add a second cloud deployer');
  assert.doesNotMatch(cloud, /For an SLA, managed identity/, 'Managed identity must not route to both production and Container Apps');
  assert.match(cloud, /managed identity that does not meet the conditions below/i);
  assert.match(sharing, /only the gateway has public ingress[\s\S]*DAB is reachable over localhost/i);
  assert.match(sharing, /managed identity[\s\S]*object-scoped permissions/i);
  assert.match(sharing, /not a bundled SQL Apps deployment/i);
  assert.match(sharing, /Setting minimum replicas to zero is not shutdown/i);
  assert.doesNotMatch(readme, /Static Web Apps candidate/);
  assert.doesNotMatch(readme, /uses TypeScript, Azure SQL Database, Data API builder, Blob Storage and Azure Functions/);
  await assert.rejects(read('docs/superpowers/plans/2026-10-10-bakery-ordering.md'));
  await assert.rejects(read('docs/superpowers/specs/2026-10-10-bakery-ordering-design.md'));
  assert.match(await read('docs/README.md'), /Temporary implementation plans.*not product guidance/is);

  assert.match(design, /app's existing stack/i);
  assert.match(design, /test-persona selection off product screens/i);
  assert.doesNotMatch(design, /references\/|craft floor|style recipes/i);

  const reportContract = /implemented\/built[\s\S]*running[\s\S]*functional acceptance[\s\S]*design acceptance/i;
  assert.match(validation, reportContract);
  for (const [name, content] of [
    ['getting started', gettingStarted], ['application', application], ['local', local],
    ['cloud', cloud], ['design', design],
  ] as const) assert.doesNotMatch(content, reportContract, `${name} must not duplicate the final report contract`);
  assert.match(application, /sql-apps-validation[\s\S]*four-verdict/i);
  assert.match(cloud, /sql-apps-validation[\s\S]*four-verdict/i);
  const statusPhrase = /implemented.*built.*running.*workflow[- ]verified/gi;
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
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-plugin-home-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const home = resolve('.');
  await writeFile(join(profile, 'sql-apps-local.json'), JSON.stringify({ version: 1, home }));
  assert.equal((await probe('process.chdir(process.env.COPILOT_HOME); console.log(await resolveHome({ userHome: process.env.TEST_USER_HOME }));',
    { COPILOT_HOME: profile, SQL_APPS_HOME: undefined, TEST_USER_HOME: userHome })).trim(), home);
  assert.equal((await probe('console.log(await resolveHome());', { SQL_APPS_HOME: home })).trim(), home);
});

test('plugin launcher reports invalid bindings and commands rather than falling back silently', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'sql-apps-plugin-invalid-'));
  const userHome = await mkdtemp(join(tmpdir(), 'sql-apps-plugin-invalid-home-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  await mkdir(join(profile, 'not-sql-apps'));
  await writeFile(join(profile, 'sql-apps-local.json'), '{ invalid');
  await assert.rejects(probe('process.chdir(process.env.COPILOT_HOME); await resolveHome({ userHome: process.env.TEST_USER_HOME });',
    { COPILOT_HOME: profile, SQL_APPS_HOME: undefined, TEST_USER_HOME: userHome }), /JSON|SyntaxError/);
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
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql apps dispatch-')));
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
  // Dispatch checks below only read the fixture, so independent launches run concurrently.
  await Promise.all(['role-based-app', 'role-based-serve'].map(async command => {
    const selected = JSON.parse(await run(process.execPath, [launcher, command, 'custom-sql'], { env: { SQL_APPS_HOME: home } }));
    assert.equal(selected.cwd, home);
    assert.deepEqual(selected.args, [command, 'custom-sql']);
  }));
  const artifact = join(home, '.sql-apps', 'selected artifact; literal');
  await Promise.all(['selected-app', 'selected-serve', 'selected-test'].map(async command => {
    const selected = JSON.parse(await run(process.execPath, [launcher, command, artifact], { env: { SQL_APPS_HOME: home } }));
    assert.equal(selected.cwd, home);
    assert.deepEqual(selected.args, [command, artifact]);
    await assert.rejects(run(process.execPath, [launcher, command, 'relative-artifact'], { env: { SQL_APPS_HOME: home } }), /absolute artifact/);
  }));
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
  await Promise.all([
    ...([
      ['consent-plan', ['role-based-app', 'custom-sql']],
      ['consent-status', ['build']],
      ['consent-grant', [briefPath]],
      ['consent-grant-once', [briefPath]],
      ['consent-terms', [briefPath]],
      ['consent-revoke', ['terms']],
      ['consent-run', ['build']],
    ] as const).map(async ([command, args]) => {
      const consent = JSON.parse(await run(process.execPath, [launcher, command, ...args], { env: { SQL_APPS_HOME: home } }));
      assert.equal(consent.cwd, home);
      assert.deepEqual(consent.args, [command.replace('consent-', ''), ...args]);
    }),
    assert.rejects(run(process.execPath, [launcher, 'consent-grant', 'relative.json'], { env: { SQL_APPS_HOME: home } }), /absolute/),
    assert.rejects(run(process.execPath, [launcher, 'consent-plan'], { env: { SQL_APPS_HOME: home } }), /operation/),
    assert.rejects(run(process.execPath, [launcher, 'setup-check', 'fail-sql'], { env: { SQL_APPS_HOME: home } }), /failed \(7\)/),
  ]);
  await mkdir(join(home, 'dist/src'), { recursive: true });
  await writeFile(join(home, 'dist/src/local-cli.js'), 'process.exitCode=7;');
  await recordFixture(home);
  await assert.rejects(run(process.execPath, [launcher, 'test'], { env: { SQL_APPS_HOME: home } }), /failed \(7\)/);
});
