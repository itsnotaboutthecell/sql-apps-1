import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeFile } from '../functions/src/file-analysis.js';
import { ensureOwned, serviceNames, stopLocalServices, storageConnection, localServiceReadiness,
  localFunctionsOrigin, localServiceImages } from '../src/local-services.js';
import { deleteLocalJob, localJobData } from '../src/local-job-data.js';
import type { FileJob } from '../src/file-jobs.js';
import { jobMessageSchema } from '../src/file-jobs.js';
import { localDabConfig, localPrincipal } from '../src/local.js';
import { run, type Run } from '../src/process.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { DependencyReadinessError } from '../src/readiness.js';
import { localWorkspaceFixture } from './local-workspace-fixture.js';

const readinessInput = {
  user: { oid: '11111111-1111-4111-8111-111111111111', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  input: { readiness: true },
};

async function readinessStorage(t: TestContext, failure?: 'blob' | 'queue' | 'stall' | 'stalled-blob-and-queue') {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const method = request.method ?? '';
    requests.push({ method, path: url.pathname });
    const dependency = ['/fixturestorage/files', '/fixturestorage/traces'].includes(url.pathname) ? 'blob' : 'queue';
    if (['stall', 'stalled-blob-and-queue'].includes(failure ?? '') && dependency === 'blob') return;
    response.writeHead(failure === dependency || failure === 'stalled-blob-and-queue' ? 503 : 200, {
      'x-ms-request-id': 'fixture-readiness', 'x-ms-version': '2025-11-05',
      'x-ms-approximate-messages-count': '0', etag: '"fixture"',
      'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
    });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((done, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : done());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/fixturestorage`;
  const connection = `DefaultEndpointsProtocol=http;AccountName=fixturestorage;` +
    `AccountKey=${Buffer.alloc(32).toString('base64')};BlobEndpoint=${endpoint};QueueEndpoint=${endpoint};`;
  return { requests, ready: localServiceReadiness(connection, 'synthetic-readiness-secret') };
}

for (const failure of [undefined, 'blob', 'queue', 'functions'] as const) {
  test(`service readiness uses real read-only SDK operations: ${failure ?? 'healthy'}`, async t => {
    const { requests, ready } = await readinessStorage(t, failure === 'functions' ? undefined : failure);
    const signal = AbortSignal.timeout(4_000);
    const check = ready(async (url, options) => {
      assert.equal(String(url), `${localFunctionsOrigin}/api/echo`);
      assert.equal(options?.signal, signal);
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer synthetic-readiness-secret');
      assert.equal(options?.body, JSON.stringify(readinessInput));
      return failure === 'functions' ? new Response(null, { status: 503 }) : Response.json({ result: readinessInput });
    }, signal);
    if (failure) await assert.rejects(check, error =>
      error instanceof DependencyReadinessError && error.dependency === failure);
    else {
      await check;
      assert.equal(requests.length, 4);
      assert.deepEqual(requests.map(request => request.path).sort(), [
        '/fixturestorage/file-jobs', '/fixturestorage/file-jobs-poison', '/fixturestorage/files', '/fixturestorage/traces',
      ]);
    }
    assert.ok(requests.every(request => ['GET', 'HEAD'].includes(request.method)));
    assert.equal(new Set(requests.map(request => `${request.method} ${request.path}`)).size, requests.length,
      'metadata SDK retries must not multiply requests within one readiness attempt');
  });
}

for (const scenario of [
  { name: 'refused connection', response: (): Response => { throw new Error('connection refused'); } },
  { name: 'wrong credential', response: () => new Response(null, { status: 401 }) },
  { name: 'absent function', response: () => new Response(null, { status: 404 }) },
  { name: 'empty success', response: () => new Response(null, { status: 204 }) },
  { name: 'invalid JSON', response: () => new Response('not-json') },
  { name: 'wrong echo', response: () => Response.json({ result: { user: readinessInput.user, input: {} } }) },
]) {
  test(`Functions readiness rejects ${scenario.name}`, async t => {
    const { ready } = await readinessStorage(t);
    await assert.rejects(ready(async () => scenario.response(), AbortSignal.timeout(4_000)),
      error => error instanceof DependencyReadinessError && error.dependency === 'functions');
  });
}

test('stalled Blob metadata requests respect the shared abort deadline', async t => {
  const { ready } = await readinessStorage(t, 'stall');
  const start = performance.now();
  await assert.rejects(ready(async () => Response.json({ result: readinessInput }), AbortSignal.timeout(100)),
    error => error instanceof DependencyReadinessError && error.dependency === 'blob');
  assert.ok(performance.now() - start < 1_100, 'readiness must not wait for the normal storage retry budget');
});

test('readiness reports failures in dependency order instead of completion order', async t => {
  const { ready } = await readinessStorage(t, 'stalled-blob-and-queue');
  await assert.rejects(ready(async () => Response.json({ result: readinessInput }), AbortSignal.timeout(100)),
    error => error instanceof DependencyReadinessError && error.dependency === 'blob');
});

test('local Functions require the SQL Apps development guard and always reject production', async () => {
  for (const env of [
    { NODE_ENV: 'development', SQL_APPS_LOCAL_FUNCTIONS: undefined },
    { NODE_ENV: 'production', SQL_APPS_LOCAL_FUNCTIONS: 'true' },
  ]) {
    await assert.rejects(run(process.execPath, ['dist/functions/src/local-index.js'], { env }),
      /Local Functions entry point requires explicit development mode outside production/);
  }
  await assert.rejects(run(process.execPath, ['dist/functions/src/local-index.js'], {
    env: { NODE_ENV: 'development', SQL_APPS_LOCAL_FUNCTIONS: 'true', LOCAL_FUNCTION_SECRET: undefined,
      AzureWebJobsStorage: undefined, LOCAL_DAB_URL: undefined },
  }), /Local Functions settings are incomplete/);
});

test('local Functions use stable Docker DNS for DAB instead of a disposable container address', async () => {
  const source = await readFile('src/local-services.ts', 'utf8');
  assert.match(source, /LOCAL_DAB_URL:\s*`http:\/\/\$\{names\.data\}:5000`/);
  assert.doesNotMatch(source, /const dataIp\s*=|LOCAL_DAB_URL:\s*`http:\/\/\$\{dataIp\}/);
  const dataSource = await readFile('src/local.ts', 'utf8');
  assert.match(dataSource, /network', 'connect', servicesNetwork, dataContainer/);
  const acceptance = await readFile('src/local-services-smoke.ts', 'utf8');
  assert.match(acceptance, /LOCAL_DAB_URL:\s*`http:\/\/\$\{names\.data\}:5000`/);
});

test('file analysis has exact size, hash and CRLF/LF/CR text-line results', () => {
  for (const [text, count] of [['', 0], ['a', 1], ['a\n', 2], ['a\r\nb\rc\n', 4]] as const) {
    const bytes = Buffer.from(text);
    assert.deepEqual(analyzeFile(bytes), { sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_count: bytes.length, line_count: count });
  }
  assert.equal(analyzeFile(Buffer.alloc(4 * 1024 * 1024)).byte_count, 4 * 1024 * 1024);
  assert.throws(() => analyzeFile(Buffer.alloc(4 * 1024 * 1024 + 1)), /4 MiB/);
});

for (const selection of [undefined, 'legacy', 42000] as const) {
  const mode = selection === undefined ? 'legacy-unselected' : selection === 'legacy' ? 'legacy' : 'isolated';
  test(`local service lifecycle preserves volumes and refuses unowned service names before writes (${mode})`, async t => {
    const runtime = await localWorkspaceFixture(t, selection);
    const names = serviceNames(runtime.defaultSql);
    const images = localServiceImages(runtime.defaultSql);
    assert.ok(typeof images.storage === 'string');
    const calls: string[][] = [];
    let unowned: 'functions' | 'storage' | undefined;
    const runner: Run = async (command, args) => {
      assert.equal(command, 'docker');
      calls.push([...args]);
      const name = [names.functions, names.storage].find(name =>
        args.includes(name) || args.includes(`name=^${name}$`));
      assert.ok(name, 'Only fixture service names may be inspected or modified');
      const role = name === names.functions ? 'functions' : 'storage';
      if (args[0] === 'ps') return name;
      if (args[0] === 'inspect') {
        if (args.includes('{{index .Config.Labels "sql-apps.local"}}')) return role === unowned ? 'not-owned' : role;
        assert.ok(args.some(arg => arg.includes('HostConfig.PortBindings')));
        return JSON.stringify({
          workspace: runtime.id,
          image: role === 'storage' ? images.storage : `${runtime.imageRepository}:${runtime.mode === 'isolated' ? 'a'.repeat(64) : 'local'}`,
          ports: role === 'storage' ? {
            '10000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(runtime.ports.blob) }],
            '10001/tcp': [{ HostIp: '127.0.0.1', HostPort: String(runtime.ports.queue) }],
          } : { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(runtime.ports.functions) }] },
        });
      }
      if (args[0] === 'rm') assert.deepEqual(args, ['rm', '--force', names.functions]);
      else if (args[0] === 'stop') assert.deepEqual(args, ['stop', names.storage]);
      else assert.fail(`Unexpected fixture command: ${args.join(' ')}`);
      return '';
    };
    for (const role of ['functions', 'storage'] as const) {
      unowned = role;
      calls.length = 0;
      await assert.rejects(stopLocalServices(runtime.defaultSql, runner), /not project-owned/);
      assert.equal(calls.some(args => ['rm', 'stop'].includes(args[0]!)), false);
    }
    unowned = undefined;
    calls.length = 0;
    await stopLocalServices(runtime.defaultSql, runner);
    assert.deepEqual(calls.filter(args => ['rm', 'stop'].includes(args[0]!)),
      [['rm', '--force', names.functions], ['stop', names.storage]]);
    assert.equal(calls.some(args => args[0] === 'volume'), false);
    assert.equal(await ensureOwned('service', 'storage', async () => ''), false);
    assert.throws(() => serviceNames('bad;name'), /Invalid/);
    assert.ok(storageConnection('key').includes(`BlobEndpoint=http://127.0.0.1:${runtime.ports.blob}/sqlappslocal;`));
    assert.ok(storageConnection('key').includes(`QueueEndpoint=http://127.0.0.1:${runtime.ports.queue}/sqlappslocal;`));
    assert.ok(storageConnection('key', names.storage).includes(`BlobEndpoint=http://${names.storage}:10000/sqlappslocal;`));
    assert.ok(storageConnection('key', names.storage).includes(`QueueEndpoint=http://${names.storage}:10001/sqlappslocal;`));
  });
}

test('job queue messages reject caller-managed or untrusted identity fields', () => {
  const job = { id: '11111111-1111-4111-8111-111111111111', oid: '22222222-2222-4222-8222-222222222222',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', key: 'snapshot' };
  assert.equal(jobMessageSchema.safeParse(job).success, true);
  assert.equal(jobMessageSchema.safeParse({ ...job, status: 'completed' }).success, false);
  assert.equal(jobMessageSchema.safeParse({ ...job, oid: 'not-a-guid' }).success, false);
});

test('only server processor role can create or mutate local jobs; production exposes no job entity', async () => {
  const config = await localDabConfig() as { entities: { FileJob: { permissions: { role: string; actions: unknown[] }[] } } };
  assert.deepEqual(config.entities.FileJob.permissions.find(p => p.role === 'processor')?.actions, ['create', 'read', 'update', 'delete']);
  const authenticated = config.entities.FileJob.permissions.find(p => p.role === 'authenticated')!;
  assert.equal(authenticated.actions.length, 1);
  assert.equal((authenticated.actions[0] as { action: string }).action, 'read');
  const claims = JSON.parse(Buffer.from(localPrincipal('alice'), 'base64').toString()).claims;
  assert.equal(claims.find((c: { typ: string }) => c.typ === 'roles').val, 'authenticated');
});

test('processor adapter uses explicit trusted role and fails closed on invalid cross-origin pagination', async () => {
  const data = localJobData('http://127.0.0.1:15000', async (_url, options) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('x-ms-api-role'), 'processor');
    const claims = JSON.parse(Buffer.from(headers.get('x-ms-client-principal')!, 'base64').toString()).claims;
    assert.equal(claims.find((c: { typ: string }) => c.typ === 'roles').val, 'processor');
    return Response.json({ value: [], nextLink: 'https://unexpected.invalid/api/FileJob' });
  });
  await assert.rejects(data.list('alice'), /Invalid job pagination/);
  await assert.rejects(localJobData('http://127.0.0.1:15000', async () => new Response('', { status: 503 })).list('alice'), /503/);
});

test('browser job listing returns every active job and only one recent terminal page', async () => {
  const requests: URL[] = [];
  const active = {
    id: '11111111-1111-4111-8111-111111111111', filename: 'active.txt', status: 'processing',
    sha256: null, byte_count: null, line_count: null, error: null,
  };
  const completed = {
    id: '22222222-2222-4222-8222-222222222222', filename: 'done.txt', status: 'completed',
    sha256: 'a'.repeat(64), byte_count: 1, line_count: 1, error: null,
  };
  const older = {
    ...completed, id: '33333333-3333-4333-8333-333333333333', filename: 'older.txt',
  };
  const data = localJobData('http://127.0.0.1:15000', async input => {
    const url = new URL(String(input));
    requests.push(url);
    const filter = url.searchParams.get('$filter');
    if (filter?.includes('queued')) return Response.json({ value: [active] });
    if (filter?.includes('completed')) {
      return Response.json({ value: [completed], nextLink: '/api/FileJob?$after=older-terminal-page' });
    }
    return Response.json({ value: [active, completed, older] });
  });
  assert.deepEqual(await data.list('alice'), [active, completed]);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.searchParams.get('$filter') ?? '', /queued.*processing/);
  assert.match(requests[1]!.searchParams.get('$filter') ?? '', /completed.*failed/);
  assert.equal(requests[1]!.searchParams.get('$first'), '100');
});

test('browser job listing keeps the terminal version when a job completes between queries', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const active = {
    id, filename: 'moving.txt', status: 'processing' as const,
    sha256: null, byte_count: null, line_count: null, error: null,
  };
  const completed = {
    ...active, status: 'completed' as const, sha256: 'a'.repeat(64), byte_count: 1, line_count: 1,
  };
  let request = 0;
  const data = localJobData('http://127.0.0.1:15000', async () =>
    Response.json({ value: [request++ === 0 ? active : completed] }));
  assert.deepEqual(await data.list('alice'), [completed]);
});

const deletionOwner = '22222222-2222-4222-8222-222222222222';
const deletionJob: FileJob = {
  id: '11111111-1111-4111-8111-111111111111', filename: 'sample.txt',
  status: 'failed', sha256: null, byte_count: null, line_count: null, error: 'worker failed',
};

test('failed SQL job deletion preserves the retry snapshot and reports the original error', async () => {
  const failure = new Error('SQL unavailable');
  const snapshot = Buffer.from('original bytes');
  let saved: Buffer | undefined = snapshot;
  await assert.rejects(deleteLocalJob({
    get: async (oid, id) => {
      assert.equal(oid, deletionOwner); assert.equal(id, deletionJob.id);
      return deletionJob;
    },
    delete: async (oid, id) => {
      assert.equal(oid, deletionOwner); assert.equal(id, deletionJob.id);
      throw failure;
    },
  }, deletionOwner, deletionJob.id, async () => { saved = undefined; }), error => error === failure);
  assert.equal(saved, snapshot);
});

for (const status of ['completed', 'failed'] as const) {
  test(`${status} job deletion removes SQL before its snapshot`, async () => {
    const calls: string[] = [];
    const removed = await deleteLocalJob({
      get: async () => ({ ...deletionJob, status }),
      delete: async () => { calls.push('sql'); },
    }, deletionOwner, deletionJob.id, async () => { calls.push('blob'); });
    assert.equal(removed, true);
    assert.deepEqual(calls, ['sql', 'blob']);
  });
}

test('snapshot deletion failure is reported and a repeat deletion cleans the orphan idempotently', async () => {
  let row: FileJob | undefined = deletionJob;
  let snapshotExists = true;
  let deletes = 0;
  let cleanups = 0;
  const failure = new Error('Blob unavailable');
  const jobs = {
    get: async () => row,
    delete: async () => { deletes++; row = undefined; },
  };
  const removeSnapshot = async () => {
    cleanups++;
    if (cleanups === 1) throw failure;
    const removed = snapshotExists;
    snapshotExists = false;
    return removed;
  };
  await assert.rejects(deleteLocalJob(jobs, deletionOwner, deletionJob.id, removeSnapshot), error => error === failure);
  assert.equal(row, undefined);
  assert.equal(snapshotExists, true);
  assert.equal(await deleteLocalJob(jobs, deletionOwner, deletionJob.id, removeSnapshot), false);
  assert.equal(snapshotExists, false);
  assert.equal(await deleteLocalJob(jobs, deletionOwner, deletionJob.id, removeSnapshot), false);
  assert.equal(deletes, 1);
});

for (const status of ['queued', 'processing'] as const) {
  test(`${status} job deletion rejects before modifying SQL or snapshots`, async () => {
    let changed = false;
    await assert.rejects(deleteLocalJob({
      get: async () => ({ ...deletionJob, status }),
      delete: async () => { changed = true; },
    }, deletionOwner, deletionJob.id, async () => { changed = true; }), { statusCode: 409 });
    assert.equal(changed, false);
  });
}
