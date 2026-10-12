import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { z } from 'zod';
import { connectionFileStore, objectKey } from './storage.js';
import { localJobData } from './local-job-data.js';
import { deleteLocalJobSnapshot } from './local-job-snapshots.js';
import { localOrigin, dabImage, sqlImage } from './local.js';
import type { FileProcessing } from './gateway.js';
import { run, type Run } from './process.js';
import { readLocalSettings } from './local-settings.js';
import { localTracing } from './local-tracing.js';
import type { TraceParent } from './trace-contract.js';
import type { UserIdentity } from './auth.js';
import { maintainLocalJobs } from './local-maintenance.js';
import { runtimeFor, functionsImage } from './workspace.mjs';
import { verifyContainerWorkspace } from './local-ownership.js';
import { probeReadiness } from './readiness.js';
import { toolingAsset, toolingRoot } from './runtime-roots.js';

export const localFunctionsOrigin = runtimeFor().origins.functions;
const azuriteImage = 'mcr.microsoft.com/azure-storage/azurite:3.35.0@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37';
const account = 'sqlappslocal';
const stateSchema = z.strictObject({ key: z.string().regex(/^[A-Za-z0-9+/]{86}==$/), secret: z.string().regex(/^[a-f0-9]{64}$/) });

export function localServiceImages(container: string): Record<string, string | RegExp> {
  const runtime = runtimeFor(container);
  return { sql: sqlImage, data: dabImage, storage: azuriteImage,
    functions: runtime.mode === 'isolated' ? new RegExp(`^${runtime.imageRepository}:[a-f0-9]{64}$`) : `${runtime.imageRepository}:local` };
}

export function serviceNames(container: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new Error('Invalid SQL container name');
  return runtimeFor(container).names;
}

export function storageConnection(key: string, host = '127.0.0.1') {
  const ports = host === '127.0.0.1' ? runtimeFor().ports : { blob: 10000, queue: 10001 };
  return `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=http://${host}:${ports.blob}/${account};QueueEndpoint=http://${host}:${ports.queue}/${account};`;
}

export function localServiceReadiness(connection: string, secret: string) {
  const options = { retryOptions: { maxTries: 1, tryTimeoutInMs: 4_000 } };
  const blobs = BlobServiceClient.fromConnectionString(connection, options);
  const queues = ['file-jobs', 'file-jobs-poison'].map(name => new QueueClient(connection, name, options));
  const input = {
    user: { oid: '11111111-1111-4111-8111-111111111111', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    input: { readiness: true },
  };
  const expected = z.strictObject({
    result: z.strictObject({
      user: z.strictObject({ oid: z.literal(input.user.oid), tenantId: z.literal(input.user.tenantId) }),
      input: z.strictObject({ readiness: z.literal(true) }),
    }),
  });
  return async (fetcher: typeof fetch, signal: AbortSignal): Promise<void> => {
    await Promise.all([
      probeReadiness('blob', async () => {
        await Promise.all(['files', 'traces'].map(name =>
          blobs.getContainerClient(name).getProperties({ abortSignal: signal })));
      }),
      probeReadiness('queue', async () => {
        await Promise.all(queues.map(queue => queue.getProperties({ abortSignal: signal })));
      }),
      probeReadiness('functions', async () => {
        const response = await fetcher(new URL('/api/echo', localFunctionsOrigin), {
          method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(input), signal, redirect: 'error',
        });
        if (response.status !== 200) throw new Error(`Functions readiness returned HTTP ${response.status}`);
        expected.parse(await response.json());
      }),
    ]);
  };
}

async function credentials(container: string, create: boolean) {
  const names = serviceNames(container);
  try { return stateSchema.parse(JSON.parse(await readFile(names.state, 'utf8'))); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (!create) throw new Error('Local service credentials are missing. Restore the gitignored service state alongside the existing storage volume; existing account keys are not silently reset.', { cause: error });
    await mkdir(runtimeFor(container).stateDirectory, { recursive: true });
    const state = { key: randomBytes(64).toString('base64'), secret: randomBytes(32).toString('hex') };
    await writeFile(names.state, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    return state;
  }
}

export async function ensureOwned(name: string, role: string, runner: Run = run): Promise<boolean> {
  const present = (await runner('docker', ['ps', '--all', '--format', '{{.Names}}', '--filter', `name=^${name}$`])).trim();
  if (!present) return false;
  const label = (await runner('docker', ['inspect', '--format', '{{index .Config.Labels "sql-apps.local"}}', name])).trim();
  if (label !== role) throw new Error(`Container ${name} is not project-owned (${role}); refusing to modify it`);
  const runtime = runtimeFor();
  if (runtime.mode === 'isolated') {
    const image = localServiceImages(runtime.sqlContainer)[role];
    if (!image) throw new Error(`Unknown local service role ${role}`);
    const ports: Record<string, number> = role === 'storage' ? { '10000/tcp': runtime.ports.blob, '10001/tcp': runtime.ports.queue } :
      role === 'functions' ? { '80/tcp': runtime.ports.functions } : { '5000/tcp': runtime.ports.data };
    await verifyContainerWorkspace(name, runtime, image, ports, runner);
  }
  return true;
}

export async function startLocalServices(container: string, runner: Run = run): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Local services are disabled in production');
  const names = serviceNames(container);
  const runtime = runtimeFor(container);
  const settings = await readLocalSettings();
  const storageExists = await ensureOwned(names.storage, 'storage', runner);
  const functionsExist = await ensureOwned(names.functions, 'functions', runner);
  const volumeExists = (await runner('docker', ['volume', 'ls', '--filter', `name=^${names.storage}-data$`, '--format', '{{.Name}}'])).trim();
  if (volumeExists && runtime.mode === 'isolated') {
    const owner = z.object({ workspace: z.string(), role: z.string() }).parse(JSON.parse(await runner('docker',
      ['volume', 'inspect', `${names.storage}-data`, '--format',
        '{"workspace":{{json (index .Labels "sql-apps.workspace")}},"role":{{json (index .Labels "sql-apps.local")}}}'])));
    if (owner.workspace !== runtime.id || owner.role !== 'storage') throw new Error('Storage volume is not owned by this workspace; refusing to initialize it');
  }
  const state = await credentials(container, !storageExists && !volumeExists);
  if (!volumeExists) await runner('docker', ['volume', 'create', '--label', 'sql-apps.local=storage', ...runtime.labels, `${names.storage}-data`]);
  if (!await ensureOwned(names.data, 'data', runner)) throw new Error('Start local DAB before local services');
  const networkExists = (await runner('docker', ['network', 'ls', '--filter', `name=^${names.network}$`, '--format', '{{.Name}}'])).trim();
  if (networkExists) {
    const network = z.object({ Internal: z.boolean(), Labels: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await runner('docker', ['network', 'inspect', '--format', '{{json .}}', names.network])));
    if (!network.Internal || network.Labels['sql-apps.local'] !== 'services' ||
        (runtime.mode === 'isolated' && network.Labels['sql-apps.workspace'] !== runtime.id)) throw new Error('Local worker network must be workspace-owned and internal');
  } else {
    await runner('docker', ['network', 'create', '--internal', '--label', 'sql-apps.local=services', ...runtime.labels, names.network]);
  }
  const networks = async (name: string) => z.record(z.string(), z.object({ IPAddress: z.string() }))
    .parse(JSON.parse(await runner('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', name])));
  if (!(await networks(names.data))[names.network]) await runner('docker', ['network', 'connect', names.network, names.data]);
  if (storageExists) await runner('docker', ['rm', '--force', names.storage]);
  await runner('docker', ['run', '--detach', '--name', names.storage, '--label', 'sql-apps.local=storage',
    ...runtime.labels,
    '--network', 'bridge',
    '--publish', `127.0.0.1:${runtime.ports.blob}:10000`, '--publish', `127.0.0.1:${runtime.ports.queue}:10001`,
    '--mount', `type=volume,source=${names.storage}-data,target=/data`,
    '--env', 'AZURITE_ACCOUNTS', azuriteImage, 'azurite', '--blobHost', '0.0.0.0', '--queueHost', '0.0.0.0',
    '--location', '/data', '--skipApiVersionCheck', '--disableProductStyleUrl', '--disableTelemetry'],
  { env: { AZURITE_ACCOUNTS: `${account}:${state.key}` }, redact: [state.key] });
  await runner('docker', ['network', 'connect', names.network, names.storage]);
  const connection = storageConnection(state.key);
  const retryOptions = { maxTries: 1, tryTimeoutInMs: 3_000 };
  const blobs = BlobServiceClient.fromConnectionString(connection, { retryOptions }).getContainerClient('files');
  const queue = new QueueClient(connection, 'file-jobs', { retryOptions });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await blobs.createIfNotExists(); await queue.createIfNotExists();
      await new QueueClient(connection, 'file-jobs-poison', { retryOptions }).createIfNotExists();
      await BlobServiceClient.fromConnectionString(connection, { retryOptions }).getContainerClient('traces').createIfNotExists();
      ready = true; break;
    }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'statusCode' in error &&
          typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
        throw new Error(`Azurite provisioning rejected the request (${error.statusCode}); check local service credentials`, { cause: error });
      }
      if (attempt === 29) throw new Error('Azurite readiness failed', { cause: error });
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  if (!ready) throw new Error('Azurite did not become ready');
  const image = functionsImage(runtime);
  await runner('docker', ['build', '--file', toolingAsset('functions', 'local.Dockerfile'),
    '--tag', image, toolingRoot]);
  const address = async (name: string) => {
    const ip = (await networks(name))[names.network]?.IPAddress;
    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`Container ${name} has no local worker network IPv4 address`);
    return ip;
  };
  const storageIp = await address(names.storage);
  if (functionsExist) await runner('docker', ['rm', '--force', names.functions]);
  await runner('docker', ['run', '--detach', '--name', names.functions, '--label', 'sql-apps.local=functions',
    ...runtime.labels,
    '--network', 'bridge',
    '--publish', `127.0.0.1:${runtime.ports.functions}:80`,
    '--env', 'AzureWebJobsStorage', '--env', 'LOCAL_FUNCTION_SECRET', '--env', 'LOCAL_DAB_URL',
    '--env', 'LOCAL_SETTINGS',
    '--env', 'FUNCTIONS_WORKER_RUNTIME=node', '--env', 'SQL_APPS_LOCAL_FUNCTIONS=true', image],
  { env: { AzureWebJobsStorage: storageConnection(state.key, storageIp), LOCAL_FUNCTION_SECRET: state.secret,
    LOCAL_DAB_URL: `http://${names.data}:5000`, LOCAL_SETTINGS: JSON.stringify(settings) }, redact: [state.key, state.secret] });
  await runner('docker', ['network', 'connect', names.network, names.functions]);
  for (let attempt = 0; attempt < 120; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(`${localFunctionsOrigin}/api/echo`, {
        method: 'POST', headers: { authorization: `Bearer ${state.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user: { oid: '11111111-1111-4111-8111-111111111111',
          tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, input: { readiness: true } }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      if (attempt === 119) throw new Error(`Local Functions failed to start; inspect docker logs ${names.functions}`, { cause: error });
    }
    if (response) {
      await response.arrayBuffer();
      if (response.ok) { console.log('Azurite and real local Functions ready (Blob, Queue, HTTP).'); return; }
      if (![404, 503].includes(response.status)) throw new Error(`Functions readiness returned ${response.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Local Functions not ready; inspect docker logs ${names.functions}`);
}

export async function stopLocalServices(container: string, runner: Run = run) {
  const names = serviceNames(container);
  const functionsExist = await ensureOwned(names.functions, 'functions', runner);
  const storageExists = await ensureOwned(names.storage, 'storage', runner);
  if (functionsExist) await runner('docker', ['rm', '--force', names.functions]);
  if (storageExists) await runner('docker', ['stop', names.storage]);
}

export async function localServiceAdapters(container: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local services are disabled in production');
  const state = await credentials(container, false);
  const connection = storageConnection(state.key);
  const files = connectionFileStore(connection, 'files');
  const snapshots = BlobServiceClient.fromConnectionString(connection).getContainerClient('files');
  const queue = new QueueClient(connection, 'file-jobs');
  const jobs = localJobData(localOrigin);
  const settings = await readLocalSettings();
  const telemetry = settings.tracing ? localTracing(connection) : undefined;
  const submit = async (identity: UserIdentity, name: string, bytes: Buffer, parent?: TraceParent, previous?: string) => {
    const id = randomUUID();
    const action = async (traceParent?: TraceParent) => {
      const step = async <T>(name: string, work: () => Promise<T>) => telemetry
        ? telemetry.operation(identity, name, async (_trace, span) => { span.setAttribute('job.id', id); return work(); }, traceParent)
        : work();
      const key = `${identity.tenantId}/${identity.oid}/jobs/${id}`;
      await step('blob.snapshot.write', () => files.put(key, bytes));
      try { await step('sql.job.create', () => jobs.create(identity.oid, { id, filename: name, blob_key: key, ...(previous ? { parent_job_id: previous } : {}) })); }
      catch (error) { await files.delete(key); throw error; }
      try {
        await step('queue.job.send', () => queue.sendMessage(Buffer.from(JSON.stringify({ id, oid: identity.oid, tenantId: identity.tenantId, key,
          ...(traceParent ? { trace: traceParent } : {}),
        })).toString('base64')));
      } catch (error) {
        await jobs.update(identity.oid, id, { status: 'failed', error: 'Queue submission failed; retry the saved snapshot after storage recovery' });
        throw error;
      }
      return id;
    };
    return telemetry ? telemetry.operation(identity, 'snapshot.sql.queue.submit', async (trace, span) => {
      span.setAttribute('job.id', id); return action(trace);
    }, parent) : action();
  };
  const processing: FileProcessing = {
    list: identity => jobs.list(identity.oid),
    async create(identity, name, parent) {
      if (!settings.processing) throw Object.assign(new Error('File processing is disabled by local settings'), { statusCode: 503 });
      const file = await files.get(objectKey(identity.tenantId, identity.oid, name));
      if (!file) throw Object.assign(new Error('File not found'), { statusCode: 404 });
      return submit(identity, name, file.bytes, parent);
    },
    async retry(identity, id, parent) {
      if (!settings.processing || !settings.jobRetry) throw Object.assign(new Error('Job retry is disabled by local settings'), { statusCode: 503 });
      const row = await jobs.get(identity.oid, id);
      if (!row) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
      if (row.status !== 'failed') throw Object.assign(new Error('Only failed jobs can be retried'), { statusCode: 409 });
      const file = await files.get(`${identity.tenantId}/${identity.oid}/jobs/${id}`);
      if (!file) throw Object.assign(new Error('Job snapshot is missing; upload the file and submit a new job'), { statusCode: 409 });
      return submit(identity, row.filename, file.bytes, parent, id);
    },
    async delete(identity, id) {
      return deleteLocalJobSnapshot(jobs, snapshots, identity.tenantId, identity.oid, id);
    },
  };
  return { files, processing, functionToken: async () => state.secret, settings,
    ready: localServiceReadiness(connection, state.secret), ...(telemetry ? { telemetry } : {}) };
}

export async function runLocalMaintenance(container: string) {
  const state = await credentials(container, false);
  const blobs = BlobServiceClient.fromConnectionString(storageConnection(state.key));
  return maintainLocalJobs(localJobData(localOrigin), blobs.getContainerClient('files'), blobs.getContainerClient('traces'), await readLocalSettings());
}
