import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalFreeHandler, parsePersonalFreeBody } from '../src/personal-free-app.js';

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

test('personal-free API validates values against declared SQL parameter types', async () => {
  let called = false;
  const handler = createPersonalFreeHandler([{
    method: 'POST',
    path: '/api/UpdateItem',
    procedure: { name: 'UpdateItem', parameters: { completed: 'bit' } },
  }], {
    async execute() { called = true; return []; },
    async ready() {},
  });
  const response = await handler({
    method: 'POST',
    url: 'https://example.test/api/UpdateItem',
    headers: new Headers({ 'x-ms-client-principal': ownerHeader }),
    body: { completed: 'false' },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid procedure parameters' });
  assert.equal(called, false);

  const extra = await handler({
    method: 'POST',
    url: 'https://example.test/api/UpdateItem',
    headers: new Headers({ 'x-ms-client-principal': ownerHeader }),
    body: { completed: false, unexpected: true },
  });
  assert.equal(extra.status, 400);
  assert.deepEqual(await extra.json(), { error: 'Invalid procedure parameters' });
  assert.equal(called, false);
});

test('personal-free API logs procedure failures without returning database details', async () => {
  const failures: unknown[] = [];
  const handler = createPersonalFreeHandler([{
    method: 'GET',
    path: '/api/AppReady',
    procedure: { name: 'AppReady', parameters: {} },
  }], {
    async execute() { throw new Error('Invalid object name dbo.PrivateLedger'); },
    async ready() {},
  }, (error: unknown) => failures.push(error));
  const response = await handler({
    method: 'GET',
    url: 'https://example.test/api/AppReady',
    headers: new Headers({ 'x-ms-client-principal': ownerHeader }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Service operation failed' });
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /PrivateLedger/);
});

test('personal-free request body parser reports malformed JSON as client input', () => {
  assert.deepEqual(parsePersonalFreeBody('{"completed":false}'), { completed: false });
  assert.throws(() => parsePersonalFreeBody('{broken'), error =>
    error instanceof Error && error.message === 'Invalid JSON request body' &&
    'statusCode' in error && error.statusCode === 400);
});
