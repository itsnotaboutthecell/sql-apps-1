import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileArchitecture,
  type CompiledArchitecturePlan,
} from '../src/architecture-compiler.js';
import { createReadonlyModuleCatalog } from '../src/architecture-module.js';

const fingerprint = 'a'.repeat(64);

function intent(
  capabilities: string[],
  guarantees = ['synthetic-data-only'],
  growth = ['add-operational-observability'],
): unknown {
  return {
    version: 1,
    briefFingerprint: fingerprint,
    capabilities,
    guarantees,
    optimization: 'simplest-validated-start',
    growth,
  };
}

function descriptor(
  id: string,
  provides: string[],
  options: {
    surface?: number;
    requiresModules?: string[];
    requiresCapabilities?: string[];
    incompatibleModules?: string[];
    resources?: Array<{ type: string; sku?: string; purpose: string }>;
  } = {},
) {
  return {
    id,
    version: 1,
    surface: options.surface ?? options.resources?.length ?? 0,
    provides,
    requiresCapabilities: options.requiresCapabilities ?? [],
    requiresModules: options.requiresModules ?? [],
    incompatibleModules: options.incompatibleModules ?? [],
    guarantees: [`guarantee-${id}`],
    resources: options.resources ?? [],
    acceptanceChecks: [`check-${id}`],
    growthTransitions: [],
  };
}

test('compilation is invariant to requested capability order', () => {
  const forward = compileArchitecture(intent([
    'static-web',
    'application-api',
    'visitor-sessions',
  ]));
  const reversed = compileArchitecture(intent([
    'visitor-sessions',
    'application-api',
    'static-web',
  ]));

  assert.deepEqual(reversed, forward);
});

test('compiles the exact mandatory SQL and DAB core with its runtime closure', () => {
  const plan = compileArchitecture(intent(['static-web']));

  assert.deepEqual(plan.mandatoryCore, ['azure-sql-free', 'dab']);
  assert.ok(plan.modules.includes('azure-sql-free'));
  assert.ok(plan.modules.includes('dab'));
  assert.ok(plan.modules.includes('container-apps-dab-runtime'));
  assert.equal(plan.version, 1);
  assert.equal(plan.optimization, 'simplest-validated-start');
});

test('visitor plans include visitor sessions without unrelated optional modules', () => {
  const plan = compileArchitecture(intent([
    'static-web',
    'application-api',
    'visitor-sessions',
  ]));

  assert.ok(plan.modules.includes('visitor-session-api'));
  assert.ok(!plan.modules.includes('entra-identity'));
  assert.ok(!plan.modules.includes('log-analytics'));
});

test('selects optional identity, files, and logs only when requested', () => {
  const basic = compileArchitecture(intent(['static-web']));
  const expanded = compileArchitecture(intent([
    'static-web',
    'entra-auth',
    'files',
    'operational-observability',
  ]));

  for (const module of ['entra-identity', 'files', 'log-analytics']) {
    assert.ok(!basic.modules.includes(module), `${module} absent from basic plan`);
    assert.ok(expanded.modules.includes(module), `${module} present in expanded plan`);
  }
});

test('throws an actionable error for unsupported server-rendered capability', () => {
  assert.throws(
    () => compileArchitecture(intent(['server-rendered'])),
    /No supported module provides server-rendered/,
  );
});

test('emits review-only flags, explicit limitations, and a canonical approval', () => {
  const plan: CompiledArchitecturePlan = compileArchitecture(intent(['static-web']));

  assert.equal(plan.authorized, false);
  assert.equal(plan.deployable, false);
  assert.match(plan.approval, /^[a-f0-9]{12}$/);
  assert.ok(plan.limitations.some(value => /Azure eligibility unverified/i.test(value)));
  assert.ok(plan.limitations.some(value => /metadata-only/i.test(value)));
  assert.ok(plan.limitations.some(value => /costs not quoted/i.test(value)));
  assert.ok(plan.limitations.some(value => /no Azure writes authorized/i.test(value)));
});

test('searches all compositions and ranks by module count before surface and IDs', () => {
  const catalog = createReadonlyModuleCatalog([
    descriptor('azure-sql-free', ['sql']),
    descriptor('dab', ['data-api']),
    descriptor('api-only', ['api-helper'], { surface: 0 }),
    descriptor('shared-helper', ['shared-helper'], { surface: 8 }),
    descriptor('a-api-provider', ['application-api'], {
      requiresModules: ['api-only'],
    }),
    descriptor('z-api-provider', ['application-api'], {
      requiresModules: ['shared-helper'],
    }),
    descriptor('files-provider', ['files'], {
      requiresModules: ['shared-helper'],
    }),
  ]);

  const plan = compileArchitecture(intent(['application-api', 'files']), catalog);

  assert.ok(plan.modules.includes('z-api-provider'));
  assert.ok(!plan.modules.includes('a-api-provider'));
  assert.deepEqual(plan.modules, [...plan.modules].sort());
});

test('uses surface then lexicographic IDs to break equal module-count ties', () => {
  const lowerSurface = createReadonlyModuleCatalog([
    descriptor('azure-sql-free', ['sql']),
    descriptor('dab', ['data-api']),
    descriptor('a-provider', ['static-web'], { surface: 4 }),
    descriptor('z-provider', ['static-web'], { surface: 1 }),
  ]);
  const lexical = createReadonlyModuleCatalog([
    descriptor('azure-sql-free', ['sql']),
    descriptor('dab', ['data-api']),
    descriptor('a-provider', ['static-web'], { surface: 1 }),
    descriptor('z-provider', ['static-web'], { surface: 1 }),
  ]);

  assert.ok(compileArchitecture(intent(['static-web']), lowerSurface).modules.includes('z-provider'));
  assert.ok(compileArchitecture(intent(['static-web']), lexical).modules.includes('a-provider'));
});

test('rejects impossible compositions with an error naming incompatible modules', () => {
  const catalog = createReadonlyModuleCatalog([
    descriptor('azure-sql-free', ['sql']),
    descriptor('dab', ['data-api']),
    descriptor('blocked-provider', ['static-web'], {
      incompatibleModules: ['dab'],
    }),
  ]);

  assert.throws(
    () => compileArchitecture(intent(['static-web']), catalog),
    error => error instanceof Error
      && error.message.includes('blocked-provider')
      && error.message.includes('dab'),
  );
});

test('deduplicates shared resources with stable attribution without losing distinct resources', () => {
  const shared = {
    type: 'Microsoft.Example/shared',
    sku: 'Free',
    purpose: 'Shared purpose',
  };
  const catalog = createReadonlyModuleCatalog([
    descriptor('azure-sql-free', ['sql'], {
      resources: [shared],
    }),
    descriptor('dab', ['data-api'], {
      resources: [shared],
    }),
    descriptor('web-provider', ['static-web'], {
      resources: [
        shared,
        {
          type: 'Microsoft.Example/shared',
          sku: 'Free',
          purpose: 'Distinct purpose',
        },
      ],
    }),
  ]);

  const plan = compileArchitecture(intent(['static-web']), catalog);

  assert.deepEqual(plan.resources, [
    {
      type: 'Microsoft.Example/shared',
      sku: 'Free',
      purpose: 'Distinct purpose',
      module: 'web-provider',
    },
    {
      type: 'Microsoft.Example/shared',
      sku: 'Free',
      purpose: 'Shared purpose',
      module: 'azure-sql-free',
    },
  ]);
});
