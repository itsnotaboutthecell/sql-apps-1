import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('personal-free publishing is a first-class command separate from legacy Azure deployment', async () => {
  const source = await readFile('packages/sql-apps/bin/sql-apps.mjs', 'utf8');
  assert.match(source, /publish:\s*'dist\/src\/personal-free-cli\.js'/);
  assert.match(source, /azure:\s*'dist\/src\/cli\.js'/);
});

test('cloud guidance names the free personal target and its limits', async () => {
  const skill = await readFile('plugins/sql-apps/skills/sql-apps-cloud-preview/SKILL.md', 'utf8');
  assert.match(skill, /primary[\s\S]*Static Web Apps Free/i);
  assert.match(skill, /personal project/i);
  assert.match(skill, /no SLA/i);
  assert.match(skill, /potentially \$0/i);
  assert.match(skill, /legacy[\s\S]*Container Apps[\s\S]*DAB/i);
});
