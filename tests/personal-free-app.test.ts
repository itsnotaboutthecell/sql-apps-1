import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalFreeHandler } from '../src/personal-free-app.js';

const ownerHeader = Buffer.from(JSON.stringify({
  identityProvider: 'aad',
  userId: 'owner-provider-id',
  userDetails: 'owner@example.com',
  userRoles: ['anonymous', 'authenticated', 'owner'],
})).toString('base64');

test('personal-free API maps only declared routes to typed procedures', async () => {
  const calls: unknown[] = [];
  const handler = createPersonalFreeHandler([{
    method: 'POST',
    path: '/api/UpdateItem',
    procedure: { name: 'UpdateItem', parameters: { id: 'uniqueidentifier', completed: 'bit' } },
  }], {
    async execute(ownerId, procedure, values) {
      calls.push({ ownerId, procedure, values });
      return [{ outcome: 'ok' }];
    },
    async ready() {},
  });
  const response = await handler({
    method: 'POST',
    url: 'https://example.test/api/UpdateItem',
    headers: new Headers({ 'x-ms-client-principal': ownerHeader }),
    body: { id: '22222222-2222-5222-8222-222222222222', completed: true },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { value: [{ outcome: 'ok' }] });
  assert.deepEqual(calls, [{
    ownerId: '9e63b381-bc6b-56ec-bb77-9dfe59f62474',
    procedure: 'UpdateItem',
    values: { id: '22222222-2222-5222-8222-222222222222', completed: true },
  }]);
});

test('personal-free API rejects nonowners and undeclared routes', async () => {
  let called = false;
  const handler = createPersonalFreeHandler([], {
    async execute() { called = true; return []; },
    async ready() {},
  });
  const nonOwner = Buffer.from(JSON.stringify({
    identityProvider: 'aad', userId: 'user', userDetails: 'user@example.com',
    userRoles: ['anonymous', 'authenticated'],
  })).toString('base64');
  assert.equal((await handler({
    method: 'GET', url: 'https://example.test/api/anything',
    headers: new Headers({ 'x-ms-client-principal': nonOwner }),
  })).status, 403);
  assert.equal((await handler({
    method: 'GET', url: 'https://example.test/api/anything',
    headers: new Headers({ 'x-ms-client-principal': ownerHeader }),
  })).status, 404);
  assert.equal(called, false);
});
