import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodoExampleClient } from '../client.js';
import { ApiError } from '../../../src/client.js';
import { smoke } from '../smoke.js';

test('authenticated Todo writes reject invalid SQL-width titles before HTTP', async () => {
  const bodies: unknown[] = [];
  const id = '11111111-1111-4111-8111-111111111111';
  const client = new TodoExampleClient({
    baseUrl: 'https://app.example', getAccessToken: async () => 'token',
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      return new Response(null, { status: 204 });
    },
  });
  for (const title of ['', '   ', 'x'.repeat(201), String.fromCodePoint(0x1F33F).repeat(100) + 'x']) {
    await assert.rejects(client.createTodo(title, id));
    await assert.rejects(client.updateTodo(id, { title }));
  }
  assert.equal(bodies.length, 0);
  const title = String.fromCodePoint(0x1F33F).repeat(100);
  await client.createTodo(` ${title} `, id);
  await client.updateTodo(id, { title: ` ${title} ` });
  assert.deepEqual(bodies, [{ id, title }, { title }]);
});

test('authenticated Todo reads reject titles exceeding the SQL UTF-16 limit', async () => {
  for (const title of ['', 'x'.repeat(201), String.fromCodePoint(0x1F33F).repeat(100) + 'x']) {
    const client = new TodoExampleClient({
      baseUrl: 'https://app.example', getAccessToken: async () => 'token',
      fetch: async () => Response.json({ value: [{
        id: '11111111-1111-4111-8111-111111111111', title, completed: false,
      }] }),
    });
    await assert.rejects(client.listTodos(), /invalid Todo/);
  }
});

test('client attaches token, validates payload, and rejects cross-origin routes', async () => {
  let tokenHeader: string | null = null;
  const client = new TodoExampleClient({
    baseUrl: 'https://app.example',
    getAccessToken: async () => 'token',
    fetch: async (_url, init) => {
      tokenHeader = new Headers(init?.headers).get('authorization');
      assert.equal(init?.redirect, 'error');
      return new Response('{"value":[{"id":"1","title":"Todo","completed":false}]}');
    },
  });
  assert.deepEqual(await client.listTodos(), [{ id: '1', title: 'Todo', completed: false }]);
  assert.equal(tokenHeader, 'Bearer token');
  await assert.rejects(client.request('//attacker.invalid'), /Cross-origin/);
});
test('client rejects API errors and invalid Todo output', async () => {
  const client = new TodoExampleClient({
    baseUrl: 'https://app.example', getAccessToken: async () => 'token',
    fetch: async () => new Response('{}', { status: 403 }),
  });
  await assert.rejects(client.listTodos(), (error: unknown) => error instanceof ApiError && error.status === 403);
  const invalid = new TodoExampleClient({
    baseUrl: 'https://app.example', getAccessToken: async () => 'token',
    fetch: async () => new Response('{"value":[{"id":42}]}'),
  });
  await assert.rejects(invalid.listTodos(), /invalid Todo/);
});
test('Todo lists follow relative DAB continuation links without altering tokens', async () => {
    const urls: string[] = [];
    const next = '/api/Todo?$after=opaque%2Btoken%3D&$first=1';
    const client = new TodoExampleClient({
      baseUrl: 'https://app.example', getAccessToken: async () => 'token',
      fetch: async url => {
        urls.push(String(url));
        return new Response(JSON.stringify(urls.length === 1
          ? { value: [{ id: '1', title: 'First', completed: false }], nextLink: next }
          : { value: [{ id: '2', title: 'Second', completed: true }] }));
      },
    });
    assert.deepEqual((await client.listTodos()).map(todo => todo.id), ['1', '2']);
    assert.deepEqual(urls, ['https://app.example/api/Todo', `https://app.example${next}`]);
  });
  test('Todo pagination rejects unsafe, malformed and repeated links before fetching them', async () => {
    for (const nextLink of [
      '//attacker.example/api/Todo', 'https://data.internal/api/Todo', '/functions/echo',
      'https://user:password@app.example/api/Todo?$after=x', '/api/Todo#fragment',
      '/api/Todo', '', null, 42,
    ]) {
      let requests = 0;
      const client = new TodoExampleClient({
        baseUrl: 'https://app.example', getAccessToken: async () => 'token',
        fetch: async () => { requests++; return new Response(JSON.stringify({ value: [], nextLink })); },
      });
      await assert.rejects(client.listTodos(), /continuation link/);
      assert.equal(requests, 1);
    }
  });
test('live acceptance rejects a single identity before creating data', async () => {
  let mutations = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method && init.method !== 'GET') mutations++;
    return new Response('{"oid":"same-user","tenantId":"tenant"}');
  };
  await assert.rejects(smoke('https://app.example', 'a', 'b', fetcher), /Two different/);
  assert.equal(mutations, 0);
});
test('Todo client normalizes SQL GUID casing and uses update-only PATCH', async () => {
  const client = new TodoExampleClient({
    baseUrl: 'https://app.example', getAccessToken: async () => 'token',
    fetch: async (_url, init) => {
      if (init?.method === 'PATCH') {
        assert.equal(new Headers(init.headers).get('if-match'), '*');
        return new Response(null, { status: 204 });
      }
      return new Response('{"value":[{"id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","title":"SQL GUID","completed":false}]}');
    },
  });
  assert.equal((await client.listTodos())[0]?.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await client.updateTodo('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { completed: true });
});
test('client invokes the default fetch without binding it to the client instance', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function (this: unknown) {
    assert.equal(this, undefined);
    return new Response('{"value":[]}');
  };
  try {
    const client = new TodoExampleClient({ baseUrl: 'https://app.example', getAccessToken: async () => 'token' });
    assert.deepEqual(await client.listTodos(), []);
  } finally { globalThis.fetch = original; }
});
test('acceptance succeeds with isolated dependencies and cleans up its fixtures', async () => {
  const rows = new Map<string, { id: string; title: string; completed: boolean; owner: string }>();
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const user = new Headers(init?.headers).get('authorization');
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (!user) return response({}, 401);
    if (path === '/auth/me') return response({ oid: user, tenantId: 'tenant' });
    if (path === '/api/Todo' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as { id: string; title: string };
      rows.set(input.id, { ...input, completed: false, owner: user });
      return response({ value: [input] }, 201);
    }
    if (path === '/api/Todo') return response({ value: [...rows.values()].filter(row => row.owner === user) });
    if (path.startsWith('/api/Todo/id/')) {
      const id = path.split('/').at(-1)!;
      const row = rows.get(id);
      if (!row || row.owner !== user) return response({}, 404);
      if (init?.method === 'DELETE') rows.delete(id);
      else if (init?.method === 'PATCH') row.completed = true;
      return response({});
    }
    if (path === '/graphql') return response({ data: { todos: { items: [...rows.values()].filter(row => row.owner === user) } } });
    throw new Error(`Unexpected acceptance path: ${path}`);
  };
  await smoke('https://app.example', 'a', 'b', fetcher);
  assert.equal(rows.size, 0);
});
