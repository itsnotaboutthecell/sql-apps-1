import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { application } from '../application.js';

test('selected demo DAB is anonymous internal procedure execution only', async () => {
  const config = JSON.parse(await readFile('examples/todo/demo/dab-config.json', 'utf8'));
  assert.equal(config.runtime.host.mode, 'production');
  assert.equal(config.runtime.host.authentication.provider, 'Unauthenticated');
  assert.equal(config.runtime.graphql.enabled, false);
  assert.equal(config.runtime.mcp.enabled, false);
  assert.equal(config['data-source']['connection-string'], "@env('SQL_CONNECTION_STRING')");
  assert.equal(config['data-source'].options['set-session-context'], false);
  assert.deepEqual(Object.keys(config.entities).sort(), [...application.procedures].sort());
  for (const entity of Object.values(config.entities) as { source: { type: string }; rest: { methods: string[] }; permissions: unknown[] }[]) {
    assert.equal(entity.source.type, 'stored-procedure');
    assert.deepEqual(entity.rest.methods, ['post']);
    assert.deepEqual(entity.permissions, [{ role: 'anonymous', actions: ['execute'] }]);
  }
});

test('selected schema owns hashed visitor data separately from authenticated example tables', async () => {
  const schema = await readFile('examples/todo/demo/schema.sql', 'utf8');
  assert.match(schema, /token_hash char\(64\)/i);
  assert.match(schema, /expires_at datetime2/i);
  assert.match(schema, /ON DELETE CASCADE/i);
  assert.match(schema, /DemoLimits/i);
  assert.match(schema, /global_mutation_count/i);
  assert.doesNotMatch(schema, /owner_oid|SESSION_CONTEXT|varchar\(43\)/i);
  const grants = await readFile('examples/todo/demo/grants.sql', 'utf8');
  assert.doesNotMatch(grants, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|CONTROL)|db_owner|db_datareader|db_datawriter/i);
  assert.equal((grants.match(/GRANT EXECUTE ON /g) ?? []).length, application.procedures.length);
  const project = await readFile('examples/todo/demo/database.sqlproj', 'utf8');
  assert.match(project, /SqlAzureV12DatabaseSchemaProvider/);
  assert.doesNotMatch(project, /owner\.sql|FileJobs|Include=.*\.\./);
});

test('public demo SQL enforces the declared limits under update locks', async () => {
  const procedures = await readFile('examples/todo/demo/procedures.sql', 'utf8');
  const limits = application.limits;
  assert.match(procedures, new RegExp(`COUNT_BIG\\(\\*\\)[\\s\\S]*DemoSessions[\\s\\S]*>=\\s*${limits.globalSessionLimit}[\\s\\S]*capacity`, 'i'));
  assert.match(procedures, /DemoLimits\s+WITH\s*\(UPDLOCK,\s*HOLDLOCK\)/i);
  assert.match(procedures, new RegExp(`global_count\\s*>=\\s*${limits.globalMutationsPerMinute}[\\s\\S]*rate_limited`, 'i'));
  assert.match(procedures, new RegExp(`@count\\s*>=\\s*${limits.mutationsPerMinute}\\s*SET @outcome = N'rate_limited'`, 'i'));
  assert.match(procedures, new RegExp(`owner_session_hash = @token_hash\\)\\s*>=\\s*${limits.itemLimit}`, 'i'));
  assert.match(procedures, new RegExp(`DATEADD\\(MINUTE,\\s*${limits.sessionMinutes},\\s*@now\\)`, 'i'));
  assert.match(procedures, new RegExp(`nvarchar\\(${limits.titleLimit}\\)`, 'i'));
  const readiness = procedures.match(/CREATE PROCEDURE dbo\.DemoReadiness([\s\S]*?)\nGO/i)?.[1] ?? '';
  assert.match(readiness, /DemoLimits[\s\S]*id\s*=\s*1/i);
  assert.match(readiness, /THROW\s+51002/i);
});

test('example SQL projects and browser identity stay scoped to the reference', async () => {
  for (const [path, name] of [
    ['examples/todo/database.sqlproj', 'SqlAppsTodoExample'],
    ['examples/todo/demo/database.sqlproj', 'SqlAppsTodoDemo'],
  ]) assert.ok((await readFile(path!, 'utf8')).includes(`<Name>${name}</Name>`));
  assert.match(await readFile('examples/todo/web/index.html', 'utf8'), /<title>SQL Apps - synthetic Todo demo<\/title>/);
});
