import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readGuide, saveBrief, validateBrief } from '../scripts/guide.mjs';
import { initializeWorkspace } from '../src/workspace.mjs';

const brief = () => ({
  purpose: 'Track equipment loans',
  audience: 'Our equipment team',
  records: ['Equipment', 'Loans'],
  actions: ['Register equipment', 'Record a return'],
  capabilities: ['data'],
  nextChange: 'Add a due-date field',
});

test('SQL Apps entry guidance keeps project selection in the coordinator', async () => {
  const start = await readFile(resolve('content/start.md'), 'utf8');
  assert.match(start, /Confirm the application directory before editing/);
  assert.match(start, /Do not modify other plugins/);
  assert.match(start, /Stop gathering context once the plan names an action or blocker/);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'sql-apps-guide-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const folder of ['src', 'sql', 'public', 'dab', '.config']) await mkdir(join(home, folder), { recursive: true });
  await writeFile(join(home, 'package.json'), JSON.stringify({
    name: 'fixture', dependencies: { '@microsoft/sql-apps': '0.1.2' },
  }));
  await writeFile(join(home, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(join(home, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  await writeFile(join(home, '.config', 'dotnet-tools.json'), JSON.stringify({ version: 1, tools: {} }));
  await writeFile(join(home, '.sql-apps-project.json'), JSON.stringify({
    version: 1, id: 'b91d4857-9570-4d4b-a740-918471ca7e26', name: 'Fixture',
    slug: 'fixture', starter: 'data', profile: 'role-based-data', scaffoldVersion: 1,
    tooling: { package: '@microsoft/sql-apps', version: '0.1.2' },
  }));
  await writeFile(join(home, 'application.json'), JSON.stringify({ name: 'fixture', selectedExamples: [] }));
  await writeFile(join(home, 'role-based-data.json'), JSON.stringify({
    profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/Ready',
  }));
  await writeFile(join(home, 'public', 'index.html'), '<!doctype html>');
  await writeFile(join(home, 'public', 'style.css'), 'body {}');
  await writeFile(join(home, 'dab', 'dab-config.json'), '{}');
  for (const file of ['src/local-cli.ts', 'sql/database.sqlproj']) {
    await writeFile(join(home, file), '');
  }
  return home;
}

test('guide works before build and stays read-only without selecting an example or workspace', async t => {
  const home = await fixture(t);
  const before = await readdir(home);
  const report = await readGuide(home);
  assert.deepEqual(await readdir(home), before);
  assert.equal(report.brief, null);
  assert.equal(report.nextStage, 'describe');
  assert.equal(report.build.ready, false);
  assert.equal(report.workspace.selected, false);
  assert.equal(report.cloud.authorized, false);
  assert.equal(report.cost.phase, 'local-cost-awareness');
  assert.equal(report.cost.preference, 'zero-azure-spend');
  assert.equal(report.cost.spendingAuthorized, false);
  assert.deepEqual(report.application.selectedExamples, []);
  assert.deepEqual(report.stages.map(stage => stage.id), ['describe', 'run-locally', 'make-it-yours', 'share-optionally']);
});

test('guide routes run-locally through setup plan and suggests the profile that matches the agreed capabilities', async t => {
  const home = await fixture(t);
  assert.equal((await readGuide(home)).suggestedProfile, 'role-based-data',
    'the generated starter profile is explicit before scope is agreed');
  await saveBrief(home, brief());
  let report = await readGuide(home);
  assert.equal(report.nextStage, 'run-locally');
  assert.equal(report.profile, 'role-based-data');
  assert.equal(report.suggestedProfile, 'role-based-data', 'a data-only brief must not be steered to the file/job foundation');
  assert.match(report.nextAction, /setup plan --profile role-based-data/);
  assert.doesNotMatch(report.nextAction, /setup-check/, 'the coordinator, not the raw readiness check, orders approvals');
  assert.match(report.cost.reviewCommand, /role-based-cost/);
  await saveBrief(home, { ...brief(), capabilities: ['data', 'files', 'background-jobs'] });
  report = await readGuide(home);
  assert.equal(report.suggestedProfile, 'role-based-data',
    'the generated project profile remains authoritative when the brief outgrows its starter');
  assert.match(report.nextAction, /setup plan --profile role-based-data/);
  assert.match(report.cost.reviewCommand, /role-based-cost/);
  await writeFile(join(home, 'role-based-data.json'), '{}');
  report = await readGuide(home);
  assert.equal(report.profile, 'role-based-data');
  assert.equal(report.suggestedProfile, 'role-based-data', 'a configured profile wins over the brief');
  assert.match(report.nextAction, /setup plan --profile role-based-data/);
  assert.match(report.cost.reviewCommand, /role-based-cost .*azure-role-based-cost\.example\.json/);
  assert.doesNotMatch(report.cost.reviewCommand, /demo-cost/);
});

test('guide persists decisions and reports evidence as historical, never current acceptance', async t => {
  const home = await fixture(t);
  const input = brief();
  input.checkpoint = { stage: 'run-locally', summary: 'Created and reloaded a loan', evidence: ['Browser create/reload passed; SQL row inspected'] };
  await saveBrief(home, input);
  const saved = await readFile(join(home, '.sql-apps', 'guide.json'), 'utf8');
  const report = await readGuide(home);
  assert.equal(await readFile(join(home, '.sql-apps', 'guide.json'), 'utf8'), saved);
  assert.deepEqual(report.brief, input);
  assert.equal(report.progress.status, 'reported-not-reverified');
  assert.equal(report.nextStage, 'make-it-yours');
  assert.equal(report.cloud.authorized, false);
  assert.equal(report.build.ready, false);
  assert.deepEqual(report.localServices, ['SQL', 'Data API', 'Browser/API']);
  assert.match(report.scope, /not.*live acceptance/i);
});

test('source changes invalidate reported progress and require local re-verification', async t => {
  const home = await fixture(t);
  const input = brief();
  input.checkpoint = { stage: 'make-it-yours', summary: 'Due date added', evidence: ['Browser validation and SQL persistence passed'] };
  await saveBrief(home, input);
  await writeFile(join(home, 'src/local-cli.ts'), 'changed');
  const report = await readGuide(home);
  assert.equal(report.progress.status, 'source-changed');
  assert.equal(report.nextStage, 'run-locally');
  assert.match(report.nextAction, /rebuild.*verify/i);
  assert.match(report.nextAction, /setup plan --profile role-based-data/, 'a stale checkpoint still routes through the guarded coordinator');
  assert.equal(report.brief.nextChange, input.nextChange);
});

test('implementing the app after a checkpoint-free brief keeps the setup-plan route without inventing a checkpoint', async t => {
  const home = await fixture(t);
  await saveBrief(home, brief());
  await writeFile(join(home, 'src/local-cli.ts'), 'implemented screens');
  const report = await readGuide(home);
  assert.equal(report.progress.status, 'source-changed');
  assert.equal(report.nextStage, 'run-locally');
  assert.doesNotMatch(report.nextAction, /checkpoint/, 'no checkpoint was ever saved');
  assert.match(report.nextAction, /setup plan --profile role-based-data/);
});

test('guide records checkout-specific workspace selection without authorizing startup', async t => {
  const home = await fixture(t);
  await saveBrief(home, brief());
  await initializeWorkspace(home, 33000, async () => 'free');
  const report = await readGuide(home);
  assert.equal(report.workspace.selected, true);
  assert.equal(report.workspace.mode, 'isolated');
  assert.equal(report.workspace.origin, 'http://127.0.0.1:33000');
  assert.equal(report.nextStage, 'run-locally');
  assert.match(report.nextAction, /approval/i);
});

test('strict brief validation rejects unsupported choices, blank values and invented completion', () => {
  for (const input of [
    { ...brief(), deploy: true },
    { ...brief(), costPreference: 'unlimited-spend' },
    { ...brief(), purpose: ' ' },
    { ...brief(), records: [] },
    { ...brief(), records: ['x'.repeat(501)] },
    { ...brief(), capabilities: ['data', 'data'] },
    { ...brief(), capabilities: ['files'] },
    { ...brief(), capabilities: ['data', 'redis'] },
    { ...brief(), capabilities: ['data', 'background-jobs'] },
    { ...brief(), checkpoint: { stage: 'share-optionally', summary: 'Deployed', evidence: ['build passed'] } },
    { ...brief(), checkpoint: { stage: 'run-locally', summary: 'Works', evidence: [] } },
    { ...brief(), checkpoint: { stage: 'run-locally', summary: 'Works', evidence: ['ok'], verified: true } },
  ]) assert.throws(() => validateBrief(input), /brief|capabilit|checkpoint/i);
  assert.deepEqual(validateBrief(brief()), brief());
  assert.deepEqual(validateBrief({ ...brief(), capabilities: ['data', 'files', 'background-jobs'] }).capabilities,
    ['data', 'files', 'background-jobs']);
});

test('invalid, oversized and copied state fail explicitly and are never overwritten', async t => {
  const home = await fixture(t);
  const other = await fixture(t);
  await saveBrief(home, brief());
  const path = join(home, '.sql-apps', 'guide.json');
  const text = await readFile(path, 'utf8');
  await mkdir(join(other, '.sql-apps'));
  await writeFile(join(other, '.sql-apps', 'guide.json'), text);
  await assert.rejects(readGuide(other), /another checkout/);
  await writeFile(path, '{ invalid');
  await assert.rejects(readGuide(home), /Invalid.*guide/);
  await assert.rejects(saveBrief(home, brief()), /Invalid.*guide/);
  assert.equal(await readFile(path, 'utf8'), '{ invalid');
  await writeFile(path, ' '.repeat(17000));
  await assert.rejects(readGuide(home), /too large/);
});

test('saving a guide refuses a concurrent writer and preserves the previous brief', async t => {
  const home = await fixture(t);
  await saveBrief(home, brief());
  const before = await readFile(join(home, '.sql-apps', 'guide.json'), 'utf8');
  await mkdir(join(home, '.sql-apps', 'guide.lock'));
  await assert.rejects(saveBrief(home, { ...brief(), purpose: 'Changed' }), /already being saved/);
  assert.equal(await readFile(join(home, '.sql-apps', 'guide.json'), 'utf8'), before);
});

test('sharing reveals cost blockers without converting a saved preference into spending consent', async t => {
  const home = await fixture(t);
  const input = { ...brief(), costPreference: 'review-paid-costs',
    checkpoint: { stage: 'make-it-yours', summary: 'Due date added', evidence: ['Browser and SQL checks passed'] } };
  await saveBrief(home, input);
  const report = await readGuide(home);
  assert.equal(report.cost.phase, 'deployment-cost-review');
  assert.equal(report.cost.preference, 'review-paid-costs');
  assert.equal(report.cost.spendingAuthorized, false);
  assert.equal(report.cost.usageStatus, 'not-queried');
  assert.match(report.cost.message, /zero-spend intent is blocked/);
  assert.match(report.cost.scaleGuidance, /not.*scaling threshold/);
  assert.equal(report.cloud.authorized, false);
});

test('actual guide and plugin CLIs save/resume before build and reject invalid requests', async t => {
  const home = await fixture(t);
  const script = resolve('scripts', 'guide.mjs');
  const invoke = args => spawnSync(process.execPath, args, {
    cwd: home, encoding: 'utf8',
    env: { ...process.env, SQL_APPS_PROJECT_HOME: home },
    timeout: 15000,
  });
  let result = invoke([script, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).nextStage, 'describe');
  const input = join(home, 'equipment brief.json');
  await writeFile(input, JSON.stringify(brief()));
  result = invoke([script, '--save', input, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).brief.purpose, brief().purpose);
  result = invoke([script, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).brief.nextChange, brief().nextChange);
  result = invoke([script, '--save', input, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).build.ready, false);
  const saved = await readFile(join(home, '.sql-apps', 'guide.json'), 'utf8');
  for (const args of [['--save'], ['--save', input, 'extra'], ['--unknown'], ['--json', '--json']]) {
    result = invoke([script, ...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
  }
  await writeFile(input, '{"purpose":"incomplete"}');
  result = invoke([script, '--save', input, '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid project brief/);
  assert.equal(await readFile(join(home, '.sql-apps', 'guide.json'), 'utf8'), saved);
});

test('build guide chooses the capability profile before asking the assistant to implement', async () => {
  const content = await readFile('docs/guides/build-your-app.md', 'utf8');
  const step = content.slice(content.indexOf('## 2.'), content.indexOf('## 3.'));
  const profile = step.indexOf('suggestedProfile');
  const prompt = step.indexOf('> Implement');
  assert.ok(profile >= 0 && prompt > profile, 'the guide-suggested profile is decided before implementation starts');
  assert.doesNotMatch(step, /using this foundation/, 'a data-only app must not be steered into the file/job foundation');
});

test('coordinator entry points use the local-first journey and retain sharing boundaries', async () => {
  for (const file of ['content/start.md', 'skills/sql-apps-getting-started/SKILL.md',
    'docs/guides/build-your-app.md']) {
    const content = await readFile(file, 'utf8');
    assert.match(content, /Describe -> Run locally -> Make it yours -> Share optionally/, file);
    assert.match(content, /guide/, file);
  }
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /Describe -> Run locally -> Make it yours -> Share optionally/);
  assert.match(readme, /docs\/guides\/build-your-app\.md/);
  assert.doesNotMatch(readme, /Static Web Apps.*candidate/is,
    'the beginner entry point should defer hosting topology to the sharing guide');
  assert.match(readme, /docs\/guides\/sharing\.md/);
  const sharing = await readFile('docs/guides/sharing.md', 'utf8');
  const demoDeployment = await readFile('docs/reference/demo-deployment.md', 'utf8');
  assert.match(sharing, /Static Web Apps.*website.*Container App.*API.*Data API Builder/is);
  assert.match(sharing, /one public URL/is);
  assert.match(sharing, /Standard.*not automatically cheaper/is);
  assert.match(demoDeployment, /demo-publish.*--approve/is);
  assert.match(demoDeployment, /hosting-compare/is);
  assert.match(demoDeployment, /direct.*backend.*denied/is);
  const guideReference = await readFile('docs/reference/guide.md', 'utf8');
  assert.match(guideReference, /historical/i);
  assert.match(guideReference, /does not authorize.*cloud deployment/);
  assert.equal((await readFile('content/start.md', 'utf8')).includes('"'), false);
  const cloud = await readFile('plugins/sql-apps/skills/sql-apps-cloud-preview/SKILL.md', 'utf8');
  assert.match(cloud, /Sharing is optional/);
  assert.match(cloud, /Load only the material needed for the request/);
});

test('agent guidance stays lean, scoped and progressively disclosed', async () => {
  const start = await readFile('content/start.md', 'utf8');
  assert.ok(start.length <= 2500, `start prompt is ${start.length} characters; expected at most 2500`);

  const runtimeSkills = ['application', 'local', 'diagnostics', 'validation', 'cloud-preview'];
  for (const name of runtimeSkills) {
    const path = `plugins/sql-apps/skills/sql-apps-${name}/SKILL.md`;
    const content = await readFile(path, 'utf8');
    assert.ok(content.length <= 7000, `${path} is ${content.length} characters; expected at most 7000`);
  }

  const entryPoints = [
    'content/start.md',
    'skills/sql-apps-getting-started/SKILL.md',
    ...runtimeSkills.map(name => `plugins/sql-apps/skills/sql-apps-${name}/SKILL.md`),
    'plugins/sql-apps/skills/sql-apps-design/SKILL.md',
  ];
  const contents = await Promise.all(entryPoints.map(path => readFile(path, 'utf8')));
  const copiedBoundary = 'SQL Apps is a standalone project with its own runtime and workflow.';
  assert.ok(contents.filter(content => content.includes(copiedBoundary)).length <= 1,
    'keep the full project boundary in one coordinator instead of copying it into every skill');

  const local = await readFile('plugins/sql-apps/skills/sql-apps-local/SKILL.md', 'utf8');
  assert.doesNotMatch(local, /docs\/reference\/deployment\.md|demo-cost|role-based-cost/,
    'local startup guidance must leave deployment and cloud cost work to cloud-preview');

  await access('docs/maintainers/agent-evaluations.md');
});

test('hosting decision records the candidate architecture and promotion gate', async () => {
  const hostingDecision = await readFile('docs/maintainers/hosting-decision.md', 'utf8');
  assert.match(hostingDecision, /Database Connections.*retired.*November 30, 2025/is);
  assert.match(hostingDecision, /Static Web Apps Standard.*linked.*Container App/is);
  assert.match(hostingDecision, /Node API.*DAB.*sidecar/is);
  assert.match(hostingDecision, /not.*assumed.*cheaper/is);
  assert.match(hostingDecision, /role-based-data.*full-foundation.*unchanged/is);
  assert.doesNotMatch(hostingDecision,
    /Lovable|Bolt|Replit|v0\/Vercel|competitor|market (?:research|opportunity)/i);
});

test('reader documentation, skill references and icons resolve after audience-based reorganization', async () => {
  const files = ['README.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md',
    'skills/sql-apps-getting-started/SKILL.md',
    ...(await readdir('docs', { recursive: true })).filter(file => file.endsWith('.md')).map(file => join('docs', file)),
    ...(await readdir(join('plugins', 'sql-apps', 'skills'), { recursive: true }))
      .filter(file => file.endsWith('.md')).map(file => join('plugins', 'sql-apps', 'skills', file))];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(content, /docs\/azure\/|pre-launch-naming-transition/, file);
    const targets = [
      ...Array.from(content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g), match => match[1]),
      ...Array.from(content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), match => match[1]),
    ];
    for (const target of targets) {
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const [path, anchor] = target.split('#');
      const absolute = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
      await assert.doesNotReject(access(absolute), `${file}: ${target}`);
      if (anchor && absolute.endsWith('.md')) {
        const destination = await readFile(absolute, 'utf8');
        const headings = Array.from(destination.matchAll(/^#{1,6}\s+(.+)$/gm), match =>
          match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-'));
        assert.ok(headings.includes(decodeURIComponent(anchor)), `${file}: missing heading ${target}`);
      }
    }
  }
});
