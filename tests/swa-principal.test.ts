import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerPrincipal } from '../src/swa-principal.js';

function principal(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

const owner = {
  identityProvider: 'aad',
  userId: 'owner-provider-id',
  userDetails: 'owner@example.com',
  userRoles: ['anonymous', 'authenticated', 'owner'],
};

test('SWA owner principal yields a stable opaque owner id', () => {
  const parsed = parseOwnerPrincipal(principal(owner));
  assert.deepEqual(parsed, {
    provider: 'aad',
    userId: 'owner-provider-id',
    details: 'owner@example.com',
    roles: ['anonymous', 'authenticated', 'owner'],
    ownerId: '9e63b381-bc6b-56ec-bb77-9dfe59f62474',
  });
  assert.equal(parseOwnerPrincipal(principal(owner)).ownerId, parsed.ownerId);
});

test('SWA principal rejects missing, malformed and unauthorized identities', () => {
  for (const value of [
    undefined,
    '',
    'not-base64',
    principal({ ...owner, extra: true }),
    principal({ ...owner, userId: '' }),
    principal({ ...owner, userRoles: ['authenticated'] }),
    principal({ ...owner, userRoles: ['owner', 'owner'] }),
    principal({ ...owner, userRoles: ['owner', 'x'.repeat(129)] }),
    Buffer.alloc(8193).toString('base64'),
  ]) {
    assert.throws(() => parseOwnerPrincipal(value), /principal|owner|role/i);
  }
});
