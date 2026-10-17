import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { checkSelectedApplication } from '../../../dist/src/application-build.js';
import { querySelectedLocal } from '../../../dist/src/selected-local.js';
import { runtimeFor } from '../../../dist/src/workspace.mjs';
import { run } from '../../../dist/src/process.js';

if (process.argv.length !== 3) throw new Error('Usage: node examples\\todo\\demo\\smoke.mjs <local-simulation artifact directory>');
const manifest = await checkSelectedApplication(process.cwd(), resolve(process.argv[2]), 'local-simulation');
if (manifest.name !== 'todo') throw new Error('This opt-in acceptance suite requires the selected Todo reference');
const runtime = runtimeFor();
const hashes = [];
const expired = [];
const admin = sql => querySelectedLocal(runtime, manifest.name, sql, run, true);
const request = async (path, method = 'GET', body, cookie) => {
  const response = await fetch(`${runtime.origins.app}${path}`, {
    method, headers: { origin: runtime.origins.app, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
const start = async () => {
  const before = Date.now();
  const response = await request('/api/session', 'POST', { synthetic: true });
  assert.equal(response.status, 201);
  assert.ok(response.cookie);
  const hash = createHash('sha256').update(response.cookie.split('=')[1]).digest('hex');
  hashes.push(hash);
  const duration = Date.parse(response.body.expiresAt) - before;
  assert.ok(duration >= 3599000 && duration <= 3605000, 'New session must expire in 60 minutes');
  return { cookie: response.cookie, hash };
};
const dab = async (name, body) => {
  const response = await fetch(`${runtime.origins.data}/api/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  assert.ok(response.ok, `Selected procedure ${name} failed (${response.status})`);
  const envelope = await response.json();
  assert.ok(Array.isArray(envelope.value));
  return envelope.value;
};
const reset = hash => admin(`UPDATE dbo.DemoSessions SET window_start=DATEADD(SECOND,-61,SYSUTCDATETIME()),mutation_count=0 WHERE token_hash='${hash}';`);
let failure;
try {
  assert.equal((await request('/health/ready')).status, 200);
  const globalLimits = await admin(`
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;
BEGIN TRY
    DELETE FROM dbo.DemoSessions;
    ;WITH numbers AS (
        SELECT 1 AS value
        UNION ALL
        SELECT value + 1 FROM numbers WHERE value < 1000
    )
    INSERT dbo.DemoSessions(token_hash, expires_at, window_start)
    SELECT CONVERT(varchar(64), HASHBYTES('SHA2_256', CONVERT(varchar(11), value)), 2),
           DATEADD(MINUTE, 60, SYSUTCDATETIME()), SYSUTCDATETIME()
    FROM numbers
    OPTION (MAXRECURSION 1000);
    DECLARE @capacity TABLE(outcome nvarchar(32), expires_at datetime2(3));
    INSERT @capacity EXEC dbo.DemoCreateSession
        @token_hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    SELECT CONCAT(N'session|', outcome) FROM @capacity;

    DELETE FROM dbo.DemoSessions;
    DECLARE @hash char(64) = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    INSERT dbo.DemoSessions(token_hash, expires_at, window_start)
    VALUES (@hash, DATEADD(MINUTE, 60, SYSUTCDATETIME()), SYSUTCDATETIME());
    UPDATE dbo.DemoLimits
    SET global_window_start = SYSUTCDATETIME(), global_mutation_count = 300
    WHERE id = 1;
    DECLARE @mutation TABLE(outcome nvarchar(32), id uniqueidentifier, title nvarchar(200), completed bit);
    INSERT @mutation EXEC dbo.DemoTodoMutate
        @action = N'create', @token_hash = @hash, @title = N'global limit acceptance';
    SELECT CONCAT(N'mutation|', outcome) FROM @mutation;
    ROLLBACK TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
`);
  assert.ok(globalLimits.split(/\r?\n/).includes('session|capacity'));
  assert.ok(globalLimits.split(/\r?\n/).includes('mutation|rate_limited'));
  const live = await request('/application/manifest');
  assert.equal(live.body.name, manifest.name);
  assert.deepEqual(live.body.routes, manifest.routes);
  const a = await start();
  const b = await start();
  const created = await request('/api/todos', 'POST', { title: '<script>synthetic text only</script>' }, a.cookie);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.deepEqual((await request('/api/todos', 'GET', undefined, b.cookie)).body, { items: [] });
  assert.equal((await request(`/api/todos/${id}`, 'PATCH', { completed: true }, b.cookie)).status, 404);
  assert.equal((await request(`/api/todos/${id}`, 'DELETE', undefined, b.cookie)).status, 404);
  assert.equal((await request(`/api/todos/${id}`, 'PATCH', { completed: true }, a.cookie)).body.completed, true);
  assert.equal((await request('/api/todos', 'POST', { title: 'x'.repeat(200) }, a.cookie)).status, 201);
  assert.equal((await request('/api/todos', 'POST', { title: 'x'.repeat(201) }, a.cookie)).status, 400);
  const unicodeTitle = String.fromCodePoint(0x1F33F).repeat(100);
  assert.equal(unicodeTitle.length, 200);
  const unicodeCreated = await request('/api/todos', 'POST', { title: unicodeTitle }, a.cookie);
  assert.equal(unicodeCreated.status, 201);
  assert.equal(unicodeCreated.body.title, unicodeTitle);
  assert.equal((await request('/api/todos', 'POST', { title: unicodeTitle + 'x' }, a.cookie)).status, 400);
  assert.equal((await request(`/api/todos/${id}`, 'PATCH', { title: unicodeTitle + 'x' }, a.cookie)).status, 400);
  const unicodeUpdated = await request(`/api/todos/${id}`, 'PATCH', { title: unicodeTitle }, a.cookie);
  assert.equal(unicodeUpdated.status, 200);
  assert.equal(unicodeUpdated.body.title, unicodeTitle);
  assert.equal((await request('/api/todos', 'POST', { title: 'synthetic', owner_oid: randomUUID() }, a.cookie)).status, 400);
  const q = await start();
  for (let index = 0; index < 49; index++) {
    if (index === 30) await reset(q.hash);
    assert.equal((await dab('Create', { token_hash: q.hash, title: `Synthetic quota ${index}` }))[0].outcome, 'ok');
  }
  await reset(q.hash);
  const quota = await Promise.all(Array.from({ length: 20 }, (_, index) => dab('Create', { token_hash: q.hash, title: `Concurrent synthetic ${index}` })));
  assert.equal(quota.filter(rows => rows[0].outcome === 'ok').length, 1);
  assert.equal(quota.filter(rows => rows[0].outcome === 'quota').length, 19);
  assert.equal((await request('/api/todos', 'GET', undefined, q.cookie)).body.items.length, 50);
  assert.equal((await request('/api/todos', 'POST', { title: 'Synthetic 51' }, q.cookie)).status, 409);
  const rate = await start();
  const attempts = await Promise.all(Array.from({ length: 31 }, (_, index) => request('/api/todos', 'POST', { title: `Synthetic rate ${index}` }, rate.cookie)));
  assert.equal(attempts.filter(result => result.status === 201).length, 30);
  assert.equal(attempts.filter(result => result.status === 429).length, 1);
  await reset(rate.hash);
  assert.equal((await request('/api/todos', 'POST', { title: 'Synthetic new window' }, rate.cookie)).status, 201);
  const expiring = await start();
  assert.equal((await request('/api/todos', 'POST', { title: 'Synthetic expiring' }, expiring.cookie)).status, 201);
  await admin(`UPDATE dbo.DemoSessions SET expires_at=DATEADD(SECOND,-1,SYSUTCDATETIME()) WHERE token_hash='${expiring.hash}';`);
  assert.equal((await request('/api/todos', 'GET', undefined, expiring.cookie)).status, 401);
  assert.equal((await dab('List', { token_hash: expiring.hash }))[0].outcome, 'expired');
  expired.push(...Array.from({ length: 35 }, () => randomBytes(32).toString('hex')));
  await admin(`INSERT dbo.DemoSessions(token_hash,expires_at,window_start) VALUES ${
    expired.map(hash => `('${hash}',DATEADD(MINUTE,-1,SYSUTCDATETIME()),SYSUTCDATETIME())`).join(',\n')
  };`);
  const expiredCount = async () => Number((await admin('SET NOCOUNT ON; SELECT COUNT(*) FROM dbo.DemoSessions WHERE expires_at<=SYSUTCDATETIME();')).trim());
  const beforeCleanup = await expiredCount();
  await dab('GetSession', { token_hash: randomBytes(32).toString('hex') });
  assert.equal(beforeCleanup - await expiredCount(), 32, 'One request must clean exactly 32 of at least 35 expired sessions');
  const permissions = await querySelectedLocal(runtime, manifest.name, `
SET NOCOUNT ON;
IF HAS_PERMS_BY_NAME('dbo.Todos','OBJECT','SELECT') <> 0 THROW 51010,'Table read permission leaked.',1;
IF HAS_PERMS_BY_NAME('dbo.Todos','OBJECT','INSERT') <> 0 THROW 51010,'Table write permission leaked.',1;
IF HAS_PERMS_BY_NAME('dbo.DemoTodoMutate','OBJECT','EXECUTE') <> 0 THROW 51010,'Internal helper permission leaked.',1;
EXEC sys.sp_set_session_context @key=N'oid',@value=N'${a.hash}';
EXEC dbo.DemoTodoList @token_hash='${b.hash}';
SELECT N'PROCEDURE OWNERSHIP AND PERMISSIONS PASSED';
`, run);
  assert.ok(permissions.includes('PROCEDURE OWNERSHIP AND PERMISSIONS PASSED'));
  assert.ok(!permissions.includes(id));
  assert.equal((await request('/api/session', 'DELETE', undefined, a.cookie)).status, 204);
  assert.equal((await admin(`SET NOCOUNT ON; SELECT COUNT(*) FROM dbo.Todos WHERE owner_session_hash='${a.hash}';`)).trim(), '0');
} catch (error) {
  failure = error;
  throw error;
} finally {
  const owned = [...hashes, ...expired];
  if (owned.length) {
    try {
      await admin(`DELETE dbo.DemoSessions WHERE token_hash IN (${owned.map(hash => `'${hash}'`).join(',')});`);
      assert.equal((await admin(`SET NOCOUNT ON; SELECT COUNT(*) FROM dbo.DemoSessions WHERE token_hash IN (${owned.map(hash => `'${hash}'`).join(',')});`)).trim(), '0');
    } catch (cleanup) {
      throw new AggregateError([...(failure ? [failure] : []), cleanup], 'Selected acceptance failed to remove its own synthetic sessions');
    }
  }
}
console.log(`SELECTED TODO SQL/GATEWAY ACCEPTANCE PASSED (workspace ${runtime.id}); exact limits, ownership, expiry, permissions and scoped cleanup.`);
