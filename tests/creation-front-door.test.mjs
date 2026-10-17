import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialProgress } from '../src/creation-progress.mjs';
import { writeCreationJson } from '../src/creation-session.mjs';
import { startCreationFrontDoor } from '../src/creation-front-door.mjs';
import { loopbackFetch } from '../src/creation-checks.mjs';

async function listen(server) {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${server.address().port}`;
}
async function freeOrigin() {
  const server = createServer();
  const origin = await listen(server);
  await new Promise(done => server.close(done));
  return origin;
}
async function eventually(origin, predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await (await fetch(`${origin}/__sql_apps/progress`)).json();
    if (predicate(state)) return state;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Expected creation state was not established.');
}

test('an idle front door does not repeat deep checks without requests or event subscribers', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-idle-front-door-')));
  let door;
  t.after(async () => {
    if (door) await door.close();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'app'), directory = join(root, 'session');
  await mkdir(home);
  const initial = initialProgress({ home, name: 'Idle app', publicOrigin: await freeOrigin(),
    gatewayOrigin: await freeOrigin(), workspaceId: 'fixture' });
  await writeCreationJson(join(directory, 'progress.json'), initial);
  let inspections = 0;
  door = await startCreationFrontDoor({ directory, tools: root, interval: 25,
    inspect: async () => { inspections++; return { ready: false }; } });
  await new Promise(done => setTimeout(done, 175));
  assert.equal(inspections, 1, 'only the initial verification runs without an audience');
  const response = await fetch(`${door.origin}/__sql_apps/events`);
  const reader = response.body.getReader();
  await reader.read();
  await new Promise(done => setTimeout(done, 100));
  assert.ok(inspections > 1, 'an active observer receives current checks');
  await reader.cancel();
  await new Promise(done => setTimeout(done, 50));
  const idleCount = inspections;
  await new Promise(done => setTimeout(done, 100));
  assert.equal(inspections, idleCount, 'closing the last observer stops repeated work');
  const checked = await fetch(`${door.origin}/__sql_apps/check`);
  assert.equal(checked.status, 200);
  assert.ok(inspections > idleCount, 'an explicit recheck remains available while idle');
});

test('one origin serves pre-install status, verified app, proxy and isolated failures', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-front-door-')));
  let door, upstream, releaseSlowCheck, slowCheckStarted;
  const slowCheckStartedPromise = new Promise(done => { slowCheckStarted = done; });
  t.after(async () => {
    releaseSlowCheck?.();
    if (door) await door.close();
    if (upstream) await new Promise(done => upstream.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'app'), directory = join(root, 'session');
  await mkdir(home);
  await writeCreationJson(join(home, 'dist', 'build-provenance.json'), {
    version: 2, home, sourceFingerprint: 'a'.repeat(64), toolingFingerprint: 'b'.repeat(64),
  });
  await writeFile(join(home, 'role-based-data.json'), '{"readinessPath":"/api/Ready"}');
  let installed = false, healthy = true, valid = true, identityOverride = {}, publicOrigin;
  upstream = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.host !== new URL(publicOrigin).host) { response.writeHead(403).end(); return; }
    if (request.url === '/local/workspace') response.end(JSON.stringify({
      id: 'fixture', origins: { app: publicOrigin }, gatewayOrigin, profile: 'role-based-data',
      sourceFingerprint: 'a'.repeat(64), authentication: { mode: 'preview' }, container: 'sql-apps-sql',
      ...identityOverride,
    }));
    else if (request.url === '/health/ready') response.writeHead(healthy ? 200 : 503).end(JSON.stringify({ status: healthy ? 'ready' : 'not-ready' }));
    else if (request.url === '/local/session') {
      if (request.method === 'DELETE') response.writeHead(204).end();
      else response.end('{"token":"fixture-preview-token"}');
    } else if (request.url === '/api/Ready') {
      assert.equal(request.headers.authorization, 'Bearer fixture-preview-token');
      response.end(valid ? '{"value":[{"ready":1}]}' : '{"unexpected":true}');
    } else if (request.url === '/api/Reports') {
      response.writeHead(503).end('{"error":"Fixture report unavailable"}');
    } else if (request.url === '/api/Slow') {
      await new Promise(done => { releaseSlowCheck = done; slowCheckStarted(); });
      response.end('{"value":[{"ready":1}]}');
    } else if (request.url === '/api/Fast') {
      response.end('{"value":[{"ready":1}]}');
    } else if (request.url === '/echo') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.end(JSON.stringify({ body, origin: request.headers.origin, forwarded: request.headers['x-forwarded-host'] ?? null }));
    } else if (request.url === '/redirect') response.writeHead(302, { location: `${gatewayOrigin}/target` }).end();
    else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><title>Actual application</title><body>Customer contacts</body></html>'); }
  });
  const gatewayOrigin = await listen(upstream);
  publicOrigin = await freeOrigin();
  const initial = initialProgress({ home, name: 'Customer contacts', publicOrigin, gatewayOrigin, workspaceId: 'fixture' });
  await writeCreationJson(join(directory, 'progress.json'), initial);
  await writeCreationJson(join(home, '.sql-apps', 'creation-session.json'),
    { version: 1, home, directory, sessionId: initial.sessionId });
  door = await startCreationFrontDoor({ directory, tools: root, interval: 75,
    inspect: async () => ({ ready: installed, build: { ready: installed } }) });
  assert.match(await (await fetch(publicOrigin)).text(), /Bringing your application to life/);
  assert.equal((await fetch(`${publicOrigin}/__sql_apps/progress`, { method: 'POST' })).status, 405);
  assert.equal((await loopbackFetch(publicOrigin, { headers: { host: 'attacker.invalid' } })).status, 403);
  installed = true;
  const usable = await eventually(publicOrigin, state => state.usable);
  assert.equal(usable.ready, false);
  assert.deepEqual(usable.blockers, ['browser-workflow', 'design-review']);
  await new Promise(done => setTimeout(done, 225));
  const cached = await (await fetch(`${publicOrigin}/__sql_apps/progress`)).json();
  assert.equal(cached.usable, false, 'an idle cached observation must not claim current health');
  assert.ok(cached.capabilities.some(item => item.state === 'stale'));
  await eventually(publicOrigin, state => state.usable);
  assert.match(await (await fetch(publicOrigin)).text(), /Actual application/);
  const echo = await (await fetch(`${publicOrigin}/echo`, { method: 'POST', headers: {
    origin: publicOrigin, 'x-forwarded-host': 'attacker.invalid',
  }, body: 'a real mutation body' })).json();
  assert.deepEqual(echo, { body: 'a real mutation body', origin: publicOrigin, forwarded: null });
  const redirect = await fetch(`${publicOrigin}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), `${publicOrigin}/target`);
  const events = await fetch(`${publicOrigin}/__sql_apps/events`);
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data:.*sessionId/);
  await writeFile(join(home, 'creation-checks.json'), JSON.stringify({
    version: 1, checks: [
      { kind: 'rest', path: '/api/Slow' },
      { kind: 'rest', path: '/api/Fast' },
      { kind: 'rest', path: '/api/Reports' },
    ],
  }));
  await Promise.race([slowCheckStartedPromise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('The slow endpoint check did not start.')), 3000))]);
  const progressive = await eventually(publicOrigin, state =>
    state.surfaces.some(item => item.path === '/api/Fast' && item.state === 'verified'));
  assert.equal(progressive.surfaces.some(item => item.path === '/api/Slow'), false);
  assert.equal((await fetch(`${publicOrigin}/api/Fast`)).status, 200);
  releaseSlowCheck();
  const partial = await eventually(publicOrigin, state =>
    state.diagnostic === 'CAPABILITY_RESPONSE_INVALID' &&
    state.surfaces.some(item => item.path === '/api/Reports' && item.state === 'failed') &&
    state.surfaces.some(item => item.path === '/api/Slow' && item.state === 'verified'));
  assert.equal(partial.usable, false);
  await reader.cancel();
  assert.equal(partial.surfaces.find(item => item.id === 'readiness').state, 'verified');
  assert.equal((await fetch(`${publicOrigin}/api/Ready`, { headers: { authorization: 'Bearer fixture-preview-token' } })).status, 200);
  assert.equal((await fetch(`${publicOrigin}/api/Reports`)).status, 503);
  assert.equal((await fetch(`${publicOrigin}/__sql_apps/endpoint?capability=readiness`)).status, 200);
  await rm(join(home, 'creation-checks.json'));
  await eventually(publicOrigin, state => state.usable);
  valid = false;
  await eventually(publicOrigin, state => state.capabilities.some(item => item.state === 'failed'));
  healthy = false;
  const dataAccessFailure = await eventually(publicOrigin, state => state.diagnostic === 'DATA_ACCESS_NOT_READY');
  assert.equal(dataAccessFailure.capabilities.find(item => item.id === 'data').state, 'verified');
  assert.match(await (await fetch(publicOrigin)).text(), /Bringing your application to life/);
  healthy = true; valid = true;
  await eventually(publicOrigin, state => state.usable);
  for (const [diagnostic, override] of [
    ['AUTHENTICATION_IDENTITY_MISMATCH', { authentication: { mode: 'entra' } }],
    ['SQL_TARGET_IDENTITY_MISMATCH', { container: 'other-sql' }],
    ['WORKSPACE_IDENTITY_MISMATCH', { id: 'other-workspace' }],
    ['BUILD_SOURCE_MISMATCH', { sourceFingerprint: 'c'.repeat(64) }],
  ]) {
    identityOverride = override;
    const mismatch = await eventually(publicOrigin, state => state.diagnostic === diagnostic);
    assert.equal(mismatch.usable, false);
    identityOverride = {};
    await eventually(publicOrigin, state => state.usable);
  }
  await door.close();
  door = await startCreationFrontDoor({ directory, tools: root, interval: 75,
    inspect: async () => ({ ready: true, build: { ready: true } }),
    probe: async () => ({ services: false, diagnostic: 'AUTHENTICATED_CHECK_REQUIRED' }) });
  const restarted = await eventually(publicOrigin, state => state.diagnostic === 'AUTHENTICATED_CHECK_REQUIRED');
  assert.equal(restarted.usable, false, 'a new front door cannot reuse historical authenticated evidence');
});
