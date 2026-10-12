import type { ContainerClient } from '@azure/storage-blob';
import { localJobData } from './local-job-data.js';
import { deleteLocalJobSnapshot, tryWithJobSnapshotLease } from './local-job-snapshots.js';
import type { LocalSettings } from './local-settings.js';
import type { FileJob } from './file-jobs.js';

export const localTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const localOwnerIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

export function sqlTime(value: string | undefined): number {
  if (!value) throw new Error('Job timestamp is missing');
  const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(time)) throw new Error('Invalid job timestamp');
  return time;
}

export function maintenanceAction(job: FileJob, settings: LocalSettings, now: number): 'recover' | 'remove' | undefined {
  const age = now - sqlTime(job.updated_at ?? job.created_at);
  if (['queued', 'processing'].includes(job.status) && age >= settings.staleJobMinutes * 60_000) return 'recover';
  if (settings.retentionDays > 0 && ['completed', 'failed'].includes(job.status) && age >= settings.retentionDays * 86400_000) return 'remove';
  return undefined;
}

export async function maintainLocalJobs(
  jobs: ReturnType<typeof localJobData>, files: ContainerClient, traces: ContainerClient,
  settings: LocalSettings, now = Date.now(), owners: readonly string[] = localOwnerIds,
) {
  const result = { recovered: 0, removedJobs: 0, removedSnapshots: 0, removedTraces: 0 };
  for (const oid of owners) {
    const rows = await jobs.listAll(oid);
    const active = new Set(rows.map(job => job.id));
    for (const job of rows) {
      const action = maintenanceAction(job, settings, now);
      if (action === 'recover') {
        const snapshot = files.getBlockBlobClient(`${localTenantId}/${oid}/jobs/${job.id}`);
        const recovered = await tryWithJobSnapshotLease(snapshot, signal =>
          jobs.update(oid, job.id, {
            status: 'failed',
            error: 'Job exceeded the recovery timeout; retry the saved snapshot when services are healthy',
          }, signal));
        if (recovered) result.recovered++;
      } else if (action === 'remove') {
        const removed = await deleteLocalJobSnapshot(jobs, files, localTenantId, oid, job.id);
        active.delete(job.id);
        if (removed) result.removedJobs++;
      }
    }
    if (settings.retentionDays > 0) {
      const prefix = `${localTenantId}/${oid}/jobs/`;
      for await (const blob of files.listBlobsFlat({ prefix })) {
        const id = blob.name.slice(prefix.length);
        if (!active.has(id) && blob.properties.lastModified && now - blob.properties.lastModified.getTime() >= Math.max(86400_000, settings.retentionDays * 86400_000)) {
          await files.getBlockBlobClient(blob.name).deleteIfExists();
          result.removedSnapshots++;
        }
      }
    }
    for await (const blob of traces.listBlobsFlat({ prefix: `${localTenantId}/${oid}/` })) {
      if (blob.properties.lastModified && now - blob.properties.lastModified.getTime() >= settings.traceRetentionDays * 86400_000) {
        await traces.getBlockBlobClient(blob.name).deleteIfExists();
        result.removedTraces++;
      }
    }
  }
  return result;
}
