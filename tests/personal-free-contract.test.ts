import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('personal-free publishing is the only bundled Azure deployment command', async () => {
  const source = await readFile('packages/sql-apps/bin/sql-apps.mjs', 'utf8');
  assert.match(source, /publish:\s*'dist\/src\/personal-free-cli\.js'/);
  assert.doesNotMatch(source, /azure:\s*'dist\/src\/cli\.js'/);
});

test('cloud guidance names the free personal target and its limits', async () => {
  const skill = await readFile('plugins/sql-apps/skills/sql-apps-cloud-preview/SKILL.md', 'utf8');
  assert.match(skill, /primary[\s\S]*Static Web Apps Free/i);
  assert.match(skill, /personal project/i);
  assert.match(skill, /no .*SLA/i);
  assert.match(skill, /potentially \$0/i);
  assert.match(skill, /cost guard/i);
  assert.match(skill, /stop rather than bill/i);
  assert.doesNotMatch(skill, /legacy|Container Apps|compatibility path/i);
});

test('cost guidance distinguishes the zero-cost profile from almost-free architectures', async () => {
  const costs = await readFile('docs/guides/costs.md', 'utf8');
  assert.match(costs, /Service Bus Basic[\s\S]*billable/i);
  assert.match(costs, /managed Functions/i);
  assert.match(costs, /App Service/i);
  assert.match(costs, /no\s+always-billable Azure service/i);
  assert.match(costs, /quota exhaustion[\s\S]*interrupt/i);
  assert.match(costs, /GitHub Actions[\s\S]*outside/i);

  const deployment = await readFile('docs/reference/personal-free-deployment.md', 'utf8');
  assert.match(deployment, /Cost guard: verified/);
  assert.match(deployment, /stop rather than bill/i);
  assert.match(deployment, /manual.*upgrade|upgraded manually/i);
});

test('tooling ships no legacy cloud infrastructure or deployment implementation', async () => {
  for (const path of [
    'src/cli.ts',
    'src/azure-init.ts',
    'src/deployment.ts',
    'src/artifacts.ts',
    'src/role-based-identity.ts',
    'src/role-based-smoke.ts',
    'infra/main.bicep',
    'infra/rbac.bicep',
    'infra/private-endpoint.bicep',
    '.github/workflows/azure-native-deploy.yml',
  ]) {
    await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
  }
});
