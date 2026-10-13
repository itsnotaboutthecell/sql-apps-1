import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserConfig } from '../src/browser-config.js';

const readinessPath = '/api/AppReady';

test('browser configuration discriminates real Entra from persona-free local preview', () => {
  for (const config of [
    { mode: 'entra', tenantId: 'tenant', clientId: 'client', scope: 'scope', readinessPath },
    { mode: 'local', readinessPath },
  ]) assert.deepEqual(parseBrowserConfig(config), config);
  assert.equal('users' in parseBrowserConfig({ mode: 'local', readinessPath, users: ['alice'] }), false);
  for (const config of [
    null, {}, { mode: 'unknown', readinessPath }, { mode: 'local' },
    { tenantId: 'tenant', clientId: 'client', scope: 'scope', readinessPath },
    { mode: 'entra', clientId: 'client', scope: 'scope', readinessPath },
  ]) assert.throws(() => parseBrowserConfig(config), /Invalid/);
});

test('the readiness path must name one DAB REST entity', () => {
  for (const path of ['/api/AppReady', '/api/Ready_2']) {
    assert.equal(parseBrowserConfig({ mode: 'local', readinessPath: path }).readinessPath, path);
  }
  for (const path of ['', '/api/', '/graphql', '/api/A/B', 'https://evil.example/api/A', '/api/A?x=1', 1]) {
    assert.throws(() => parseBrowserConfig({ mode: 'local', readinessPath: path }), /Invalid browser readiness path/);
  }
});

test('Entra browser configuration preserves the explicit local backend flag', () => {
  const config = { mode: 'entra', tenantId: 'tenant', clientId: 'client', scope: 'scope', readinessPath };
  assert.deepEqual(parseBrowserConfig(config), config);
  for (const localBackend of [false, true]) {
    assert.deepEqual(parseBrowserConfig({ ...config, localBackend }), { ...config, localBackend });
  }
});

test('Entra browser configuration rejects nonboolean local backend flags', () => {
  const config = { mode: 'entra', tenantId: 'tenant', clientId: 'client', scope: 'scope', readinessPath };
  for (const localBackend of [undefined, null, 'true', 1, {}, []]) {
    assert.throws(() => parseBrowserConfig({ ...config, localBackend }), /Invalid local backend configuration/);
  }
});