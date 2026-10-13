import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  architectureModuleSchema,
  validateModuleCatalog,
  type ArchitectureModule,
  type ArchitectureModuleCatalog,
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
  const descriptors: unknown[] = [
    { ...moduleFixture({ id: 'core' }) },
    { ...moduleFixture({ id: 'api', requiresModules: ['core'] }) },
  ];
  const catalog: ArchitectureModuleCatalog = validateModuleCatalog(descriptors);

  assert.deepEqual([...catalog.keys()], ['api', 'core']);
  assert.equal(catalog.get('api')?.requiresModules[0], 'core');
});

test('validateModuleCatalog rejects a malformed raw descriptor', () => {
  const descriptors: unknown[] = [
    { ...moduleFixture(), version: 0 },
  ];

  assert.throws(() => validateModuleCatalog(descriptors));
});

test('architectureModuleSchema accepts module IDs matching the contract regex', () => {
  for (const id of ['core-', 'core--api']) {
    assert.equal(
      architectureModuleSchema.safeParse(moduleFixture({ id })).success,
      true,
      `expected module ID ${JSON.stringify(id)} to be accepted`,
    );
  }
});

test('architectureModuleSchema rejects module IDs outside the contract regex', () => {
  for (const id of ['Core', 'a', '1core', '-core', 'core_api', 'a'.repeat(65)]) {
    assert.equal(
      architectureModuleSchema.safeParse(moduleFixture({ id })).success,
      false,
      `expected module ID ${JSON.stringify(id)} to be rejected`,
    );
  }
});

test('architectureModuleSchema requires positive integer versions', () => {
  for (const version of [0, -1, 1.5]) {
    assert.equal(
      architectureModuleSchema.safeParse(moduleFixture({ version })).success,
      false,
      `expected version ${version} to be rejected`,
    );
  }
});

test('architectureModuleSchema requires nonnegative integer surfaces', () => {
  for (const surface of [-1, 1.5]) {
    assert.equal(
      architectureModuleSchema.safeParse(moduleFixture({ surface })).success,
      false,
      `expected surface ${surface} to be rejected`,
    );
  }
});

test('architectureModuleSchema rejects empty provides', () => {
  assert.equal(
    architectureModuleSchema.safeParse(moduleFixture({ provides: [] })).success,
    false,
  );
});

test('architectureModuleSchema rejects duplicate acceptance checks', () => {
  assert.equal(
    architectureModuleSchema.safeParse(moduleFixture({
      acceptanceChecks: ['api-health-check', 'api-health-check'],
    })).success,
    false,
  );
});

test('architectureModuleSchema rejects duplicate name-list entries', () => {
  const duplicate = ['duplicate-name', 'duplicate-name'];
  const fields: Array<keyof Pick<
    ArchitectureModule,
    | 'provides'
    | 'requiresCapabilities'
    | 'requiresModules'
    | 'incompatibleModules'
    | 'guarantees'
    | 'growthTransitions'
  >> = [
    'provides',
    'requiresCapabilities',
    'requiresModules',
    'incompatibleModules',
    'guarantees',
    'growthTransitions',
  ];

  for (const field of fields) {
    assert.equal(
      architectureModuleSchema.safeParse({ ...moduleFixture(), [field]: duplicate }).success,
      false,
      `expected duplicate ${field} to be rejected`,
    );
  }
});

test('architectureModuleSchema accepts a resource without a sku', () => {
  const result = architectureModuleSchema.safeParse(moduleFixture({
    resources: [{ type: 'Microsoft.Web/sites', purpose: 'Hosts the application API' }],
  }));

  assert.equal(result.success, true);
});

test('architectureModuleSchema rejects empty resource fields', () => {
  for (const resources of [
    [{ type: '', purpose: 'Hosts the application API' }],
    [{ type: 'Microsoft.Web/sites', purpose: '' }],
    [{ type: 'Microsoft.Web/sites', sku: '', purpose: 'Hosts the application API' }],
  ]) {
    assert.equal(
      architectureModuleSchema.safeParse(moduleFixture({ resources })).success,
      false,
    );
  }
});

test('architectureModuleSchema rejects unknown resource fields', () => {
  assert.equal(
    architectureModuleSchema.safeParse({
      ...moduleFixture(),
      resources: [{
        type: 'Microsoft.Web/sites',
        purpose: 'Hosts the application API',
        region: 'westus',
      }],
    }).success,
    false,
  );
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

test('architectureModuleSchema is strict and enforces slug names', () => {
  assert.equal(
    architectureModuleSchema.safeParse({ ...moduleFixture(), unexpected: true }).success,
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
