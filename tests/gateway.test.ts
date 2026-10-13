import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, type GatewayDependencies } from '../src/gateway.js';
import type { RuntimeConfig } from '../src/config.js';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DependencyReadinessError } from '../src/readiness.js';

const config: RuntimeConfig = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  apiClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requiredRole: 'AppUser', readinessPath: '/api/AppReady',
  dabUrl: 'https://data.internal', publicDirectory: 'public',
};
function dependencies(overrides: Partial<GatewayDependencies> = {}): GatewayDependencies {
  return {
    async verifyUser(token) {
      if (!['alice', 'bob'].includes(token)) throw new Error('Invalid token');
      return { oid: token, tenantId: config.tenantId, ...(token === 'alice' ? { roles: ['AppUser'] } : {}) };
    },
    fetch: async () => new Response(JSON.stringify({ value: [] }), { headers: { 'content-type': 'application/json' } }),
    ...overrides,
  };
}
test('public frontend and auth config; API rejects missing/invalid tokens', async t => {
  const app = await createGateway(config, dependencies());
  t.after(() => app.close());
  assert.equal((await app.inject('/')).statusCode, 200);
  assert.equal((await app.inject('/auth/config')).json().clientId, config.apiClientId);
  assert.equal((await app.inject('/auth/config')).json().mode, 'entra');
  assert.equal((await app.inject({ url: '/local/session', method: 'POST', payload: { user: 'alice' } })).statusCode, 404);
  for (const url of ['/api/Todo', '/auth/me']) {
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
  }
  assert.equal((await app.inject({ url: '/graphql', method: 'POST', payload: {} })).statusCode, 401);
  for (const url of ['/storage', '/jobs', '/functions/echo', '/diagnostics/traces']) {
    assert.equal((await app.inject({ url, method: 'POST', payload: {} })).statusCode, 404, url);
  }
});
test('data proxy forwards bearer token, sets the required role and drops client-supplied identity and cookies', async t => {
  let target = '';
  let forwarded = new Headers();
  const app = await createGateway(config, dependencies({
    fetch: async (url, options) => {
      target = String(url);
      forwarded = new Headers(options?.headers);
      return new Response('{"value":[]}', { headers: { 'content-type': 'application/json' } });
    },
  }));
  t.after(() => app.close());
  const result = await app.inject({
    url: '/api/Todo?$first=10',
    headers: { authorization: 'Bearer alice', 'x-ms-client-principal': 'spoofed', 'x-ms-api-role': 'admin', cookie: 'secret=true' },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(target, 'https://data.internal/api/Todo?$first=10');
  assert.equal(forwarded.get('authorization'), 'Bearer alice');
  assert.equal(forwarded.get('x-ms-client-principal'), null);
  assert.equal(forwarded.get('x-ms-api-role'), 'AppUser');
  assert.equal(forwarded.get('cookie'), null);
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('data proxy forwards only the supported update-only If-Match value', async t => {
  const received: (string | null)[] = [];
  const app = await createGateway(config, dependencies({
    fetch: async (_url, options) => {
      received.push(new Headers(options?.headers).get('if-match'));
      return new Response(null, { status: 204 });
    },
  }));
  t.after(() => app.close());
  for (const value of ['*', '"untrusted-etag"']) {
    const result = await app.inject({ method: 'PATCH', url: '/api/Todo/id/example',
      headers: { authorization: 'Bearer alice', 'if-match': value }, payload: { completed: true } });
    assert.equal(result.statusCode, 204);
  }
  assert.deepEqual(received, ['*', null]);
});

test('data proxy streams upstream bodies without buffering them', async t => {
  const app = await createGateway(config, dependencies({
    fetch: async () => {
      const response = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"streamed":true}'));
          controller.close();
        },
      }), { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'arrayBuffer', {
        value: async () => { throw new Error('response was buffered'); },
      });
      return response;
    },
  }));
  t.after(() => app.close());
  const headers = { authorization: ['Bearer', 'alice'].join(' ') };
  const data = await app.inject({ url: '/api/Todo', headers });
  assert.equal(data.statusCode, 200);
  assert.deepEqual(data.json(), { streamed: true });
});

for (const { method, path } of [{ method: 'GET', path: '/api/stream' }, { method: 'POST', path: '/graphql' }]) {
  test(`${path} cancels upstream when the client disconnects during a pending read`, { timeout: 5_000 }, async t => {
    let cancelled!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { cancelled = resolve; });
    const upstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"streamed":');
      response.once('close', cancelled);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const app = await createGateway({ ...config, dabUrl: origin }, dependencies({ fetch }));
    t.after(async () => {
      upstream.closeAllConnections();
      await app.close();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = httpRequest(new URL(path, gateway), {
        method, headers: { authorization: ['Bearer', 'alice'].join(' ') },
      }, resolve);
      request.once('error', reject);
      request.end();
    });
    response.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNRESET') throw error; });
    const [chunk] = await once(response, 'data');
    assert.equal(response.statusCode, 200);
    assert.equal(chunk.toString(), '{"streamed":', 'the first chunk arrives before the upstream response ends');
    response.destroy();
    const stopped = await Promise.race([upstreamClosed.then(() => true), delay(1_000).then(() => false)]);
    assert.equal(stopped, true, 'disconnect must cancel upstream without waiting for the 30-second proxy timeout');
  });
}
test('dependency errors are explicit; readiness fails closed', async t => {
  const app = await createGateway(config, dependencies({ fetch: async () => { throw new Error('dependency secret'); } }));
  t.after(() => app.close());
  assert.equal((await app.inject('/health/live')).statusCode, 200);
  assert.equal((await app.inject('/health/ready')).statusCode, 503);
  const response = await app.inject({ url: '/api/Todo', headers: { authorization: 'Bearer alice' } });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('dependency secret'), false);
});

test('readiness exposes only a safe dependency identifier and never its private cause', async t => {
  const app = await createGateway(config, dependencies({
    ready: async () => { throw new DependencyReadinessError('data', new Error('synthetic private credential')); },
  }));
  t.after(() => app.close());
  const warning = t.mock.method(app.log, 'warn');
  const response = await app.inject('/health/ready');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'not-ready', dependency: 'data' });
  assert.equal(response.body.includes('synthetic private credential'), false);
  assert.equal(JSON.stringify(warning.mock.calls.map(call => call.arguments)).includes('synthetic private credential'), false);
  assert.equal((await app.inject('/health/live')).statusCode, 200);
});

test('current-user responses retain top-level identity and report allowed access', async t => {
  const app = await createGateway(config, dependencies());
  t.after(() => app.close());
  const response = await app.inject({ url: '/auth/me', headers: { authorization: 'Bearer alice' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { oid: 'alice', tenantId: config.tenantId, roles: ['AppUser'], access: { allowed: true } });
});

test('users without the required role are refused before the data proxy', async t => {
  let upstream = 0;
  const app = await createGateway(config, dependencies({ fetch: async () => { upstream++; return Response.json({ value: [] }); } }));
  t.after(() => app.close());
  const headers = { authorization: ['Bearer', 'bob'].join(' ') };
  assert.equal((await app.inject({ url: '/api/AppReady', headers })).statusCode, 403);
  assert.equal((await app.inject({ url: '/graphql', method: 'POST', headers, payload: {} })).statusCode, 403);
  assert.deepEqual((await app.inject({ url: '/auth/me', headers })).json().access, { allowed: false, requiredRole: 'AppUser' });
  assert.equal(upstream, 0);
});

test('production gateway does not publish developer identity tooling or simulation APIs', async t => {
  const app = await createGateway(config, dependencies());
  t.after(() => app.close());
  for (const url of ['/__dev/identity', '/__dev/identity.js', '/developer.html', '/developer.js', '/local/users']) {
    assert.equal((await app.inject(url)).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/local/session', payload: { preview: true } })).statusCode, 404);
});
