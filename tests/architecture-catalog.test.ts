import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  architectureCatalog,
  mandatoryArchitectureModules,
} from '../src/architecture-catalog.js';
import { validateModuleCatalog } from '../src/architecture-module.js';

const optionalModuleIds = [
  'container-apps-dab-runtime',
  'managed-identity',
  'container-images',
  'static-web',
  'node-api',
  'container-apps-node-runtime',
  'visitor-session-api',
  'entra-identity',
  'files',
  'background-jobs',
  'log-analytics',
] as const;

test('mandatory architecture modules are exactly the reviewed SQL and DAB core', () => {
  assert.deepEqual(mandatoryArchitectureModules, ['azure-sql-free', 'dab']);
});

test('free SQL forbids a paid fallback and verifies free enrollment', () => {
  const sql = architectureCatalog.get('azure-sql-free');

  assert.ok(sql);
  assert.deepEqual(sql.provides, ['sql']);
  assert.deepEqual(sql.requiresModules, []);
  assert.deepEqual(sql.requiresCapabilities, []);
  assert.ok(sql.guarantees.includes('no-paid-sql-fallback'));
  assert.ok(sql.acceptanceChecks.includes('verify-sql-free-enrollment'));
});

test('catalog contains no paid SQL or bill-overage module', () => {
  assert.equal(architectureCatalog.has('paid-sql'), false);
  assert.equal(architectureCatalog.has('bill-overage'), false);
});

test('DAB requires free SQL and the DAB runtime capability', () => {
  const dab = architectureCatalog.get('dab');

  assert.ok(dab);
  assert.deepEqual(dab.provides, ['data-api']);
  assert.deepEqual(dab.requiresModules, ['azure-sql-free']);
  assert.deepEqual(dab.requiresCapabilities, ['dab-runtime']);
});

test('all reviewed optional modules exist with their exact dependency contracts', () => {
  for (const id of optionalModuleIds) assert.ok(architectureCatalog.has(id), `missing ${id}`);

  assert.deepEqual(architectureCatalog.get('container-apps-dab-runtime')?.provides, ['dab-runtime']);
  assert.deepEqual(
    architectureCatalog.get('container-apps-dab-runtime')?.requiresModules,
    ['managed-identity', 'container-images'],
  );
  assert.deepEqual(architectureCatalog.get('managed-identity')?.provides, ['managed-identity']);
  assert.deepEqual(architectureCatalog.get('container-images')?.provides, ['container-images']);
  assert.deepEqual(architectureCatalog.get('static-web')?.provides, ['static-web']);
  assert.deepEqual(architectureCatalog.get('node-api')?.provides, ['application-api']);
  assert.deepEqual(architectureCatalog.get('node-api')?.requiresCapabilities, ['node-runtime']);
  assert.deepEqual(architectureCatalog.get('container-apps-node-runtime')?.provides, ['node-runtime']);
  assert.deepEqual(
    architectureCatalog.get('container-apps-node-runtime')?.requiresModules,
    ['managed-identity', 'container-images'],
  );
  assert.deepEqual(architectureCatalog.get('visitor-session-api')?.provides, ['visitor-sessions']);
  assert.deepEqual(architectureCatalog.get('visitor-session-api')?.requiresModules, ['node-api']);
  assert.deepEqual(architectureCatalog.get('entra-identity')?.provides, ['entra-auth']);
  assert.deepEqual(architectureCatalog.get('entra-identity')?.requiresModules, ['node-api']);
  assert.deepEqual(architectureCatalog.get('files')?.provides, ['files']);
  assert.deepEqual(architectureCatalog.get('files')?.requiresModules, ['node-api', 'managed-identity']);
  assert.deepEqual(architectureCatalog.get('background-jobs')?.provides, ['background-jobs']);
  assert.deepEqual(
    architectureCatalog.get('background-jobs')?.requiresModules,
    ['node-api', 'managed-identity'],
  );
  assert.deepEqual(
    architectureCatalog.get('log-analytics')?.provides,
    ['operational-observability'],
  );
  assert.deepEqual(architectureCatalog.get('log-analytics')?.requiresModules, []);
});

test('core modules do not accidentally depend on optional module IDs', () => {
  const optionalIds = new Set<string>(optionalModuleIds);

  for (const id of mandatoryArchitectureModules) {
    const module = architectureCatalog.get(id);
    assert.ok(module);
    assert.equal(
      module.requiresModules.some(required => optionalIds.has(required)),
      false,
      `${id} must not require an optional module`,
    );
  }
});

test('DAB does not require optional observability', () => {
  const dab = architectureCatalog.get('dab');
  assert.ok(dab);
  assert.equal(dab.requiresModules.includes('log-analytics'), false);
  assert.equal(dab.requiresCapabilities.includes('operational-observability'), false);
});

test('every descriptor has reviewed metadata without claiming deployment', () => {
  for (const module of architectureCatalog.values()) {
    assert.equal(Number.isInteger(module.surface), true, `${module.id} surface`);
    assert.ok(module.acceptanceChecks.length > 0, `${module.id} acceptance check`);
    assert.ok(Array.isArray(module.resources), `${module.id} resources`);
    for (const resource of module.resources) {
      assert.match(resource.type, /^[A-Za-z][A-Za-z0-9.]+\/[A-Za-z][A-Za-z0-9/]*$/);
      assert.ok(resource.purpose.length > 0);
      assert.doesNotMatch(resource.purpose, /\bdeploy(?:ed|able|ment)?\b/i);
    }
  }
});

test('exported catalog validates and has deterministic ID ordering', () => {
  const validated = validateModuleCatalog([...architectureCatalog.values()]);
  const ids = [...architectureCatalog.keys()];

  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual([...validated.entries()], [...architectureCatalog.entries()]);
});
