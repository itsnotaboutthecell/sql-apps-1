import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileJobSchema } from '../src/file-jobs.js';

test('file job responses enforce the SQL filename limit in UTF-16 units', () => {
  const row = { id: '11111111-1111-4111-8111-111111111111', filename: '',
    status: 'queued', sha256: null, byte_count: null, line_count: null, error: null };
  for (const filename of ['x'.repeat(128), String.fromCodePoint(0x1F33F).repeat(64)]) {
    assert.equal(fileJobSchema.parse({ ...row, filename }).filename, filename);
    assert.equal(fileJobSchema.safeParse({ ...row, filename: filename + 'x' }).success, false);
  }
});

test('starter deployment names use sqlapps for generated URL prefixes', async () => {
  const config = JSON.parse(await readFile('sql-apps.example.json', 'utf8'));
  assert.equal(config.name, 'sqlapps');
  assert.equal(config.profile, 'role-based-data');
  assert.notEqual(config.location, 'eastus');
  assert.equal(config.functionsImage, '');
  const template = await readFile('infra/main.bicep', 'utf8');
  assert.match(template, /param name string = 'sqlapps'/);
  assert.ok(template.includes("var prefix = '${name}-${environment}'"));
  assert.ok(template.includes("output gatewayName string = '${prefix}-gateway'"));
  assert.ok(template.includes("var functionName = '${prefix}-fn-${suffix}'"));
});

test('DAB requires AzureAD, authenticated permissions, ownership and immutable owner fields', async () => {
  const config = JSON.parse(await readFile('dab/dab-config.json', 'utf8'));
  assert.equal(config['data-source']['connection-string'], "@env('SQL_CONNECTION_STRING')");
  assert.equal(config['data-source'].options['set-session-context'], true);
  assert.equal(config.runtime.host.authentication.provider, 'AzureAD');
  assert.equal(config.runtime.mcp.enabled, false);
  assert.equal(config.runtime.pagination['next-link-relative'], true);
  assert.deepEqual(config.entities.FileJob.graphql, { enabled: true });
  for (const permission of config.entities.FileJob.permissions) {
    assert.equal(permission.role, 'authenticated');
    for (const action of permission.actions) {
      if (action.action === 'create' || action.action === 'update') assert.equal(action.fields.include.includes('owner_oid'), false);
      if (action.action === 'read' || action.action === 'delete') assert.equal(action.policy.database, '@item.owner_oid eq @claims.oid');
      if (action.action === 'update') assert.equal(action.policy, undefined);
    }
  }
});
test('SQL enforces ownership on reads and writes independently of HTTP input', async () => {
  const sql = await readFile('sql/migrations/002-file-jobs.sql', 'utf8');
  assert.match(sql, /DEFAULT CONVERT\(nvarchar\(36\), SESSION_CONTEXT\(N'oid'\)\)/);
  assert.match(sql, /ADD FILTER PREDICATE/);
  assert.match(sql, /AFTER INSERT/);
  assert.match(sql, /AFTER UPDATE/);
  const grants = await readFile('sql/grant-runtime.sql', 'utf8');
  assert.match(grants, /GRANT VIEW DEFINITION ON dbo\.FileJobs TO \[sql_apps_dab\]/);
  assert.match(grants, /GRANT SELECT ON dbo\.FileJobs TO \[sql_apps_dab\]/);
  assert.match(grants, /DATABASE_PRINCIPAL_ID\(N'sql_apps_dab'\)/);
  assert.match(grants, /CREATE USER \[sql_apps_dab\] WITH SID/);
  assert.ok((await readFile('sql/database.sqlproj', 'utf8')).includes('<Name>SqlApps</Name>'));
});
