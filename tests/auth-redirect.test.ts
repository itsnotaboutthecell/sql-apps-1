import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGateway } from '../src/gateway.js';
import { authRedirectPath } from '../src/browser-config.js';

test('Microsoft sign-in callback is public and isolated from the application', async t => {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected protected operation'); };
  const app = await createGateway({
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    apiClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    requiredRole: 'AppUser',
    readinessPath: '/api/AppReady',
    dabUrl: 'https://data.internal',
    publicDirectory: 'public',
  }, {
    verifyUser: unexpected,
    fetch: unexpected,
  });
  t.after(() => app.close());
  const callback = await app.inject(authRedirectPath);
  assert.equal(callback.statusCode, 200);
  assert.match(callback.headers['content-type'] ?? '', /text\/html/);
  assert.equal(callback.headers['cross-origin-opener-policy'], undefined);
  assert.match(callback.body, /src="\/auth\/redirect\.js"/);
  assert.doesNotMatch(callback.body, /\/app\.js|id="workspace"|\/local\/session/);
  assert.equal((await app.inject('/auth/redirect.js')).statusCode, 200);
});

test('Microsoft sign-in callback uses the MSAL redirect bridge without product startup', async () => {
  const source = await readFile('src\\web\\auth-redirect.ts', 'utf8');
  assert.match(source, /@azure\/msal-browser\/redirect-bridge/);
  assert.doesNotMatch(source, /fetch\(|configureSession|PublicClientApplication/);
});
