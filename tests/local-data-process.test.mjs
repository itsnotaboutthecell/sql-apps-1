import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { initializeWorkspace, runtimeFor } from '../src/workspace.mjs';
import { sqlTargetFingerprint } from '../src/sql-target.mjs';
import { saveProtectedJson } from '../dist/src/sql-endpoint.js';

let data;
try { data = await import('../dist/src/local-data-process.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('host DAB ownership requires a matching PID, start identity, target and config', () => {
  assert.equal(typeof data?.verifyHostDataIdentity, 'function');
  const expected = { pid: 42, started: 'start', command: 'dotnet tool run dab -- start --config config.json', fingerprint: 'target-config' };
  data.verifyHostDataIdentity(expected, { pid: 42, started: 'start', command: expected.command }, 'target-config');
  for (const actual of [
    { pid: 42, started: 'different', command: expected.command },
    { pid: 43, started: 'start', command: expected.command },
    { pid: 42, started: 'start', command: 'unrelated process' },
  ]) assert.throws(() => data.verifyHostDataIdentity(expected, actual, 'target-config'), /ownership/);
  assert.throws(() => data.verifyHostDataIdentity(expected, { pid: 42, started: 'start', command: expected.command }, 'other-target'), /ownership/);
});

const target = { version: 1, provider: 'express', instance: 'SQLEXPRESS', server: '127.0.0.1', port: 1433, database: 'development' };
async function fixture(t, platform = process.platform) {
  const cwd = process.cwd();
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-host-dab-')));
  await initializeWorkspace(home, 32000, async () => 'free');
  process.chdir(home);
  const listeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
  t.after(async () => {
    for (const [signal, previous] of listeners) for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.removeListener(signal, listener);
    process.chdir(cwd);
    await rm(home, { recursive: true, force: true });
  });
  const runtime = runtimeFor(), calls = [];
  const runner = async (command, args, options) => { calls.push([command, ...args]); return options?.input ?? ''; };
  await saveProtectedJson(join(runtime.stateDirectory, `endpoint-${sqlTargetFingerprint(target)}.json`),
    { version: 1, home, workspace: runtime.id, fingerprint: sqlTargetFingerprint(target), login: runtime.login, password: `SqlApps1!${'a'.repeat(64)}` }, runner);
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill() { calls.push(['child.kill']); } });
  const actual = { pid: child.pid, command: 'owned fixture dotnet', started: 'fixture-start-time' };
  const deps = {
    platform,
    inspect: async () => actual,
    execute: async (command, args) => { calls.push([command, ...args]); return { stdout: '2.0.12', stderr: '' }; },
    spawn: (command, args, options) => {
      calls.push([command, ...args]);
      assert.equal(options.env.ASPNETCORE_URLS, runtime.origins.data);
      assert.equal(options.detached, platform !== 'win32');
      return child;
    },
    port: async () => 'free', fetch: async url => {
      assert.equal(url, `${runtime.origins.data}/`, 'probe public liveness, not role-protected comprehensive health');
      return new Response('{}');
    }, wait: async () => {},
    kill: pid => { calls.push(['kill', pid]); return true; },
  };
  return { runtime, calls, runner, deps, actual, child, receipt: join(runtime.stateDirectory, 'host-dab.json') };
}

test('host DAB starts once, reuses only matching identity and stops only its exact owned tree/group', async t => {
  const f = await fixture(t);
  await data.startHostData(target, {}, f.runner, f.deps);
  await data.startHostData(target, {}, f.runner, f.deps);
  assert.equal(f.calls.filter(call => call.includes('start')).length, 1);
  assert.equal(f.calls.some(call => call[0] === 'docker'), false);
  await assert.rejects(data.verifyHostData(target, {}, { ...f.deps, inspect: async () => ({ ...f.actual, started: 'reused PID' }) }), /ownership/);
  await assert.rejects(data.stopHostData({ ...target, database: 'another' }, {}, f.deps), /another target/);
  assert.equal(f.calls.some(call => call[0] === 'taskkill.exe' || call[0] === 'kill'), false);
  await data.stopHostData(target, {}, { ...f.deps, fetch: async () => { throw new Error('must not need health to stop'); } });
  assert.ok(f.calls.some(call => call[0] === 'taskkill.exe' && call.includes('12345') || call[0] === 'kill' && call[1] === -12345));
  await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
});

test('host DAB refuses occupied ports, wrong tool versions and unknown probe errors without restore', async t => {
  const f = await fixture(t);
  await assert.rejects(data.startHostData(target, {}, f.runner, { ...f.deps, port: async () => 'occupied' }), /occupied/);
  await assert.rejects(data.startHostData(target, {}, f.runner, { ...f.deps, execute: async () => ({ stdout: '2.0.11' }) }), /pinned/);
  await assert.rejects(data.startHostData(target, {}, f.runner, { ...f.deps, execute: async () => { throw new Error('permission denied'); } }), /permission denied/);
  assert.equal(f.calls.some(call => call.includes('restore') || call.includes('start')), false);
});

test('host DAB startup liveness failure removes its signal handlers', async t => {
  const f = await fixture(t);
  const before = process.listenerCount('SIGINT');
  await assert.rejects(data.startHostData(target, {}, f.runner, { ...f.deps, fetch: async () => new Response('{}', { status: 503 }) }), /liveness/);
  assert.equal(process.listenerCount('SIGINT'), before);
  await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
});

test('host DAB start cannot replace the receipt while an older stop owns the lock', async t => {
  const f = await fixture(t);
  await data.startHostData(target, {}, f.runner, f.deps);
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  let alive = true;
  const deps = { ...f.deps, inspect: async () => alive ? f.actual : null, spawn: (...args) => {
    alive = true;
    return f.deps.spawn(...args);
  } };
  const stopping = data.stopHostData(target, {}, { ...deps, inspect: async () => {
    alive = false;
    entered.resolve();
    await resume.promise;
    return f.actual;
  } });
  try {
    await entered.promise;
    await assert.rejects(data.startHostData(target, {}, f.runner, deps), /locked/);
  } finally {
    resume.resolve();
    await stopping;
  }
  await data.startHostData(target, {}, f.runner, deps);
  assert.equal(JSON.parse(await readFile(f.receipt, 'utf8')).pid, f.child.pid);
  await data.verifyHostData(target, {}, f.deps);
  await data.stopHostData(target, {}, f.deps);
});

for (const platform of ['win32', 'linux', 'darwin']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    for (const pauseAt of [1, 2]) {
      test(`host DAB ${platform} ${signal} during startup probe ${pauseAt} aborts and removes its owned process and listeners`, async t => {
        const f = await fixture(t, platform);
        const before = new Map(['SIGINT', 'SIGTERM'].map(name => [name, new Set(process.listeners(name))]));
        const entered = Promise.withResolvers(), resume = Promise.withResolvers();
        let requests = 0, aborted = false;
        const starting = data.startHostData(target, {}, f.runner, { ...f.deps, fetch: async (url, options) => {
          if (++requests !== pauseAt) return f.deps.fetch(url);
          entered.resolve();
          await Promise.race([resume.promise, new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
          })]);
          return f.deps.fetch(url);
        } });
        const outcome = starting.then(() => null, error => error);
        try {
          await Promise.race([entered.promise, outcome.then(error => { if (error) throw error; })]);
          const handlers = process.listeners(signal).filter(listener => !before.get(signal).has(listener));
          assert.equal(handlers.length, 1, 'startup must already have an owned cleanup handler');
          handlers[0]();
          assert.match((await outcome)?.message ?? '', /cancelled/i);
          assert.equal(aborted, true, 'cancellation must abort the pending HTTP probe');
          if (platform === 'win32') assert.ok(f.calls.some(call => call[0] === 'taskkill.exe' && call.includes(String(f.child.pid))));
          else {
            assert.ok(f.calls.some(call => call[0] === 'kill' && call[1] === -f.child.pid));
            assert.equal(f.calls.some(call => call[0] === 'taskkill.exe'), false);
          }
          await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
          for (const name of before.keys()) assert.deepEqual(new Set(process.listeners(name)), before.get(name));
        } finally {
          resume.resolve();
          await outcome;
        }
      });
    }
  }
}

test('host DAB resumes a dead same-target receipt only when its port is free', async t => {
  const f = await fixture(t);
  await data.startHostData(target, {}, f.runner, f.deps);
  const old = JSON.parse(await readFile(f.receipt, 'utf8'));
  await writeFile(f.receipt, JSON.stringify({ ...old, pid: 99999 }));
  const deps = { ...f.deps, inspect: async pid => pid === 99999 ? null : f.actual };
  await assert.rejects(data.startHostData(target, {}, f.runner, { ...deps, port: async () => 'occupied' }), /Stale/);
  await data.startHostData(target, {}, f.runner, deps);
  assert.equal(f.calls.filter(call => call.includes('start')).length, 2);
  await data.stopHostData(target, {}, f.deps);
});
