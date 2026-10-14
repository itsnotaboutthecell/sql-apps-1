import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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