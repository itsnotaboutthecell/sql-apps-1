import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerClient, type BlobDeleteOptions } from '@azure/storage-blob';
import { deleteLocalJobSnapshot, withJobSnapshotLease } from '../src/local-job-snapshots.js';
import type { FileJob } from '../src/file-jobs.js';

function fixture(t: TestContext) {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oid = '22222222-2222-4222-8222-222222222222';
  const id = '11111111-1111-4111-8111-111111111111';
  let row: FileJob | undefined = {
    id, filename: 'sample.txt', status: 'failed', sha256: null, byte_count: null,
    line_count: null, error: 'recovery timeout',
  };
  const files = new ContainerClient('https://storage.invalid/files');
  const blob = files.getBlockBlobClient(`${tenant}/${oid}/jobs/${id}`);
  let held: string | undefined;
  let exists = true;
  let deleteFailure: Error | undefined;
  let renewalFailure: Error | undefined;
  const calls: string[] = [];
  const missing = Object.assign(new Error('Snapshot absent'), { code: 'BlobNotFound', statusCode: 404 });
  t.mock.method(files, 'getBlockBlobClient', (key: string) => {
    assert.equal(key, `${tenant}/${oid}/jobs/${id}`);
    return blob;
  });
  const getLease = blob.getBlobLeaseClient.bind(blob);
  t.mock.method(blob, 'getBlobLeaseClient', () => {
    const lease = getLease();
    t.mock.method(lease, 'acquireLease', async (duration: number) => {
      assert.equal(duration, 60);
      if (!exists) throw missing;
      if (held) throw Object.assign(new Error('Worker owns snapshot'), { code: 'LeaseAlreadyPresent', statusCode: 409 });
      held = lease.leaseId;
      calls.push('acquire');
      return { leaseId: held };
    });
    t.mock.method(lease, 'renewLease', async () => {
      if (renewalFailure) throw renewalFailure;
      assert.equal(held, lease.leaseId);
      calls.push('renew');
      return { leaseId: held };
    });
    t.mock.method(lease, 'releaseLease', async () => {
      calls.push('release');
      if (!exists) throw missing;
      assert.equal(held, lease.leaseId);
      held = undefined;
      return {};
    });
    return lease;
  });
  t.mock.method(blob, 'deleteIfExists', async (options?: BlobDeleteOptions) => {
    assert.equal(options?.conditions?.leaseId, held);
    if (deleteFailure) throw deleteFailure;
    calls.push('blob-delete');
    exists = false;
    held = undefined;
    return { succeeded: true };
  });
  const jobs = {
    get: async (owner: string, job: string) => {
      assert.equal(owner, oid); assert.equal(job, id);
      return row;
    },
    delete: async () => { calls.push('sql-delete'); row = undefined; },
  };
  return {
    files, blob, jobs, calls,
    remove: () => deleteLocalJobSnapshot(jobs, files, tenant, oid, id),
    snapshotExists: () => exists,
    setDeleteFailure: (error?: Error) => { deleteFailure = error; },
    setRenewalFailure: (error?: Error) => { renewalFailure = error; },
    row: () => row,
    held: () => held,
  };
}

test('a timed-out worker retains exclusive snapshot protection until it finishes', async t => {
  const state = fixture(t);
  await withJobSnapshotLease(state.blob, async () => {
    await assert.rejects(state.remove(), { statusCode: 409 });
    assert.ok(state.row());
    assert.equal(state.snapshotExists(), true);
    assert.equal(state.calls.includes('sql-delete'), false);
  });
  assert.equal(state.held(), undefined);
  assert.equal(await state.remove(), true);
  assert.deepEqual(state.calls, ['acquire', 'release', 'acquire', 'sql-delete', 'blob-delete', 'release']);
});

test('a live worker renews its finite snapshot lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture(t);
  let finish!: () => void;
  const work = withJobSnapshotLease(state.blob, () => new Promise<void>(resolve => { finish = resolve; }));
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.deepEqual(state.calls, ['acquire', 'renew']);
  finish();
  await work;
  assert.deepEqual(state.calls, ['acquire', 'renew', 'release']);
});

test('lease renewal failure aborts protected work before exclusivity expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture(t);
  const failure = new Error('Lease renewal failed');
  state.setRenewalFailure(failure);
  const work = withJobSnapshotLease(state.blob, async (signal?: AbortSignal) => {
    assert.ok(signal, 'protected work receives a lease-loss signal');
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await assert.rejects(work, error => error === failure);
  assert.equal(state.held(), undefined);
});

test('snapshot lease releases after a worker error and preserves its error', async t => {
  const state = fixture(t);
  const failure = new Error('Worker failed');
  await assert.rejects(withJobSnapshotLease(state.blob, async () => { throw failure; }), error => error === failure);
  assert.equal(state.held(), undefined);
  assert.equal(await state.remove(), true);
});

test('SQL deletion failure releases the lease without deleting the snapshot', async t => {
  const state = fixture(t);
  const failure = new Error('SQL unavailable');
  t.mock.method(state.jobs, 'delete', async () => { throw failure; });
  await assert.rejects(state.remove(), error => error === failure);
  assert.ok(state.row());
  assert.equal(state.snapshotExists(), true);
  assert.equal(state.held(), undefined);
});

test('failed leased snapshot cleanup remains retryable after SQL row removal', async t => {
  const state = fixture(t);
  const failure = new Error('Storage unavailable');
  state.setDeleteFailure(failure);
  await assert.rejects(state.remove(), error => error === failure);
  assert.equal(state.row(), undefined);
  assert.equal(state.snapshotExists(), true);
  assert.equal(state.held(), undefined);
  state.setDeleteFailure();
  assert.equal(await state.remove(), false);
  assert.equal(state.snapshotExists(), false);
  assert.equal(await state.remove(), false);
});
