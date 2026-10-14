import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { bridgeRequest } from '../src/functions-bridge.js';

test('Functions bridge preserves request and response semantics', async t => {
  const app = Fastify();
  t.after(() => app.close());
  app.post('/api/items/:id', async (request, reply) => {
    reply.header('set-cookie', 'session=value; HttpOnly');
    return reply.code(201).send({
      params: request.params,
      query: request.query,
      body: request.body,
      owner: request.headers['x-sql-apps-owner'],
    });
  });
  await app.ready();
  const response = await bridgeRequest(app, {
    method: 'POST',
    url: 'https://example.test/api/items/42?view=full',
    headers: new Headers({
      'content-type': 'application/json',
      'x-sql-apps-owner': '11111111-1111-5111-8111-111111111111',
    }),
    body: JSON.stringify({ title: 'hello' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('set-cookie'), 'session=value; HttpOnly');
  assert.deepEqual(await response.json(), {
    params: { id: '42' },
    query: { view: 'full' },
    body: { title: 'hello' },
    owner: '11111111-1111-5111-8111-111111111111',
  });
});

test('Functions bridge does not forward submitted platform identity headers', async t => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/who', async request => ({
    principal: request.headers['x-ms-client-principal'] ?? null,
    role: request.headers['x-ms-api-role'] ?? null,
  }));
  await app.ready();
  const response = await bridgeRequest(app, {
    method: 'GET',
    url: 'https://example.test/api/who',
    headers: new Headers({
      'x-ms-client-principal': 'forged',
      'x-ms-api-role': 'owner',
    }),
  });
  assert.deepEqual(await response.json(), { principal: null, role: null });
});
