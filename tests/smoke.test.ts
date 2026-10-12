import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from '../src/smoke.js';

const origin = 'https://gateway.example.com';
const functionsUrl = 'https://functions.example.com';
const identities: Record<string, { oid: string; tenantId: string }> = {
  'user-token': { oid: '11111111-1111-1111-1111-111111111111', tenantId: 'tenant' },
  'other-token': { oid: '22222222-2222-2222-2222-222222222222', tenantId: 'tenant' },
};

interface Recorded { method: string; path: string; token?: string }

async function failure(promise: Promise<void>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof AggregateError) return error.errors.map(inner => String(inner)).join('\n');
    return String(error);
  }
  throw new Error('Expected the smoke to fail');
}

function environment(overrides: {
  rows?: (token: string) => unknown;
  graphql?: (token: string) => unknown;
  anonymous?: (path: string) => number;
  crossUser?: number;
} = {}) {
  const calls: Recorded[] = [];
  const files = new Map<string, string>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = headers.get('authorization')?.replace('Bearer ', '');
    const method = init?.method ?? 'GET';
    const path = url.pathname + url.search;
    calls.push({ method, path, ...(token ? { token } : {}) });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.origin === functionsUrl) return new Response('', { status: 401 });
    if (!token) return json({ error: 'unauthorized' }, overrides.anonymous?.(url.pathname) ?? 401);
    const identity = identities[token];
    if (!identity) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/auth/me') return json(identity);
    if (url.pathname === '/api/FileJob') return json(overrides.rows?.(token) ?? { value: [] });
    if (url.pathname === '/graphql') return json(overrides.graphql?.(token) ?? { data: { fileJobs: { items: [] } } });
    if (url.pathname === '/functions/echo') {
      return json({ result: { user: identity, input: JSON.parse(String(init?.body ?? '{}')) } });
    }
    if (url.pathname.startsWith('/storage/')) {
      const name = decodeURIComponent(url.pathname.slice('/storage/'.length));
      const owner = files.has(name);
      if (token !== 'user-token' && owner) return json({ error: 'denied' }, overrides.crossUser ?? 403);
      if (method === 'PUT') { files.set(name, String(init?.body ?? '')); return new Response(null, { status: 204 }); }
      if (!owner) return json({ error: 'missing' }, 404);
      if (method === 'DELETE') { files.delete(name); return new Response(null, { status: 204 }); }
      return new Response('private acceptance data', { status: 200 });
    }
    return json({ error: 'not found' }, 404);
  };
  return { calls, files, fetcher };
}

test('deployed smoke exercises the data path, files, functions, and anonymous rejection', async () => {
  const { calls, files, fetcher } = environment();
  await smoke(origin, 'user-token', 'other-token', fetcher, functionsUrl);
  assert.equal(files.size, 0, 'the smoke must clean up its own fixture file');
  const dataReads = calls.filter(call => call.path.startsWith('/api/FileJob') && call.token);
  assert.deepEqual(dataReads.map(call => call.token).sort(), ['other-token', 'user-token']);
  assert.ok(dataReads.every(call => call.path === '/api/FileJob?$first=5'));
  assert.equal(calls.filter(call => call.path === '/graphql' && call.token).length, 2);
  assert.ok(calls.some(call => call.path === '/api/FileJob' && !call.token));
  assert.ok(calls.some(call => call.path === '/graphql' && !call.token));
  assert.ok(calls.some(call => call.path === '/auth/me' && !call.token));
});

test('deployed smoke fails when the data path leaks another owner', async () => {
  const { fetcher } = environment({
    rows: () => ({ value: [{ id: 'row', owner_oid: '33333333-3333-3333-3333-333333333333' }] }),
  });
  assert.match(await failure(smoke(origin, 'user-token', 'other-token', fetcher, functionsUrl)), /another user's row/);
});

test('deployed smoke fails when the data path exposes an excluded field or GraphQL errors', async () => {
  for (const overrides of [
    { rows: () => ({ value: [{ id: 'row', blob_key: 'secret' }] }) },
    { graphql: () => ({ errors: [{ message: 'denied' }], data: { fileJobs: { items: [] } } }) },
    { graphql: () => ({ data: {} }) },
  ]) {
    const { fetcher } = environment(overrides);
    await failure(smoke(origin, 'user-token', 'other-token', fetcher, functionsUrl));
  }
});

test('deployed smoke fails when anonymous callers reach the data path', async () => {
  for (const path of ['/api/FileJob', '/graphql']) {
    const { fetcher } = environment({ anonymous: requested => (requested === path ? 200 : 401) });
    assert.match(await failure(smoke(origin, 'user-token', 'other-token', fetcher, functionsUrl)),
      new RegExp(`Anonymous ${path} request returned 200`));
  }
});

test('deployed smoke requires two distinct users in one tenant', async () => {
  const { fetcher } = environment();
  await assert.rejects(smoke(origin, 'user-token', 'user-token', fetcher, functionsUrl),
    /Two different verified users/);
});
