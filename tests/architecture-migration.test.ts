import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type ArchitectureIntent } from '../src/architecture-contract.js';
import { compileArchitecture } from '../src/architecture-compiler.js';

const authenticatedIntent: ArchitectureIntent = {
  version: 1,
  briefFingerprint: 'a'.repeat(64),
  capabilities: ['static-web', 'application-api', 'entra-auth'],
  guarantees: ['authenticated-users', 'private-data-path'],
  optimization: 'simplest-validated-start',
  growth: ['add-operational-observability'],
};

test('legacy role-based deployment configuration is not architecture intent', async () => {
  const legacyConfiguration = JSON.parse(
    await readFile('azure-role-based.example.json', 'utf8'),
  );

  assert.throws(
    () => compileArchitecture(legacyConfiguration),
    (error: unknown) => {
      assert.ok(
        typeof error === 'object' &&
          error !== null &&
          'issues' in error &&
          Array.isArray(error.issues),
      );
      assert.ok(
        error.issues.some(
          issue =>
            typeof issue === 'object' &&
            issue !== null &&
            'code' in issue &&
            issue.code === 'unrecognized_keys',
        ),
      );
      return true;
    },
  );
});

test('authenticated architecture intent compiles only the free SQL SKU', () => {
  const plan = compileArchitecture(authenticatedIntent);

  assert.ok(plan.modules.includes('azure-sql-free'));
  assert.ok(plan.guarantees.includes('no-paid-sql-fallback'));

  const sqlResources = plan.resources.filter(
    resource => resource.type === 'Microsoft.Sql/servers/databases',
  );
  assert.ok(
    sqlResources.some(resource => resource.sku === 'GP_S_Gen5_2'),
    'compiled plan must include the free Azure SQL database SKU',
  );
  assert.ok(
    sqlResources.every(resource => resource.sku === 'GP_S_Gen5_2'),
    'compiled plan must not include a SQL database with a different SKU',
  );
});

test('deployment reference defines the architecture compiler migration boundary', async () => {
  const reference = await readFile('docs/reference/deployment.md', 'utf8');

  assert.match(reference, /architecture-plan/);
  assert.match(reference, /does not convert an existing database/i);
  assert.match(reference, /legacy paid deployment/i);
  assert.match(reference, /not deployment approval/i);
});

test('demo deployment reference defines the architecture compiler migration boundary', async () => {
  const reference = await readFile('docs/reference/demo-deployment.md', 'utf8');

  assert.match(reference, /architecture-plan/);
  assert.match(reference, /does not convert an existing database/i);
  assert.match(reference, /legacy paid deployment/i);
  assert.match(reference, /not deployment approval/i);
});
