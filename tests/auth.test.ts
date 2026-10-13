import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { bearerToken, entraVerifier } from '../src/auth.js';

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const audience = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const oid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const keys = await generateKeyPair('RS256');
async function token(claims: Record<string, unknown> = {}, issuer = `https://login.microsoftonline.com/${tenant}/v2.0`, aud = audience, expiry = '5m') {
  return new SignJWT({ oid, tid: tenant, scp: 'access_as_user', ...claims })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(aud)
    .setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
}
const verify = entraVerifier(tenant, audience, async () => keys.publicKey);
test('accepts a signed delegated token from the configured tenant', async () => {
  assert.deepEqual(await verify(await token()), { oid, tenantId: tenant });
});
test('rejects wrong issuer, audience, tenant, expiry, missing scope and ID tokens', async () => {
  for (const value of [
    await token({}, 'https://attacker.invalid'),
    await token({}, undefined, 'wrong-audience'),
    await token({ tid: 'wrong-tenant' }),
    await token({}, undefined, undefined, '-1m'),
    await token({ scp: 'other' }),
    await token({ scp: undefined }),
    'not-a-jwt',
  ]) await assert.rejects(verify(value));
});
test('Bearer parsing rejects whitespace and missing token', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('Bearer abc def'), undefined);
  assert.equal(bearerToken(undefined), undefined);
});
