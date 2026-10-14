import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProcedureRuntime, type SqlRuntimeDriver } from '../src/sql-procedure-runtime.js';

const env = {
  AZURE_SQL_SERVER: 'personal.database.windows.net',
  AZURE_SQL_DATABASE: 'app',
  AZURE_SQL_USER: 'sql_apps_runtime',
  AZURE_SQL_PASSWORD: 'test-only-not-a-real-password-123456',
};

test('SQL session context satisfies and clears the shipped owner predicate contract', async () => {
  const [runtime, predicate] = await Promise.all([
    readFile('src/sql-procedure-runtime.ts', 'utf8'),
    readFile('sql/security/owner.sql', 'utf8'),
  ]);
  assert.match(predicate, /access_as_user/);
  assert.match(predicate, /SESSION_CONTEXT\(N'scp'\)/);
  assert.match(runtime, /@key=N'scp', @value=N'access_as_user'/);
  assert.match(runtime, /@key=N'scp', @value=NULL/);
});

test('SQL runtime retries a paused free database with exponential delays and a fresh pool', async () => {
  const delays: number[] = [];
  let connects = 0;
  const driver: SqlRuntimeDriver = {
    async connect(config) {
      connects++;
      assert.equal(config.options.encrypt, true);
      assert.equal(config.options.trustServerCertificate, false);
      assert.equal(config.pool.max, 5);
      if (connects < 3) throw Object.assign(new Error('paused'), { number: 40613 });
      return { async execute() { return []; }, async close() {} };
    },
  };
  const runtime = createProcedureRuntime(env, [{ name: 'AppReady', parameters: {} }], {
    driver, sleep: async milliseconds => { delays.push(milliseconds); },
  });
  assert.deepEqual(await runtime.execute('11111111-1111-5111-8111-111111111111', 'AppReady', {}), []);
  assert.equal(connects, 3);
  assert.deepEqual(delays, [5_000, 10_000]);
});

test('SQL runtime rejects undeclared procedures and does not retry credentials', async () => {
  let connects = 0;
  const runtime = createProcedureRuntime(env, [{ name: 'AppReady', parameters: {} }], {
    driver: {
      async connect() {
        connects++;
        throw Object.assign(new Error('login failed'), { number: 18456 });
      },
    },
    sleep: async () => { throw new Error('must not sleep'); },
  });
  await assert.rejects(runtime.execute('11111111-1111-5111-8111-111111111111', 'Unknown', {}), /declared/);
  assert.equal(connects, 0);
  await assert.rejects(runtime.execute('11111111-1111-5111-8111-111111111111', 'AppReady', {}), /login failed/);
  assert.equal(connects, 1);
});

test('SQL runtime requires exact declared parameters', async () => {
  let called = false;
  const runtime = createProcedureRuntime(env, [{
    name: 'UpdateItem', parameters: { id: 'uniqueidentifier', completed: 'bit' },
  }], {
    driver: {
      async connect() {
        return {
          async execute(ownerId, procedure, values, definition) {
            called = true;
            assert.equal(ownerId, '11111111-1111-5111-8111-111111111111');
            assert.equal(procedure, 'UpdateItem');
            assert.deepEqual(values, { id: '22222222-2222-5222-8222-222222222222', completed: true });
            assert.deepEqual(definition.parameters, { id: 'uniqueidentifier', completed: 'bit' });
            return [{ outcome: 'ok' }];
          },
          async close() {},
        };
      },
    },
    sleep: async () => {},
  });
  await assert.rejects(runtime.execute('11111111-1111-5111-8111-111111111111', 'UpdateItem', { id: 'x' }), /parameters/);
  assert.equal(called, false);
  assert.deepEqual(await runtime.execute('11111111-1111-5111-8111-111111111111', 'UpdateItem', {
    id: '22222222-2222-5222-8222-222222222222', completed: true,
  }), [{ outcome: 'ok' }]);
});
