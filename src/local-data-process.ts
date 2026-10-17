import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runtimeFor, portState } from './workspace.mjs';
import { sqlTargetFingerprint } from './sql-target.mjs';
import { saveJson, withStateLock } from './state-files.js';
import { endpointConnection, readEndpointCredentials, type EndpointTarget } from './sql-endpoint.js';
import { projectPath } from './runtime-roots.js';
import type { Run } from './process.js';

const execute = promisify(execFile);
const processSchema = z.object({ pid: z.number().int().positive(), started: z.string().min(1), command: z.string().min(1) });
const receiptSchema = processSchema.extend({ fingerprint: z.string().min(1) }).strict();
type ProcessIdentity = z.infer<typeof processSchema>;
type Receipt = z.infer<typeof receiptSchema>;
const receiptPath = () => join(runtimeFor().stateDirectory, 'host-dab.json');
interface HostDataDependencies {
  platform: NodeJS.Platform;
  inspect: typeof inspectProcess;
  execute: typeof execute;
  spawn: typeof spawn;
  port: typeof portState;
  fetch: typeof fetch;
  wait: (milliseconds: number) => Promise<void>;
  kill: typeof process.kill;
}
const defaults: HostDataDependencies = { platform: process.platform, inspect: inspectProcess, execute, spawn, port: portState, fetch,
  wait: milliseconds => new Promise(done => setTimeout(done, milliseconds)), kill: process.kill };

export function verifyHostDataIdentity(receipt: Receipt, actual: ProcessIdentity, fingerprint: string): void {
  if (receipt.pid !== actual.pid || receipt.started !== actual.started || receipt.command !== actual.command ||
      receipt.fingerprint !== fingerprint) throw new Error('Host DAB process ownership does not match; no process was stopped or adopted.');
}

async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  z.number().int().positive().parse(pid);
  if (process.platform === 'win32') {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if($p){@{pid=[int]$p.ProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    return result.stdout.trim() ? processSchema.parse(JSON.parse(result.stdout)) : null;
  }
  try {
    const result = await execute('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args='], { timeout: 10000, maxBuffer: 65536 });
    const match = /^(.{24})\s+(.+?)\s*$/.exec(result.stdout.trim());
    if (!match) throw new Error('Host DAB process identity could not be parsed.');
    return { pid, started: match[1]!, command: match[2]! };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1 &&
        'stdout' in error && typeof error.stdout === 'string' && !error.stdout.trim()) return null;
    throw error;
  }
}

async function readReceipt(): Promise<Receipt | null> {
  try { return receiptSchema.parse(JSON.parse(await readFile(receiptPath(), 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function fingerprint(target: EndpointTarget, config: unknown) {
  return createHash('sha256').update(JSON.stringify({ target: sqlTargetFingerprint(target), config,
    home: runtimeFor().home, workspace: runtimeFor().id, version: '2.0.12' })).digest('hex');
}

export async function verifyHostData(target: EndpointTarget, config: unknown, overrides: Partial<HostDataDependencies> = {}): Promise<void> {
  const deps = { ...defaults, ...overrides };
  const receipt = await readReceipt();
  if (!receipt) throw new Error('Host DAB has no owned process receipt; start the approved app first.');
  const actual = await deps.inspect(receipt.pid);
  if (!actual) throw new Error('Recorded host DAB process is no longer running; review startup before resuming.');
  verifyHostDataIdentity(receipt, actual, await fingerprint(target, config));
  // Comprehensive /health is role-protected; gateway readiness probes the actual authorized SQL procedure.
  const response = await deps.fetch(`${runtimeFor().origins.data}/`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Owned host DAB is not responsive (HTTP ${response.status}); no process was restarted.`);
}

export async function stopHostData(target: EndpointTarget, config?: unknown, overrides: Partial<HostDataDependencies> = {}): Promise<void> {
  const deps = { ...defaults, ...overrides };
  await withStateLock(receiptPath(), () => stopOwnedHostData(target, config, deps));
}

async function stopOwnedHostData(target: EndpointTarget, config: unknown, deps: HostDataDependencies): Promise<void> {
  const receipt = await readReceipt();
  if (!receipt) throw new Error('No owned host DAB process is recorded.');
  const expected = await fingerprint(target, config ?? JSON.parse(await readFile(join(runtimeFor().stateDirectory, 'host-dab-config.json'), 'utf8')));
  if (receipt.fingerprint !== expected) throw new Error('Host DAB belongs to another target/configuration; no process was stopped.');
  const actual = await deps.inspect(receipt.pid);
  if (actual) {
    verifyHostDataIdentity(receipt, actual, expected);
    if (deps.platform === 'win32') await deps.execute('taskkill.exe', ['/PID', String(receipt.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    else {
      // Only the process group created by this launcher may be signaled.
      deps.kill(-receipt.pid, 'SIGTERM');
    }
  }
  await unlink(receiptPath());
}

export async function startHostData(target: EndpointTarget, config: unknown, run: Run, overrides: Partial<HostDataDependencies> = {}): Promise<void> {
  const deps = { ...defaults, ...overrides };
  const runtime = runtimeFor();
  const cancellation = new AbortController();
  let starting = true;
  const startupFetch: typeof fetch = (input, options) => deps.fetch(input, { ...options,
    signal: AbortSignal.any([cancellation.signal, ...(options?.signal ? [options.signal] : [])]) });
  await withStateLock(receiptPath(), async () => {
    const existing = await readReceipt();
    if (existing) {
      const actual = await deps.inspect(existing.pid);
      if (actual) { await verifyHostData(target, config, deps); return; }
      if (existing.fingerprint !== await fingerprint(target, config) || await deps.port(runtime.ports.data) !== 'free') {
        throw new Error('Stale host DAB receipt has a different target/configuration or occupied port; inspect it before resuming.');
      }
      console.error('Recorded host DAB process has exited and its port is free; resuming the same approved target.');
      await unlink(receiptPath());
    }
    if (await deps.port(runtime.ports.data) !== 'free') throw new Error('Host DAB port is occupied or unverifiable; no process was stopped.');
    const manifest = projectPath('.config', 'host-dab', 'dotnet-tools.json');
    const directory = projectPath('.config', 'host-dab');
    let version: string;
    try { version = String((await deps.execute('dotnet', ['tool', 'run', 'dab', '--', '--version'], { cwd: directory, windowsHide: true, timeout: 15000 })).stdout); }
    catch (error) {
      const output = error instanceof Error ? error.message : '';
      if (!/tool restore|could not find|cannot find a tool|not been restored/i.test(output)) throw error;
      await run('dotnet', ['tool', 'restore', '--tool-manifest', manifest]);
      version = String((await deps.execute('dotnet', ['tool', 'run', 'dab', '--', '--version'], { cwd: directory, windowsHide: true, timeout: 15000 })).stdout);
    }
    if (!/\b2\.0\.12(?:\D|$)/.test(version)) throw new Error('Host DAB must resolve the pinned local tool version 2.0.12.');
    const credentials = await readEndpointCredentials(runtime, target, run);
    const configFile = join(runtime.stateDirectory, 'host-dab-config.json');
    await saveJson(configFile, config);
    const child = deps.spawn('dotnet', ['tool', 'run', 'dab', '--', 'start', '--config', configFile],
      { cwd: directory, windowsHide: true, shell: false, detached: deps.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
          SQL_CONNECTION_STRING: endpointConnection(target, credentials.login, credentials.password),
          ASPNETCORE_URLS: runtime.origins.data } });
    let failure: Error | undefined;
    let stopping = false;
    const removeSignalHandlers = () => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, onSignal);
    };
    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      removeSignalHandlers();
      cancellation.abort(new Error('Host DAB startup/run cancelled; SQL data was preserved.'));
      // Startup owns the lock and performs its own cleanup before releasing it.
      if (!starting) void stopHostData(target, config, deps).catch(error => {
        console.error(error instanceof Error ? error.message : 'Host DAB cleanup failed.');
        process.exitCode = 1;
      });
    };
    const safeOutput = () => {
      let pending = '';
      let discarding = false;
      return (chunk: Buffer) => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          if (!discarding) process.stderr.write(`${pending.slice(0, newline).replaceAll(credentials.password, '[REDACTED]').slice(0, 65536)}\n`);
          pending = pending.slice(newline + 1);
          discarding = false;
        }
        if (pending.length > 65536) {
          console.error('Host DAB output line exceeded the safe limit; line omitted.');
          pending = '';
          discarding = true;
        }
      };
    };
    child.stdout.on('data', safeOutput());
    child.stderr.on('data', safeOutput());
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => {
      removeSignalHandlers();
      if (!stopping) {
        failure = new Error(`Host DAB stopped (${signal ?? code}); SQL data was preserved.`);
        console.error(failure.message);
        process.exitCode = 1;
      }
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, onSignal);
    try {
      if (!child.pid) throw new Error('Host DAB did not provide a process identity.');
      const actual = await deps.inspect(child.pid);
      if (!actual) throw new Error('Host DAB exited before its process identity was recorded.');
      await saveJson(receiptPath(), { ...actual, fingerprint: await fingerprint(target, config) });
      for (let attempt = 0; attempt < 30; attempt++) {
        cancellation.signal.throwIfAborted();
        if (failure) throw failure;
        let ready = false;
        try {
          const response = await startupFetch(`${runtime.origins.data}/`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
          await response.body?.cancel();
          cancellation.signal.throwIfAborted();
          ready = response.ok;
          if (!ready && attempt === 29) throw new Error(`Host DAB liveness check failed (HTTP ${response.status}).`);
        }
        catch (error) {
          if (!(error instanceof TypeError) || attempt === 29) throw error;
        }
        if (ready) {
          await verifyHostData(target, config, { ...deps, fetch: startupFetch });
          cancellation.signal.throwIfAborted();
          break;
        }
        await deps.wait(1000);
      }
    } catch (error) {
      stopping = true;
      removeSignalHandlers();
      if (await readReceipt()) await stopOwnedHostData(target, config, deps);
      else child.kill();
      throw error;
    }
  });
  starting = false;
  if (cancellation.signal.aborted) {
    await stopHostData(target, config, deps);
    cancellation.signal.throwIfAborted();
  }
}
