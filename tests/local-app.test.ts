import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalApp, developmentUsers, localAppOrigin, startLocalGateway, waitForLocalReadiness } from '../src/local-app.js';
import { readFile } from 'node:fs/promises';
import { runtimeFor } from '../src/workspace.mjs';
import { z } from 'zod';
import { request } from 'node:http';
import { generateKeyPair, SignJWT } from 'jose';

const headers = { host: new URL(localAppOrigin).host, origin: localAppOrigin };
const profile = { profile: 'role-based-data', requiredRole: 'AppUser', readinessPath: '/api/AppReady' } as const;
const bearer = (token: string) => ['Bearer', token].join(' ');
const unexpected: typeof fetch = async () => { throw new Error('Unexpected data request'); };
const healthy: typeof fetch = async () => Response.json({ value: [] });
const flaky = (fails: () => boolean): typeof fetch => async () => fails()
  ? new Response(null, { status: 503 }) : Response.json({ value: [] });
const oidOf = (forwarded: Headers) => JSON.parse(Buffer.from(forwarded.get('x-ms-client-principal')!, 'base64').toString())
  .claims.find((claim: { typ: string }) => claim.typ === 'oid').val;

async function session(app: Awaited<ReturnType<typeof createLocalApp>>, user: string) {
  const response = await app.inject({ url: '/local/session', method: 'POST', headers, payload: { user } });
  assert.equal(response.statusCode, 200);
  return z.object({ token: z.string() }).parse(response.json<unknown>()).token;
}

function loopbackGateway(t: TestContext, app: Awaited<ReturnType<typeof createLocalApp>>) {
  const listen = app.listen.bind(app);
  const responses: { status: number; body: unknown }[] = [];
  let origin: string | undefined;
  t.mock.method(app, 'listen', async (options: unknown) => {
    assert.deepEqual(options, { host: '127.0.0.1', port: runtimeFor().ports.gateway });
    origin = await listen({ host: '127.0.0.1', port: 0 });
    return origin;
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(input), new URL('/health/ready', localAppOrigin).href);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    assert.ok(origin);
    const target = new URL('/health/ready', origin);
    const signal = options.signal;
    const response = await new Promise<Response>((done, reject) => {
      const probe = request(target, {
        signal, headers: { host: new URL(localAppOrigin).host },
      }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        incoming.once('error', reject);
        incoming.once('end', () => {
          assert.ok(incoming.statusCode);
          done(new Response(Buffer.concat(chunks).toString('utf8'), { status: incoming.statusCode }));
        });
      });
      probe.once('error', reject);
      probe.end();
    });
    responses.push({ status: response.status, body: await response.clone().json() });
    return response;
  });
  return responses;
}

test('readiness uses one bounded read of the readiness procedure as the role holder', async t => {
  const requests: URL[] = [];
  const app = await createLocalApp(async (url, options) => {
    const target = new URL(String(url));
    requests.push(target);
    assert.equal(target.pathname, '/api/AppReady');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    const forwarded = new Headers(options?.headers);
    assert.equal(forwarded.get('authorization'), null);
    assert.equal(forwarded.get('x-ms-api-role'), 'AppUser');
    assert.equal(oidOf(forwarded), developmentUsers[0]!.id);
    return Response.json({ value: [{ ready: 1 }] });
  }, profile);
  t.after(() => app.close());
  const response = await app.inject({ url: '/health/ready', headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ready' });
  assert.equal(requests.length, 1);
});

for (const scenario of [
  { name: 'authorization failure', response: () => new Response(null, { status: 403 }) },
  { name: 'data outage', response: () => new Response(null, { status: 503 }) },
  { name: 'connection refusal', response: (): Response => { throw new Error('synthetic private failure'); } },
]) {
  test(`local data readiness fails closed on ${scenario.name}`, async t => {
    const app = await createLocalApp(async () => scenario.response(), profile);
    t.after(() => app.close());
    const response = await app.inject({ url: '/health/ready', headers });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'not-ready', dependency: 'data' });
    assert.equal(response.body.includes('synthetic private failure'), false);
    assert.equal((await app.inject({ url: '/health/live', headers })).statusCode, 200);
  });
}

test('each readiness probe has one four-second deadline', async t => {
  const deadlines: number[] = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadlines.push(milliseconds);
    return nativeTimeout(milliseconds);
  });
  const app = await createLocalApp(healthy, profile);
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health/ready', headers })).statusCode, 200);
  assert.deepEqual(deadlines, [4_000]);
});

test('unavailable data prevents initial listen and closes the new app after bounded retries', async () => {
  let attempts = 0;
  let waits = 0;
  let closed = false;
  const app = await createLocalApp(flaky(() => { attempts++; return true; }), profile);
  app.addHook('onClose', async () => { closed = true; });
  await assert.rejects(startLocalGateway(app, runtimeFor().defaultSql, async () => { waits++; }),
    error => error instanceof Error && /no ready URL is published/.test(error.message) &&
      error.cause instanceof Error && /data readiness failed after three read-only attempts/.test(error.cause.message));
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
  assert.equal(app.server.listening, false);
  assert.equal(closed, true);
});

for (const failsAfterListen of [false, true]) {
  test(`initial gateway ${failsAfterListen ? 'closes after failed' : 'requires successful'} real HTTP confirmation`, async t => {
    let probes = 0;
    let closed = false;
    const deadlines: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      deadlines.push(milliseconds);
      return timeout(milliseconds);
    });
    const app = await createLocalApp(flaky(() => ++probes > 1 && failsAfterListen), profile);
    t.after(() => app.close());
    app.addHook('onClose', async () => { closed = true; });
    const responses = loopbackGateway(t, app);
    const started = startLocalGateway(app, runtimeFor().defaultSql,
      async () => { assert.fail('healthy initial readiness must not retry'); });
    if (failsAfterListen) {
      await assert.rejects(started, error => error instanceof Error &&
        /no ready URL is published/.test(error.message) && error.cause instanceof Error &&
        /data readiness did not pass initial HTTP confirmation/.test(error.cause.message));
      assert.equal(app.server.listening, false);
      assert.equal(closed, true);
      assert.deepEqual(responses, [{ status: 503, body: { status: 'not-ready', dependency: 'data' } }]);
    } else {
      await started;
      assert.equal(app.server.listening, true);
      assert.equal(closed, false);
      assert.deepEqual(responses, [{ status: 200, body: { status: 'ready' } }]);
    }
    assert.equal(probes, 2);
    assert.deepEqual(deadlines, [4_000, 5_000, 4_000]);
  });
}

test('initial readiness and cleanup errors are both preserved', async () => {
  const cleanup = new Error('synthetic gateway cleanup failure');
  const app = await createLocalApp(flaky(() => true), profile);
  app.addHook('onClose', async () => { throw cleanup; });
  await assert.rejects(startLocalGateway(app, runtimeFor().defaultSql, async () => {}),
    error => error instanceof AggregateError && /no ready URL is published/.test(error.message) &&
      error.errors.length === 2 && error.errors[0] instanceof Error &&
      /data readiness failed after three read-only attempts/.test(error.errors[0].message) &&
      error.errors[1] === cleanup);
  assert.equal(app.server.listening, false);
});

for (const becomesReady of [2, 3]) {
  test(`initial readiness stops retrying when data recovers on attempt ${becomesReady}`, async t => {
    let attempts = 0;
    let waits = 0;
    const app = await createLocalApp(flaky(() => ++attempts < becomesReady), profile);
    t.after(() => app.close());
    await waitForLocalReadiness(app, async () => { waits++; });
    assert.equal(attempts, becomesReady);
    assert.equal(waits, becomesReady - 1);
    assert.equal(app.server.listening, false);
  });
}

test('local app serves the frontend and persona-free preview configuration', async t => {
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/', headers })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: '/auth/config', headers })).json(), { mode: 'local', readinessPath: '/api/AppReady' });
  assert.equal((await app.inject({ url: '/auth/me', headers })).statusCode, 401);
  const users = await app.inject({ url: '/local/users', headers });
  assert.equal(users.statusCode, 200);
  assert.deepEqual(users.json().users.map((user: { id: string }) => user.id), developmentUsers.map(user => user.id));
  assert.equal(users.headers['cache-control'], 'no-store');
});

test('local workspace identity reports the role-based profile and build', async t => {
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  const identity = (await app.inject({ url: '/local/workspace', headers })).json();
  assert.equal(identity.version, 1);
  assert.equal(identity.profile, 'role-based-data');
  assert.equal(identity.origins.app, localAppOrigin);
  assert.equal(identity.container, runtimeFor().defaultSql);
  assert.equal(identity.sourceFingerprint, JSON.parse(await readFile('dist/build-provenance.json', 'utf8')).sourceFingerprint);
  assert.deepEqual(identity.authentication, { mode: 'preview' });
});

test('local workspace identity names the explicitly selected SQL container', async t => {
  const app = await createLocalApp(unexpected, profile, 'selected-external-sql');
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/local/workspace', headers })).json().container, 'selected-external-sql');
});

test('local sessions reject remote hosts, cross-origin requests, unknown users and fabricated bearer tokens', async t => {
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  for (const untrusted of [
    { host: 'evil.example', origin: localAppOrigin },
    { host: headers.host, origin: 'https://evil.example' },
    { host: headers.host },
  ]) {
    assert.equal((await app.inject({ url: '/local/session', method: 'POST', headers: untrusted,
      payload: { user: developmentUsers[0]!.id } })).statusCode, 403);
  }
  assert.equal((await app.inject({ url: '/local/session', method: 'POST', headers,
    payload: { user: 'invented-user' } })).statusCode, 400);
  assert.equal((await app.inject({ url: '/auth/me', headers: { ...headers, authorization: bearer('fabricated') } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/AppReady', method: 'POST', headers: { ...headers, origin: 'https://evil.example' },
    payload: {} })).statusCode, 403);
});

test('local gateway derives SQL identity from issued sessions and replaces untrusted identity headers', async t => {
  let upstream = 0;
  let upstreamHeaders = new Headers();
  const app = await createLocalApp(async (_url, options) => {
    upstream++;
    upstreamHeaders = new Headers(options?.headers);
    return new Response('{"value":[]}');
  }, profile);
  t.after(() => app.close());
  const first = await app.inject({ url: '/local/session', method: 'POST', headers, payload: { user: developmentUsers[0]!.id } });
  const token: string = first.json().token;
  assert.equal(token.length, 43);
  assert.equal(first.headers['cache-control'], 'no-store');
  const authenticated = { ...headers, authorization: bearer(token), 'x-ms-client-principal': 'forged', 'x-ms-api-role': 'admin' };
  assert.equal((await app.inject({ url: '/auth/me', headers: { ...authenticated, host: 'evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/auth/me', headers: authenticated })).json().oid, developmentUsers[0]!.id);
  assert.equal((await app.inject({ url: '/api/AppReady', headers: authenticated })).statusCode, 200);
  assert.equal(oidOf(upstreamHeaders), developmentUsers[0]!.id);
  assert.equal(upstreamHeaders.get('authorization'), null);
  assert.equal(upstreamHeaders.get('x-ms-api-role'), 'AppUser');
  const second = await app.inject({ url: '/local/session', method: 'POST', headers: authenticated, payload: { user: developmentUsers[1]!.id } });
  assert.equal(second.statusCode, 200);
  assert.equal((await app.inject({ url: '/auth/me', headers: authenticated })).statusCode, 401);
  const bob = { ...headers, authorization: bearer(second.json().token) };
  const bobMe = (await app.inject({ url: '/auth/me', headers: bob })).json();
  assert.equal(bobMe.oid, developmentUsers[1]!.id);
  assert.deepEqual(bobMe.access, { allowed: false, requiredRole: 'AppUser' });
  assert.equal((await app.inject({ url: '/api/AppReady', headers: bob })).statusCode, 403);
  assert.equal(upstream, 1);
  assert.equal((await app.inject({ url: '/local/session', method: 'DELETE', headers: bob })).statusCode, 204);
  assert.equal((await app.inject({ url: '/auth/me', headers: bob })).statusCode, 401);
});

test('removed foundation routes are not served locally', async t => {
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  const authenticated = { ...headers, authorization: bearer(await session(app, developmentUsers[0]!.id)) };
  assert.equal((await app.inject({ url: '/storage/file', headers: authenticated })).statusCode, 404);
  assert.equal((await app.inject({ url: '/jobs', headers: authenticated })).statusCode, 404);
  assert.equal((await app.inject({ url: '/functions/echo', method: 'POST', headers: authenticated, payload: {} })).statusCode, 404);
});

test('local app cannot start in a production environment', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(createLocalApp(unexpected, profile), /disabled in production/); }
  finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('local preview sessions issue opaque tokens that expire exactly after eight hours', async t => {
  const started = 1_000;
  let now = started;
  t.mock.method(Date, 'now', () => now);
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/local/session', headers, payload: { preview: true } });
  assert.equal(response.statusCode, 200);
  const token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(response.json<unknown>()).token;
  assert.equal(response.headers['cache-control'], 'no-store');
  const authenticated = { ...headers, authorization: bearer(token) };
  now = started + 8 * 60 * 60 * 1_000 - 1;
  const active = await app.inject({ url: '/auth/me', headers: authenticated });
  assert.equal(active.statusCode, 200);
  assert.equal(active.json().oid, developmentUsers[0]!.id);
  now++;
  assert.equal((await app.inject({ url: '/auth/me', headers: authenticated })).statusCode, 401);
});

test('local preview session selection is a strict union and requires the exact local origin', async t => {
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/local/session',
    headers: { ...headers, origin: 'https://evil.example' }, payload: { preview: true } })).statusCode, 403);
  for (const payload of [
    { preview: true, user: developmentUsers[1]!.id },
    { preview: true, roles: ['AppUser'] },
    { user: developmentUsers[0]!.id, roles: ['AppUser'] },
    {},
  ]) {
    const response = await app.inject({ method: 'POST', url: '/local/session', headers, payload });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'Choose local preview or a configured development user' });
  }
});

test('local Entra verifies signed identity and role without accepting preview sessions or forged DAB claims', async t => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const oid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const authentication = { mode: 'entra', tenantId, clientId } as const;
  const keys = await generateKeyPair('RS256');
  const signed = (roles: string[], tid = tenantId) => new SignJWT({ oid, tid, scp: 'access_as_user', roles })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(clientId).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  let upstream = 0;
  let forwarded = new Headers();
  const app = await createLocalApp(async (_url, options) => {
    upstream++;
    forwarded = new Headers(options?.headers);
    return Response.json({ value: [] });
  }, profile, runtimeFor().defaultSql, authentication, async () => keys.publicKey);
  t.after(() => app.close());
  const config = await app.inject({ url: '/auth/config', headers });
  assert.equal(config.statusCode, 200);
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.deepEqual(config.json(), { mode: 'entra', tenantId, clientId, scope: `api://${clientId}/access_as_user`,
    localBackend: true, readinessPath: '/api/AppReady' });
  const workspace = await app.inject({ url: '/local/workspace', headers });
  assert.deepEqual(workspace.json().authentication, authentication);
  const allowed = { ...headers, authorization: bearer(await signed(['AppUser'])),
    'x-ms-api-role': 'admin', 'x-ms-client-principal': 'forged' };
  const me = await app.inject({ url: '/auth/me', headers: allowed });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), { oid, tenantId, roles: ['AppUser'], access: { allowed: true } });
  assert.equal((await app.inject({ url: '/api/AppReady', headers: allowed })).statusCode, 200);
  assert.equal(upstream, 1);
  assert.equal(forwarded.get('authorization'), null);
  assert.equal(forwarded.get('x-ms-api-role'), 'AppUser');
  assert.equal(oidOf(forwarded), oid);
  const denied = { ...headers, authorization: bearer(await signed([])), 'x-ms-api-role': 'AppUser' };
  const deniedMe = await app.inject({ url: '/auth/me', headers: denied });
  assert.equal(deniedMe.statusCode, 200);
  assert.deepEqual(deniedMe.json().access, { allowed: false, requiredRole: 'AppUser' });
  assert.equal((await app.inject({ url: '/api/AppReady', headers: denied })).statusCode, 403);
  for (const token of ['invented-preview-token', await signed(['AppUser'], 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')]) {
    const invalid = { ...headers, authorization: bearer(token) };
    assert.equal((await app.inject({ url: '/auth/me', headers: invalid })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/AppReady', headers: invalid })).statusCode, 401);
  }
  assert.equal(upstream, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/local/session', headers, payload: { preview: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/local/session', headers: allowed })).statusCode, 404);
  assert.equal((await app.inject({ url: '/local/users', headers })).statusCode, 404);
});

test('local Entra readiness remains an independent bounded synthetic dependency read', async t => {
  const authentication = { mode: 'entra', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } as const;
  let probes = 0;
  const app = await createLocalApp(async (url, options) => {
    probes++;
    assert.equal(new URL(String(url)).pathname, '/api/AppReady');
    const forwarded = new Headers(options?.headers);
    assert.equal(forwarded.get('authorization'), null);
    assert.equal(forwarded.get('x-ms-api-role'), 'AppUser');
    assert.equal(oidOf(forwarded), developmentUsers[0]!.id);
    return Response.json({ value: [] });
  }, profile, runtimeFor().defaultSql, authentication);
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health/ready', headers })).statusCode, 200);
  assert.equal(probes, 1);
  assert.equal((await app.inject({ url: '/auth/me', headers })).statusCode, 401);
  assert.equal(probes, 1);
});

test('local preview serves developer identity testing separately from the product', async t => {
  const app = await createLocalApp(unexpected, profile);
  t.after(() => app.close());
  const product = await app.inject({ url: '/', headers });
  assert.equal(product.statusCode, 200);
  assert.doesNotMatch(product.body, /development-user|select-user|Alice|Bob/);
  const page = await app.inject({ url: '/__dev/identity', headers });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Development identity testing/);
  assert.match(page.body, /do not expose.*remotely/i);
  assert.match(page.body, /id="development-user"/);
  assert.match(page.body, /src="\/__dev\/identity.js"/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
  const script = await app.inject({ url: '/__dev/identity.js', headers });
  assert.equal(script.statusCode, 200);
  assert.doesNotMatch(script.body, /^import\s/m);
  assert.equal(script.headers['cache-control'], 'no-store');
  assert.match(String(script.headers['content-type']), /^text\/javascript/);
  assert.equal(script.headers['x-content-type-options'], 'nosniff');
  for (const url of ['/__dev/identity', '/__dev/identity.js']) {
    assert.equal((await app.inject({ url, headers: { ...headers, host: 'evil.example' } })).statusCode, 403);
  }
});

test('local Entra sign-in does not expose developer identity simulation', async t => {
  const app = await createLocalApp(unexpected, profile, runtimeFor().defaultSql, {
    mode: 'entra', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  t.after(() => app.close());
  for (const url of ['/__dev/identity', '/__dev/identity.js', '/local/users']) {
    assert.equal((await app.inject({ url, headers })).statusCode, 404, url);
  }
});