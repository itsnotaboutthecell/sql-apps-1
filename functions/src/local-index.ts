import { app } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { jobMessageSchema } from '../../src/file-jobs.js';
import { analyzeFile } from './file-analysis.js';
import { localJobData } from '../../src/local-job-data.js';
import { withJobSnapshotLease } from '../../src/local-job-snapshots.js';
import { localSettingsSchema } from '../../src/local-settings.js';
import { localTracing } from '../../src/local-tracing.js';
import { maintainLocalJobs } from '../../src/local-maintenance.js';
import type { TraceParent } from '../../src/trace-contract.js';

if (process.env.NODE_ENV === 'production' || process.env.SQL_APPS_LOCAL_FUNCTIONS !== 'true') {
  throw new Error('Local Functions entry point requires explicit development mode outside production');
}
const secret = process.env.LOCAL_FUNCTION_SECRET;
const connection = process.env.AzureWebJobsStorage;
const dataOrigin = process.env.LOCAL_DAB_URL;
if (!secret || secret.length < 32 || !connection || !dataOrigin) throw new Error('Local Functions settings are incomplete');
const expected = Buffer.from(secret);
const blobs = BlobServiceClient.fromConnectionString(connection).getContainerClient('files');
const jobs = localJobData(dataOrigin);
const settings = localSettingsSchema.parse(JSON.parse(process.env.LOCAL_SETTINGS ?? '{}'));
const telemetry = settings.tracing ? localTracing(connection) : undefined;

app.http('echo', {
  methods: ['POST'], authLevel: 'anonymous',
  handler: async (request, context) => {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const provided = Buffer.from(token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      context.warn('Local function invocation rejected');
      return { status: 401, jsonBody: { error: 'Local gateway credential required' } };
    }
    let body: unknown;
    try { body = await request.json(); }
    catch { return { status: 400, jsonBody: { error: 'JSON body required' } }; }
    const parsed = z.object({ user: z.object({ oid: z.string().uuid(), tenantId: z.string().uuid() }), input: z.unknown() }).safeParse(body);
    if (!parsed.success) return { status: 400, jsonBody: { error: 'Verified user context required' } };
    return { jsonBody: { result: parsed.data } };
  },
});

app.storageQueue('analyzeFile', {
  queueName: 'file-jobs', connection: 'AzureWebJobsStorage',
  handler: async (message: unknown, context) => {
    const job = jobMessageSchema.parse(message);
    if (job.key !== `${job.tenantId}/${job.oid}/jobs/${job.id}`) throw new Error('Job snapshot ownership mismatch');
    const initial = await jobs.get(job.oid, job.id);
    if (!initial || initial.status === 'completed' || initial.status === 'failed') return;
    await withJobSnapshotLease(blobs.getBlockBlobClient(job.key), async signal => {
      const row = await jobs.get(job.oid, job.id, signal);
      if (!row || row.status === 'completed' || row.status === 'failed') return;
      const identity = { oid: job.oid, tenantId: job.tenantId };
      const process = async (parent?: TraceParent) => {
        const step = async <T>(name: string, work: () => Promise<T>) => telemetry
          ? telemetry.operation(identity, name, async (_trace, span) => { span.setAttribute('job.id', job.id); return work(); }, parent)
          : work();
        await step('sql.job.processing', () => jobs.update(job.oid, job.id,
          { status: 'processing', error: null }, signal));
        try {
          const bytes = await step('blob.snapshot.read', () =>
            blobs.getBlockBlobClient(job.key).downloadToBuffer(0, undefined, { abortSignal: signal }));
          await step('sql.job.complete', () => jobs.update(job.oid, job.id,
            { status: 'completed', ...analyzeFile(bytes), error: null }, signal));
        } catch (error) {
          context.error('File processing failed', { jobId: job.id, errorType: error instanceof Error ? error.name : 'UnknownError' });
          if (Number(context.triggerMetadata?.dequeueCount) >= 5) {
            await jobs.update(job.oid, job.id,
              { status: 'failed', error: 'Processing failed after five attempts; check worker logs' }, signal);
          }
          throw error;
        }
      };
      if (telemetry) await telemetry.operation(identity, 'queue.blob.analyze.sql.complete',
        async (trace, span) => { span.setAttribute('job.id', job.id); await process(trace); }, job.trace);
      else await process();
    });
  },
});

app.timer('maintainFileJobs', {
  schedule: '0 * * * * *', runOnStartup: false, useMonitor: true,
  handler: async (_timer, context) => {
    const traces = BlobServiceClient.fromConnectionString(connection).getContainerClient('traces');
    const result = await maintainLocalJobs(jobs, blobs, traces, settings);
    context.log('Scheduled local job maintenance completed', result);
  },
});

app.storageQueue('failedFileJob', {
  queueName: 'file-jobs-poison', connection: 'AzureWebJobsStorage',
  handler: async (message: unknown, context) => {
    const job = jobMessageSchema.parse(message);
    if (job.key !== `${job.tenantId}/${job.oid}/jobs/${job.id}`) throw new Error('Job snapshot ownership mismatch');
    const row = await jobs.get(job.oid, job.id);
    if (row && row.status !== 'completed') {
      await jobs.update(job.oid, job.id, { status: 'failed', error: 'Queue delivery exhausted; check worker logs and submit a new job' });
    }
    context.error('File job moved to poison queue', { jobId: job.id });
  },
});
