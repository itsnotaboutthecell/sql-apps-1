import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  architectureModuleSchema,
  validateModuleCatalog,
  type ArchitectureModule,
} from '../src/architecture-module.js';

function moduleFixture(overrides: Partial<ArchitectureModule> = {}): ArchitectureModule {
  return {
    id: 'core',
    version: 1,
    surface: 0,
    provides: ['application-api'],
    requiresCapabilities: [],
    requiresModules: [],
    incompatibleModules: [],
    guarantees: ['private-data-path'],
    resources: [{ type: 'Microsoft.Web/sites', sku: 'B1', purpose: 'Hosts the application API' }],
    acceptanceChecks: ['api-health-check'],
    growthTransitions: [],
    ...overrides,
  };
}

test('validateModuleCatalog returns a catalog sorted by module ID', () => {
  const catalog = validateModuleCatalog([
    moduleFixture({ id: 'core' }),
    moduleFixture({ id: 'api', requiresModules: ['core'] }),
  ]);

  assert.deepEqual([...catalog.keys()], ['api', 'core']);
  assert.equal(catalog.get('api')?.requiresModules[0], 'core');
});

test('validateModuleCatalog rejects duplicate module IDs', () => {
  assert.throws(
    () => validateModuleCatalog([moduleFixture(), moduleFixture()]),
    /duplicate module ID.*core/i,
  );
});

test('validateModuleCatalog rejects a missing required module', () => {
  assert.throws(
    () => validateModuleCatalog([moduleFixture({ requiresModules: ['database'] })]),
    /unknown required module.*database/i,
  );
});

test('validateModuleCatalog reports the path of required-module dependency cycles', () => {
  assert.throws(
    () => validateModuleCatalog([
      moduleFixture({ id: 'a-module', requiresModules: ['b-module'] }),
      moduleFixture({ id: 'b-module', requiresModules: ['a-module'] }),
    ]),
    /a-module\s*->\s*b-module\s*->\s*a-module/,
  );
});

test('validateModuleCatalog rejects a module that requires and rejects the same module', () => {
  assert.throws(
    () => validateModuleCatalog([
      moduleFixture({ id: 'api', requiresModules: ['core'], incompatibleModules: ['core'] }),
      moduleFixture(),
    ]),
    /api.*both requires and rejects.*core/i,
  );
});

test('architectureModuleSchema rejects empty acceptance checks', () => {
  assert.equal(
    architectureModuleSchema.safeParse(moduleFixture({ acceptanceChecks: [] })).success,
    false,
  );
});

test('architectureModuleSchema is strict and enforces unique slug names', () => {
  assert.equal(
    architectureModuleSchema.safeParse({ ...moduleFixture(), unexpected: true }).success,
    false,
  );
  assert.equal(
    architectureModuleSchema.safeParse(moduleFixture({ provides: ['application-api', 'application-api'] })).success,
    false,
  );
  assert.equal(
    architectureModuleSchema.safeParse(moduleFixture({ growthTransitions: ['Invalid transition'] })).success,
    false,
  );
});

test('validateModuleCatalog rejects unknown incompatible modules and growth transitions', () => {
  assert.throws(
    () => validateModuleCatalog([moduleFixture({ incompatibleModules: ['missing-module'] })]),
    /unknown incompatible module.*missing-module/i,
  );
  assert.throws(
    () => validateModuleCatalog([moduleFixture({ growthTransitions: ['missing-module'] })]),
    /unknown growth transition.*missing-module/i,
  );
});
