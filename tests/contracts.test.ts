import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('starter deployment names use sqlapps for generated URL prefixes', async () => {
  const config = JSON.parse(await readFile('sql-apps.example.json', 'utf8'));
  assert.equal(config.name, 'sqlapps');
  assert.equal(config.profile, 'role-based-data');
  assert.equal(config.readinessPath, '/api/AppReady');
  assert.notEqual(config.location, 'eastus');
  assert.equal('functionsImage' in config, false);
  const template = await readFile('infra/main.bicep', 'utf8');
  assert.match(template, /param name string = 'sqlapps'/);
  assert.ok(template.includes("var prefix = '${name}-${environment}'"));
  assert.ok(template.includes("output gatewayName string = '${prefix}-gateway'"));
  assert.doesNotMatch(template, /Microsoft\.Web\/sites|Microsoft\.Storage|Microsoft\.KeyVault/);
});

test('DAB starter exposes only the AppUser readiness procedure with AzureAD auth', async () => {
  const config = JSON.parse(await readFile('dab/dab-config.json', 'utf8'));
  assert.equal(config['data-source']['connection-string'], "@env('SQL_CONNECTION_STRING')");
  assert.equal(config['data-source'].options['set-session-context'], true);
  assert.equal(config.runtime.host.authentication.provider, 'AzureAD');
  assert.equal(config.runtime.mcp.enabled, false);
  assert.equal(config.runtime.pagination['next-link-relative'], true);
  assert.deepEqual(Object.keys(config.entities), ['AppReady']);
  assert.deepEqual(config.entities.AppReady.source, { object: 'dbo.AppReady', type: 'stored-procedure' });
  assert.deepEqual(config.entities.AppReady.permissions, [{ role: 'AppUser', actions: ['execute'] }]);
});

test('SQL runtime grants require the generated procedure grants and bind DAB by SID', async () => {
  const procedure = await readFile('sql/procedures/AppReady.sql', 'utf8');
  assert.match(procedure, /CREATE PROCEDURE dbo\.AppReady/);
  const grants = await readFile('sql/grant-runtime.sql', 'utf8');
  assert.match(grants, /DATABASE_PRINCIPAL_ID\(N'sql_apps_dab'\)/);
  assert.match(grants, /CREATE USER \[sql_apps_dab\] WITH SID/);
  assert.match(grants, /THROW 50003/);
  assert.doesNotMatch(grants, /db_datareader|db_datawriter|db_owner/);
  const project = await readFile('sql/database.sqlproj', 'utf8');
  assert.ok(project.includes('<Name>SqlApps</Name>'));
  assert.ok(project.includes('<SqlCmdVariable Include="RoleBasedProcedureGrants">'));
});