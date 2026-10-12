import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildSelectedApplication, checkSelectedApplication } from '../src/application-build.js';
import { initializeWorkspace } from '../src/workspace.mjs';
import { run } from '../src/process.js';

async function fixture() {
  await mkdir('.sql-apps', { recursive: true });
  const home = await mkdtemp(resolve('.sql-apps', 'selected-build-test-'));
  for (const dir of [
    'src', 'sql', 'public', 'plugins/sql-apps',
    'examples/inventory/web', 'examples/inventory/demo', 'examples/inventory/tests',
  ]) {
    await mkdir(join(home, dir), { recursive: true });
  }
  await writeFile(join(home, 'package.json'), await readFile('package.json'));
  await writeFile(join(home, 'package-lock.json'), await readFile('package-lock.json'));
  await writeFile(join(home, 'application.json'), JSON.stringify({ name: 'clean', selectedExamples: [] }));
  await writeFile(join(home, 'runtime-contract.json'), JSON.stringify({ version: 1, capabilities: ['local', 'setup-check'] }));
  await writeFile(join(home, 'public', 'staticwebapp.config.json'), JSON.stringify({
    routes: [{ route: '/api/*', allowedRoles: ['anonymous'] }],
    navigationFallback: { rewrite: '/index.html', exclude: ['/api/*'] },
    globalHeaders: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  }));
  for (const file of ['application.ts', 'demo-app.ts', 'demo-session.ts', 'workspace.mjs']) await cp(resolve('src', file), join(home, 'src', file));
  for (const file of ['src/local-cli.ts', 'sql/database.sqlproj', 'plugins/sql-apps/plugin.json']) await writeFile(join(home, file), '');
  await writeFile(join(home, 'examples/inventory/application.ts'), `
import { type ApplicationDefinition } from '../../src/application.js';
export const application: ApplicationDefinition = {
  name: 'inventory', capabilities: ['data', 'visitor-sessions'], profiles: ['local-simulation', 'public-demo'],
  routes: [{method:'GET',path:'/api/inventory'}],
  inputs:{browser:'web/app.ts',html:'web/index.html',css:'web/app.css',sqlProject:'demo/database.sqlproj',
    sqlFiles:['demo/schema.sql'],grants:'demo/grants.sql',dab:'demo/dab-config.json',
    publicAcceptance:'tests/public-acceptance.ts'},
  procedures:['CreateSession','GetSession','DeleteSession','Readiness'],
  sessions:{create:'CreateSession',get:'GetSession',delete:'DeleteSession',ready:'Readiness'},
  limits:{sessionMinutes:60,itemLimit:50,titleLimit:200,mutationsPerMinute:30,globalMutationsPerMinute:300,globalSessionLimit:1000},
  async register(app) {app.get('/api/inventory',async()=>({items:[]}));}
};`);
  for (const [file, text] of [
    ['web/app.ts', 'document.body.dataset.application="inventory";'],
    ['web/index.html', '<html><body><script type="module" src="/app.js"></script></body></html>'],
    ['web/app.css', 'body { color: black; }'],
    ['demo/database.sqlproj', '<Project Sdk="Microsoft.Build.Sql/2.3.0" />'],
    ['demo/schema.sql', 'CREATE TABLE dbo.Inventory (id int);'],
    ['demo/grants.sql', '-- scoped grants'],
    ['demo/dab-config.json', '{"entities":{}}'],
    ['tests/public-acceptance.ts', 'export async function acceptPublicApplication() {}'],
    ['smoke.ts', 'UNSELECTED_SMOKE_MUST_NOT_SHIP'],
  ] as const) await writeFile(join(home, 'examples/inventory', file), text);
  await mkdir(join(home, 'examples/unselected'), { recursive: true });
  await writeFile(join(home, 'examples/unselected/application.ts'), 'UNSELECTED_APP_MUST_NOT_SHIP');
  await initializeWorkspace(home, 46000, async () => 'free');
  return home;
}

test('selected builds are workspace-scoped, immutable and exclude unselected example/test trees', async t => {
  const home = await fixture();
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const rootManifest = await readFile(join(home, 'application.json'), 'utf8');
  const built = await buildSelectedApplication(home, 'inventory', 'public-demo');
  assert.ok(built.directory.startsWith(join(home, '.sql-apps', 'workspaces')));
  assert.equal(built.manifest.name, 'inventory');
  assert.deepEqual(built.manifest.routes, [{ method: 'GET', path: '/api/inventory' }]);
  assert.deepEqual(built.manifest.profiles, ['local-simulation', 'public-demo']);
  assert.equal(await readFile(join(home, 'application.json'), 'utf8'), rootManifest);
  const delivered = await readFile(join(built.directory, 'server/application.mjs'), 'utf8');
  assert.doesNotMatch(delivered, /UNSELECTED_|storage-blob|file-jobs|local-app/);
  const docker = await readFile(join(built.directory, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(docker, /COPY\s+\.\s|examples|tests|functions/);
  assert.doesNotMatch(docker, /COPY.*public|COPY.*static/);
  const labels = [
    `io.sql-apps.application="inventory"`,
    `io.sql-apps.profile="public-demo"`,
    `io.sql-apps.source-fingerprint="${built.manifest.sourceFingerprint}"`,
    `io.sql-apps.selected-inputs-fingerprint="${createHash('sha256').update(JSON.stringify(built.manifest.sources)).digest('hex')}"`,
    `io.sql-apps.routes-fingerprint="${createHash('sha256').update(JSON.stringify(built.manifest.routes)).digest('hex')}"`,
  ];
  for (const label of labels) assert.ok(docker.includes(label), `Missing image provenance ${label}`);
  const dataImage = await readFile(join(built.directory, 'dab/Dockerfile'), 'utf8');
  assert.match(dataImage, /FROM mcr\.microsoft\.com\/azure-databases\/data-api-builder:2\.0\.12@sha256:[a-f0-9]{64}/);
  assert.match(dataImage, /COPY dab\/dab-config\.json \/App\/dab-config\.json/);
  for (const label of labels) assert.ok(dataImage.includes(label), `Missing sidecar provenance ${label}`);
  const startup = await readFile(join(built.directory, 'server/start.mjs'), 'utf8');
  assert.match(startup, /process\.env\.SQL_APPS_PROFILE/);
  assert.match(startup, /Explicit SQL_APPS_PROFILE is required/);
  assert.match(startup, /transport:publicDemo\?'static-web-apps':'direct'/);
  await assert.rejects(run(process.execPath, [join(built.directory, 'server/start.mjs')], {
    env: { SQL_APPS_PROFILE: undefined },
  }), /Explicit SQL_APPS_PROFILE is required/);
  const ignore = await readFile(join(built.directory, '.dockerignore'), 'utf8');
  assert.ok(ignore.startsWith('*\n'));
  assert.doesNotMatch(ignore, /!sql|!setup|!application-build|!examples|!tests/);
  assert.ok(built.manifest.files.some(file => file.path === 'sql/database.sqlproj'));
  assert.ok(built.manifest.files.some(file => file.path === 'dab/dab-config.json'));
  for (const file of [
    'static/index.html', 'static/app.css', 'static/app.js', 'static/staticwebapp.config.json',
    'acceptance/public.mjs',
  ]) {
    assert.ok(built.manifest.files.some(item => item.path === file), `Missing ${file}`);
  }
  const swa = JSON.parse(await readFile(join(built.directory, 'static', 'staticwebapp.config.json'), 'utf8'));
  assert.deepEqual(swa.routes, [{ route: '/api/*', allowedRoles: ['anonymous'] }]);
  assert.equal(swa.navigationFallback.rewrite, '/index.html');
  assert.deepEqual((await checkSelectedApplication(home, built.directory, 'public-demo')).routes, built.manifest.routes);
  assert.match(await run(process.execPath, [
    resolve('scripts/check-application.mjs'), '--selected', built.directory, 'public-demo', home,
  ]), /Selected application passed/);
  await writeFile(join(built.directory, 'public/app.js'), 'tampered');
  await assert.rejects(checkSelectedApplication(home, built.directory, 'public-demo'), /artifact/);
});

test('selected build gate rejects profile, source, namespace and route mismatches', async t => {
  const home = await fixture();
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  for (const name of ['../inventory', 'unknown', 'Inventory']) {
    await assert.rejects(buildSelectedApplication(home, name, 'public-demo'), /selection|ENOENT/);
  }
  const built = await buildSelectedApplication(home, 'inventory', 'local-simulation');
  await assert.rejects(checkSelectedApplication(home, built.directory, 'public-demo'), /profile/);
  await writeFile(join(home, 'examples/inventory/web/app.ts'), 'document.body.textContent="Changed source";');
  await assert.rejects(checkSelectedApplication(home, built.directory, 'local-simulation'), /source/);
  const other = await fixture();
  t.after(() => rm(other, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await assert.rejects(checkSelectedApplication(other, built.directory, 'local-simulation'), /workspace/);
  const module = join(home, 'examples/inventory/application.ts');
  await writeFile(module, (await readFile(module, 'utf8')).replace("path:'/api/inventory'", "path:'/api/missing'"));
  await assert.rejects(buildSelectedApplication(home, 'inventory', 'public-demo'), /route contract/);
  await writeFile(module, (await readFile(module, 'utf8')).replace("path:'/api/missing'", "path:'/api/inventory'"));
  await writeFile(join(home, 'examples/unselected/application.ts'), 'export const secret = "UNSELECTED_APP_MUST_NOT_SHIP";');
  await writeFile(module, `import {secret} from '../unselected/application.js';\n${await readFile(module, 'utf8')}\nconsole.log(secret);`);
  await assert.rejects(buildSelectedApplication(home, 'inventory', 'public-demo'), /unselected example/);
});
