import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { GenericContainer, Wait } from 'testcontainers';

const image = 'sqldbpreview-dpgaeqhmgphzd4bk.azurecr.io/azure-sql/db-dev:latest';
const password = 'SqlApps1!Concurrency_Test_2026';
const sqlcmd = '/opt/mssql-tools18/bin/sqlcmd';
let container;

async function query(database, statement) {
  const result = await container.exec([
    sqlcmd, '-S', 'localhost', '-U', 'sa', '-P', password, '-C', '-b',
    '-d', database, '-h', '-1', '-W', '-Q', statement,
  ]);
  assert.equal(result.exitCode, 0, result.output);
  return result.output.trim();
}

async function outcome(statement) {
  return (await query('appdb', `SET NOCOUNT ON; ${statement}`)).split(/\s+/)[0];
}

before(async () => {
  container = await new GenericContainer(image)
    .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: password })
    .withExposedPorts(1433)
    .withPlatform('linux/amd64')
    .withWaitStrategy(Wait.forSuccessfulCommand(
      `/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '${password}' -C -b -l 2 -Q 'SELECT 1'`,
    ))
    .withStartupTimeout(120_000)
    .start();
  assert.ok(container.getMappedPort(1433) > 0);
  await query('master', "IF DB_ID('appdb') IS NULL CREATE DATABASE appdb;");
  assert.equal(await query('appdb', "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('EngineEdition') AS int);"), '5');
  for (const file of ['schema.sql', 'procedures.sql', 'post-deploy.sql']) {
    const batches = (await readFile(new URL(`../demo/${file}`, import.meta.url), 'utf8'))
      .split(/^\s*GO\s*$/gim).map(value => value.trim()).filter(Boolean);
    for (const batch of batches) await query('appdb', batch);
  }
});

after(async () => {
  await container?.stop();
});

test('concurrent SQL requests cannot cross session, item, or mutation limits', async () => {
  await query('appdb', `
    SET NOCOUNT ON;
    WITH seed AS (
      SELECT TOP (999) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS value
      FROM sys.all_objects AS first CROSS JOIN sys.all_objects AS second
    )
    INSERT dbo.DemoSessions(token_hash, expires_at, window_start)
    SELECT RIGHT(REPLICATE('0', 64) + CONVERT(varchar(64), value, 2), 64),
      DATEADD(HOUR, 1, SYSUTCDATETIME()), SYSUTCDATETIME()
    FROM seed;
  `);
  const sessions = await Promise.all([
    outcome(`EXEC dbo.DemoCreateSession @token_hash = '${'a'.repeat(64)}';`),
    outcome(`EXEC dbo.DemoCreateSession @token_hash = '${'b'.repeat(64)}';`),
  ]);
  assert.deepEqual(sessions.sort(), ['capacity', 'ok']);
  assert.equal(await query('appdb', 'SET NOCOUNT ON; SELECT COUNT_BIG(*) FROM dbo.DemoSessions;'), '1000');

  const token = '1'.padStart(64, '0');
  await query('appdb', `
    UPDATE dbo.DemoSessions
    SET window_start = SYSUTCDATETIME(), mutation_count = 29
    WHERE token_hash = '${token}';
    UPDATE dbo.DemoLimits SET global_window_start = SYSUTCDATETIME(), global_mutation_count = 0 WHERE id = 1;
  `);
  const createItem = title => outcome(
    `EXEC dbo.DemoTodoCreate @token_hash = '${token}', @title = N'${title}';`,
  );
  const rateLimit = await Promise.all([createItem('Rate one'), createItem('Rate two')]);
  assert.deepEqual(rateLimit.sort(), ['ok', 'rate_limited']);

  await query('appdb', `
    SET NOCOUNT ON;
    DELETE dbo.Todos WHERE owner_session_hash = '${token}';
    WITH seed AS (
      SELECT TOP (49) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS value
      FROM sys.all_objects
    )
    INSERT dbo.Todos(id, owner_session_hash, title)
    SELECT NEWID(), '${token}', CONCAT(N'Seed ', value) FROM seed;
    UPDATE dbo.DemoSessions SET window_start = SYSUTCDATETIME(), mutation_count = 0 WHERE token_hash = '${token}';
    UPDATE dbo.DemoLimits SET global_window_start = SYSUTCDATETIME(), global_mutation_count = 0 WHERE id = 1;
  `);
  const quota = await Promise.all([createItem('Quota one'), createItem('Quota two')]);
  assert.deepEqual(quota.sort(), ['ok', 'quota']);
  assert.equal(await query('appdb',
    `SET NOCOUNT ON; SELECT COUNT_BIG(*) FROM dbo.Todos WHERE owner_session_hash = '${token}';`), '50');
});
