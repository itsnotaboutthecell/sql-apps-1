import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  architectureCatalog,
  mandatoryArchitectureModules,
} from '../src/architecture-catalog.js';
import {
  validateModuleCatalog,
  type ReadonlyArchitectureModuleCatalog,
} from '../src/architecture-module.js';

const expectedContracts = [
  {
    id: 'azure-sql-free',
    provides: ['sql'],
    requiresModules: [],
    requiresCapabilities: [],
  },
  {
    id: 'background-jobs',
    provides: ['background-jobs'],
    requiresModules: ['node-api', 'managed-identity'],
    requiresCapabilities: [],
  },
  {
    id: 'container-apps-dab-runtime',
    provides: ['dab-runtime'],
    requiresModules: ['managed-identity', 'container-images'],
    requiresCapabilities: [],
  },
  {
    id: 'container-apps-node-runtime',
    provides: ['node-runtime'],
    requiresModules: ['managed-identity', 'container-images'],
    requiresCapabilities: [],
  },
  {
    id: 'container-images',
    provides: ['container-images'],
    requiresModules: [],
    requiresCapabilities: [],
  },
  {
    id: 'dab',
    provides: ['data-api'],
    requiresModules: ['azure-sql-free'],
    requiresCapabilities: ['dab-runtime'],
  },
  {
    id: 'entra-identity',
    provides: ['entra-auth'],
    requiresModules: ['node-api'],
    requiresCapabilities: [],
  },
  {
    id: 'files',
    provides: ['files'],
    requiresModules: ['node-api', 'managed-identity'],
    requiresCapabilities: [],
  },
  {
    id: 'log-analytics',
    provides: ['operational-observability'],
    requiresModules: [],
    requiresCapabilities: [],
  },
  {
    id: 'managed-identity',
    provides: ['managed-identity'],
    requiresModules: [],
    requiresCapabilities: [],
  },
  {
    id: 'node-api',
    provides: ['application-api'],
    requiresModules: [],
    requiresCapabilities: ['node-runtime'],
  },
  {
    id: 'static-web',
    provides: ['static-web'],
    requiresModules: [],
    requiresCapabilities: [],
  },
  {
    id: 'visitor-session-api',
    provides: ['visitor-sessions'],
    requiresModules: ['node-api'],
    requiresCapabilities: [],
  },
] as const;

test('mandatory architecture modules are exactly the reviewed SQL and DAB core', () => {
  assert.deepEqual(mandatoryArchitectureModules, ['azure-sql-free', 'dab']);
});

test('catalog has the exact reviewed module IDs and dependency contracts', () => {
  const actualContracts = [...architectureCatalog.values()].map(module => ({
    id: module.id,
    provides: module.provides,
    requiresModules: module.requiresModules,
    requiresCapabilities: module.requiresCapabilities,
  }));

  assert.deepEqual(actualContracts, expectedContracts);
});

test('free SQL uses the exact reviewed SKU and policy metadata', () => {
  const sql = architectureCatalog.get('azure-sql-free');

  assert.ok(sql);
  assert.deepEqual(sql.resources, [
    {
      type: 'Microsoft.Sql/servers',
      purpose: 'Provides the logical server for the free Azure SQL Database',
    },
    {
      type: 'Microsoft.Sql/servers/databases',
      sku: 'GP_S_Gen5_2',
      purpose: 'Stores relational data with free enrollment and no paid fallback',
    },
  ]);
  assert.ok(sql.guarantees.includes('no-paid-sql-fallback'));
  assert.ok(sql.acceptanceChecks.includes('verify-sql-free-enrollment'));
});

test('catalog contains no paid SQL or bill-overage module', () => {
  for (const id of architectureCatalog.keys()) {
    assert.doesNotMatch(id, /paid-sql|bill-overage/);
  }
});

test('resource metadata includes required parents and identical shared resources', () => {
  const dabRuntime = architectureCatalog.get('container-apps-dab-runtime');
  const nodeRuntime = architectureCatalog.get('container-apps-node-runtime');
  const files = architectureCatalog.get('files');
  const jobs = architectureCatalog.get('background-jobs');

  assert.ok(dabRuntime);
  assert.ok(nodeRuntime);
  assert.ok(files);
  assert.ok(jobs);
  assert.deepEqual(dabRuntime.resources[0], nodeRuntime.resources[0]);
  assert.equal(dabRuntime.resources[0]?.type, 'Microsoft.App/managedEnvironments');
  assert.deepEqual(files.resources[0], jobs.resources[0]);
  assert.equal(files.resources[0]?.type, 'Microsoft.Storage/storageAccounts');
});

test('surface equals the complete resource footprint for every module', () => {
  for (const module of architectureCatalog.values()) {
    assert.equal(module.surface, module.resources.length, `${module.id} surface`);
  }
});

test('every descriptor has reviewed metadata without claiming deployment', () => {
  for (const module of architectureCatalog.values()) {
    assert.ok(module.acceptanceChecks.length > 0, `${module.id} acceptance check`);
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

test('exported catalog is read-only at its type-facing API', () => {
  const readonlyCatalog: ReadonlyArchitectureModuleCatalog = architectureCatalog;
  type CatalogHasSet = 'set' extends keyof typeof architectureCatalog ? true : false;
  type CatalogHasDelete = 'delete' extends keyof typeof architectureCatalog ? true : false;
  type CatalogHasClear = 'clear' extends keyof typeof architectureCatalog ? true : false;
  const mutatorsExposed: [CatalogHasSet, CatalogHasDelete, CatalogHasClear] =
    [false, false, false];

  assert.equal(readonlyCatalog.size, expectedContracts.length);
  assert.deepEqual(mutatorsExposed, [false, false, false]);
});

test('exported catalog and descriptor metadata reject runtime mutation', () => {
  type CatalogMutators = {
    set: (key: string, value: unknown) => unknown;
    delete: (key: string) => boolean;
    clear: () => void;
  };
  const runtimeCatalog = architectureCatalog as unknown as Partial<CatalogMutators>;
  const sql = architectureCatalog.get('azure-sql-free');
  assert.ok(sql);

  assert.equal(runtimeCatalog.set, undefined);
  assert.equal(runtimeCatalog.delete, undefined);
  assert.equal(runtimeCatalog.clear, undefined);
  assert.throws(() => {
    (sql as { id: string }).id = 'changed';
  }, TypeError);
  assert.throws(() => (sql.requiresModules as string[]).push('managed-identity'), TypeError);
  assert.throws(
    () => (sql.resources as Array<{ type: string; purpose: string }>).push({
      type: 'Microsoft.Sql/servers/firewallRules',
      purpose: 'Changed',
    }),
    TypeError,
  );
  assert.throws(
    () => {
      (sql.resources[0] as { purpose: string }).purpose = 'Changed';
    },
    TypeError,
  );
  assert.deepEqual(sql.requiresModules, []);
  assert.equal(
    sql.resources[0]?.purpose,
    'Provides the logical server for the free Azure SQL Database',
  );
});
