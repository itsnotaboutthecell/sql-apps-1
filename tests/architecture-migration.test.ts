import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  architectureIntentSchema,
  type ArchitectureIntent,
} from '../src/architecture-contract.js';
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

  const result = architectureIntentSchema.safeParse(legacyConfiguration);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some(issue => issue.code === 'unrecognized_keys'));
  }
});

test('authenticated architecture intent always keeps free SQL and excludes paid SQL modules', () => {
  const plan = compileArchitecture(authenticatedIntent);

  assert.ok(plan.modules.includes('azure-sql-free'));
  assert.ok(plan.modules.every(moduleId => !/paid-sql/i.test(moduleId)));
});

test('deployment references define the architecture compiler migration boundary', async () => {
  const references = (
    await Promise.all([
      readFile('docs/reference/deployment.md', 'utf8'),
      readFile('docs/reference/demo-deployment.md', 'utf8'),
    ])
  ).join('\n');

  assert.match(references, /architecture-plan/);
  assert.match(references, /does not convert an existing database/i);
  assert.match(references, /not deployment approval/i);
});
