import { localPrincipal } from './local.js';
import { fileJobSchema, type FileJob } from './file-jobs.js';

export async function deleteLocalJob(
  jobs: Pick<ReturnType<typeof localJobData>, 'get' | 'delete'>,
  oid: string, id: string, removeSnapshot: () => Promise<unknown>, signal?: AbortSignal,
): Promise<boolean> {
  const row = await jobs.get(oid, id, signal);
  if (row && !['completed', 'failed'].includes(row.status)) {
    throw Object.assign(new Error('Wait for processing to finish before deleting this job'), { statusCode: 409 });
  }
  if (row) await jobs.delete(oid, id, signal);
  signal?.throwIfAborted();
  await removeSnapshot();
  return row !== undefined;
}

export function localJobData(origin: string, fetcher: typeof fetch = fetch) {
  async function request(oid: string, path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await fetcher(new URL(path, origin), {
      method, headers: {
        'x-ms-client-principal': localPrincipal(oid, 'access_as_user', 'processor'), 'x-ms-api-role': 'processor',
        'content-type': 'application/json', ...(method === 'PATCH' ? { 'if-match': '*' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Job data operation failed (${response.status})`);
    return response;
  }
  async function page(oid: string, path: string): Promise<{ rows: FileJob[]; next?: string }> {
    const url = new URL(path, origin);
    if (url.origin !== new URL(origin).origin || url.pathname !== '/api/FileJob' ||
        url.username || url.password || url.hash) throw new Error('Invalid job pagination');
    const body = await (await request(oid, url.pathname + url.search)).json() as {
      value: unknown[];
      nextLink?: string;
    };
    if (!Array.isArray(body.value)) throw new Error('Invalid job response');
    if (body.nextLink !== undefined && (typeof body.nextLink !== 'string' || !body.nextLink)) {
      throw new Error('Invalid job continuation');
    }
    return {
      rows: body.value.map(value => fileJobSchema.parse(value)),
      ...(body.nextLink ? { next: body.nextLink } : {}),
    };
  }
  async function allPages(oid: string, first: string): Promise<FileJob[]> {
    const rows: FileJob[] = [];
    let next: string | undefined = first;
    const visited = new Set<string>();
    while (next) {
      const url = new URL(next, origin);
      if (visited.has(url.href)) throw new Error('Invalid job pagination');
      visited.add(url.href);
      const current = await page(oid, next);
      rows.push(...current.rows);
      next = current.next;
    }
    return rows;
  }
  return {
    async create(oid: string, item: { id: string; filename: string; blob_key: string; parent_job_id?: string }) {
      await request(oid, '/api/FileJob', 'POST', item);
    },
    async get(oid: string, id: string, signal?: AbortSignal): Promise<FileJob | undefined> {
      const response = await request(oid, `/api/FileJob?$filter=id eq ${id}`, 'GET', undefined, signal);
      const body = await response.json() as { value: unknown[] };
      if (!Array.isArray(body.value)) throw new Error('Invalid job response');
      return body.value[0] === undefined ? undefined : fileJobSchema.parse(body.value[0]);
    },
    async list(oid: string): Promise<FileJob[]> {
      const activeQuery = new URLSearchParams({
        '$filter': "status eq 'queued' or status eq 'processing'",
        '$orderby': 'created_at desc',
      });
      const terminalQuery = new URLSearchParams({
        '$filter': "status eq 'completed' or status eq 'failed'",
        '$orderby': 'created_at desc',
        '$first': '100',
      });
      const active = await allPages(oid, `/api/FileJob?${activeQuery}`);
      const terminal = await page(oid, `/api/FileJob?${terminalQuery}`);
      return [...new Map([...active, ...terminal.rows].map(job => [job.id, job])).values()];
    },
    async listAll(oid: string): Promise<FileJob[]> {
      return allPages(oid, '/api/FileJob');
    },
    async update(oid: string, id: string, changes: object, signal?: AbortSignal) {
      await request(oid, `/api/FileJob/id/${encodeURIComponent(id)}`, 'PATCH',
        { ...changes, updated_at: new Date().toISOString() }, signal);
    },
    async delete(oid: string, id: string, signal?: AbortSignal) {
      await request(oid, `/api/FileJob/id/${encodeURIComponent(id)}`, 'DELETE', undefined, signal);
    },
  };
}
