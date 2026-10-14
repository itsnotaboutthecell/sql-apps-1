import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../src/process.js';
import { testLocalApp } from '../src/local-app-smoke.js';
import { runtimeFor } from '../src/workspace.mjs';

const checker = resolve('scripts/check-application.mjs');

async function designFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-design-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['src/web', 'public', 'dab', 'sql', 'tests', 'dist/tests', 'dist/src', 'docs']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, 'application.json'), JSON.stringify({ name: 'payroll', selectedExamples: [] }));
  await writeFile(join(root, 'role-based-data.json'), JSON.stringify({
    requiredRole: 'PayrollUser', readinessPath: '/api/AppReady',
  }));
  await writeFile(join(root, 'src/web/app.ts'), 'document.body.dataset.app = "payroll";');
  await writeFile(join(root, 'public/index.html'), '<h1>Payroll</h1>');
  await writeFile(join(root, 'public/style.css'), 'body { color: navy; }');
  await writeFile(join(root, 'public/app.js'), 'document.body.dataset.app = "payroll";');
  for (const file of ['dist/src/client.js', 'dist/src/server.js']) await writeFile(join(root, file), '');
  for (const file of ['Dockerfile', 'dab/Dockerfile']) {
    await writeFile(join(root, file), 'COPY --from=build /app/dist/src ./dist/src');
  }
  return root;
}

const designIntent = `# Design Intent

## Audience
Payroll administrators and mechanics.

## Primary recurring task
Review and approve the current pay run.

## First-read information
Pay-period status, exceptions and total payroll.

## Composition A
- Hierarchy: Pay-run status and exceptions precede employee detail.
- Density: A compact summary expands into detailed rows.
- Primary action: Review current pay run.

## Composition B
- Hierarchy: People and their current pay state lead the page.
- Density: Spacious employee summaries reveal detail on demand.
- Primary action: Open an employee pay record.

## Selected composition
- Choice: Composition A.
- Why: Administrators act on the pay run more often than individual records.

## Typography
System sans-serif with tabular numerals for money.

## Palette
Neutral surfaces with blue action emphasis and non-color status labels.

## Layout
A bounded summary region followed by a responsive detail list.

## Responsive behavior
Desktop shows summary and detail together; narrow widths stack them without horizontal scrolling.

## Design capability
- Manual fallback reason: No maintained frontend design skill was available in the host.
`;

const designReview = `# Design Review

## Review target
- Origin: http://127.0.0.1:18080
- Source/build: test build abc123

## Matrix
| State | Desktop | Narrow |
| --- | --- | --- |
| signed-out | observed | observed |
| no-access | observed | observed |
| first-run | observed | observed |
| empty | observed | observed |
| single-record | observed | observed |
| populated | fixed+re-reviewed | observed |
| saving | observed | observed |
| error | observed | observed |
| success | observed | observed |
| disabled | observed | observed |
| role: PayrollUser | observed | observed |

## Findings
- populated desktop: tightened summary spacing, then re-reviewed.
`;

test('design gate warns for customized UI and validates intent and review artifacts', async t => {
  const root = await designFixture(t);
  const missing = await run(process.execPath, [checker, root]);
  assert.match(missing, /Design warning: customized UI has no docs[\\/]design-intent\.md/);
  assert.match(missing, /Design acceptance: partial: 22 unreviewed cells/);

  await writeFile(join(root, 'docs', 'design-intent.md'), designIntent.replace(/## Composition B[\s\S]*?## Selected composition/, '## Selected composition'));
  await assert.rejects(run(process.execPath, [checker, root]), /Composition B/);

  await writeFile(join(root, 'docs', 'design-intent.md'), designIntent);
  await writeFile(join(root, 'docs', 'design-review.md'), designReview.replace('| empty | observed | observed |', '| empty | observed | |'));
  const partial = await run(process.execPath, [checker, root]);
  assert.match(partial, /Design acceptance: partial: 1 unreviewed cell\b/);

  await writeFile(join(root, 'docs', 'design-review.md'),
    designReview.replace('| error | observed | observed |', '| error | blocked: API unavailable | observed |'));
  const blocked = await run(process.execPath, [checker, root]);
  assert.match(blocked, /Design acceptance: blocked: 1 cell\b/);

  await writeFile(join(root, 'docs', 'design-review.md'), designReview);
  const accepted = await run(process.execPath, [checker, root]);
  assert.match(accepted, /Design acceptance: accepted \(22 reviewed cells\)/);
  assert.doesNotMatch(accepted, /Design warning/);
});

test('clean application validation rejects leftovers in each actual delivery surface', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-clean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'public', 'dab', 'sql', 'tests', 'dist/tests', 'dist/src']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'application.json'), JSON.stringify({ name: 'test-app', selectedExamples: [] }));
  await writeFile(join(root, 'public/app.js'), 'console.log("orders");');
  for (const file of ['dist/src/client.js', 'dist/src/server.js']) {
    await writeFile(join(root, file), '');
  }
  for (const file of ['Dockerfile', 'dab/Dockerfile']) {
    await writeFile(join(root, file), 'COPY --from=build /app/dist/src ./dist/src');
  }
  assert.match(await run(process.execPath, [checker, root]), /Clean application passed/);
  await writeFile(join(root, 'public/index.html'), '<title>Todo</title><h1>Todo</h1>');
  assert.match(await run(process.execPath, [checker, root]), /Clean application passed/,
    'a domain word alone is not evidence that the reference example was copied');
  await writeFile(join(root, 'public/index.html'), '');
  const leftovers: [string, string][] = [
    ['src/client.ts', 'async listTodos() {}'],
    ['src/component.mjs', 'async listTodos() {}'],
    ['src/web.ts', 'const query = "{ todos { items { id } } }";'],
    ['public/index.html', '<form id="todo-form"></form>'],
    ['public/todos.css', '#todos { display: none; }'],
    ['public/app.js', 'function createTodo() {}'],
    ['dab/config.json', '{"Todo":{"source":"dbo.Todos"}}'],
    ['sql/table.sql', 'CREATE TABLE dbo.Todos (id int);'],
    ['dist/src/client.js', 'class TodoExampleClient {}'],
    ['dist/src/component.mjs', 'class TodoExampleClient {}'],
    ['dist/src/worker.js', 'import "../examples/todo/client.js";'],
  ];
  for (const [path, content] of leftovers) {
    await writeFile(join(root, path), content);
    await assert.rejects(run(process.execPath, [checker, root]), /Unselected Todo example/);
    await writeFile(join(root, path), '');
  }
  for (const [path, content] of [
    ['tests/inherited.test.ts', 'import { application } from "../examples/todo/application.js";'],
    ['tests/inherited.test.ts', 'const application = await import("../examples/todo/application.js");'],
    ['tests/inherited.test.ts', 'const sql = await readFile("examples/todo/demo/schema.sql", "utf8");'],
    ['tests/inherited.test.ts', 'const sql = await readFile(join("examples", "todo", "schema.sql"), "utf8");'],
    ['tests/inherited.test.ts', 'const file = "examples/todo/schema.sql"; await readFile(file, "utf8");'],
    ['tests/inherited.test.ts', 'for (const file of ["examples/todo/schema.sql"]) await readFile(file, "utf8");'],
    ['tests/inherited.test.ts', 'export { application } from "../examples/inventory/application.js";'],
    ['dist/tests/inherited.test.js', 'import { application } from "../examples/todo/application.js";'],
  ]) {
    await writeFile(join(root, path!), content!);
    await assert.rejects(run(process.execPath, [checker, root]), /Unselected example dependency.*tests[\\/]/s);
    await writeFile(join(root, path!), '');
  }
  await writeFile(join(root, 'tests/absence.test.ts'), `
// TODO: keep the negative regression check.
assert.equal(await databaseObjectExists('dbo.Todos'), false);
assert.equal((await request('/api/Todo')).statusCode, 404);
const fixture = 'import { application } from "../examples/todo/application.js";';
`);
  assert.match(await run(process.execPath, [checker, root]), /Clean application passed/);
  await writeFile(join(root, 'model.xml'), '<Element Name="[dbo].[Todos]" />');
  await assert.rejects(run(process.execPath, [checker, root, join(root, 'model.xml')]), /Unselected Todo example/);
  await writeFile(join(root, 'model.xml'), '<Element Name="[dbo].[Orders]" />');
  assert.match(await run(process.execPath, [checker, root, join(root, 'model.xml')]), /Clean application passed/);
  for (const copy of [
    'COPY --from=build /app/dist ./dist',
    'COPY --from=build /app/dist /app/dist',
    'COPY ./ ./',
    'COPY ["examples", "/app/examples"]',
    'COPY --from=build /app/dist/* /app/dist',
    'COPY --chown=node:node \\\n  tests ./tests',
  ]) {
    await writeFile(join(root, 'dab/Dockerfile'), copy);
    await assert.rejects(run(process.execPath, [checker, root]), /whole build/);
  }
  await writeFile(join(root, 'dab/Dockerfile'), 'COPY --from=build /app/dist/src ./dist/src');
  await rm(join(root, 'dist/src/server.js'));
  await assert.rejects(run(process.execPath, [checker, root]), /ENOENT/);
});

test('example test runner skips absent examples but runs and propagates selected example failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sql-apps-example-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = resolve('scripts/test-examples.mjs');
  assert.match(await run(process.execPath, [runner, root]), /No optional example tests/);
  await mkdir(join(root, 'examples', 'inventory', 'tests'), { recursive: true });
  await writeFile(join(root, 'examples', 'inventory', 'tests', 'workflow.test.ts'), '// source test');
  await assert.rejects(run(process.execPath, [runner, root]), /Missing compiled example test/);
  await mkdir(join(root, 'dist', 'examples', 'inventory', 'tests'), { recursive: true });
  const compiled = join(root, 'dist', 'examples', 'inventory', 'tests', 'workflow.test.js');
  await writeFile(compiled, 'throw new Error("Example workflow failure");');
  await assert.rejects(run(process.execPath, [runner, root]), /Example workflow failure/);
  await writeFile(compiled, 'console.log("Example workflow passed");');
  assert.match(await run(process.execPath, [runner, root]), /Example workflow passed/);
});

test('API cleanliness requires missing entities, not auth/backend errors, and always cleans its session', async () => {
  const moduleUrl = pathToFileURL(resolve('scripts/check-application-api.mjs')).href;
  const { checkApplicationApi } = await import(moduleUrl);
  const origin = runtimeFor().origins.app;
  const cases = [
    { rest: 404, graph: 400, body: { errors: [{ message: "Cannot query field 'todos'." }] }, succeeds: true },
    { rest: 200, graph: 400, body: { errors: [{ message: "Cannot query field 'todos'." }] }, succeeds: false },
    { rest: 401, graph: 400, body: { errors: [{ message: "Cannot query field 'todos'." }] }, succeeds: false },
    { rest: 404, graph: 503, body: { errors: [{ message: 'Backend unavailable' }] }, succeeds: false },
    { rest: 404, graph: 200, body: { errors: [{ message: 'Not authorized for todos' }] }, succeeds: false },
    { rest: 404, graph: 200, body: { data: { todos: { items: [] } } }, succeeds: false },
    { rest: 404, graph: 200, body: { errors: [{ message: "Cannot query field 'todos'." }] }, succeeds: false, cleanup: 500 },
  ];
  for (const scenario of cases) {
    let cleaned = false;
    const fetcher = async (url: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      assert.equal(headers.get('origin'), origin);
      if (options.method === 'DELETE') {
        cleaned = true;
        assert.equal(headers.get('content-type'), null, 'Bodyless cleanup must not claim to be JSON');
        assert.equal(headers.get('authorization'), 'Bearer test-session');
        return new Response(null, { status: scenario.cleanup ?? 204 });
      }
      if (url.endsWith('/local/session')) return Response.json({ token: 'test-session' });
      assert.equal(headers.get('authorization'), 'Bearer test-session');
      if (url.endsWith('/api/Todo')) return new Response('', { status: scenario.rest });
      return Response.json(scenario.body, { status: scenario.graph });
    };
    if (scenario.succeeds) await checkApplicationApi(undefined, fetcher);
    else await assert.rejects(checkApplicationApi(undefined, fetcher), /Clean application API acceptance failed/);
    assert.equal(cleaned, true);
  }
  let called = false;
  await assert.rejects(checkApplicationApi('https://example.com', () => { called = true; }), /127.0.0.1/);
  assert.equal(called, false);
});

test('local gateway acceptance checks role access and always cleans up sessions', async () => {
  const profile = { profile: 'role-based-data' as const, requiredRole: 'AppUser', readinessPath: '/api/AppReady' };
  for (const scenario of [{ bobStatus: 403, succeeds: true }, { bobStatus: 200, succeeds: false }]) {
    const identities = new Map<string, string>();
    const cleaned: string[] = [];
    let issued = 0;
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      const token = new Headers(options?.headers).get('authorization')?.split(' ')[1];
      if (url.pathname === '/local/session' && options?.method === 'POST') {
        const { user } = JSON.parse(String(options.body));
        const session = `acceptance-session-${++issued}-`.padEnd(40, 'x');
        identities.set(session, user);
        return Response.json({ token: session });
      }
      if (options?.method === 'DELETE') {
        assert.ok(token);
        cleaned.push(token);
        return new Response(null, { status: 204 });
      }
      const user = token ? identities.get(token) : undefined;
      if (!user) return new Response(null, { status: 401 });
      if (url.pathname === '/auth/me') return Response.json({ oid: user });
      assert.equal(url.pathname, profile.readinessPath);
      const alice = user === '11111111-1111-4111-8111-111111111111';
      return alice ? Response.json({ value: [{ ready: 1 }] }) : new Response(null, { status: scenario.bobStatus });
    };
    if (scenario.succeeds) await testLocalApp(profile, fetcher);
    else await assert.rejects(testLocalApp(profile, fetcher), /Local gateway acceptance/);
    assert.equal(cleaned.length, 2);
  }
});
