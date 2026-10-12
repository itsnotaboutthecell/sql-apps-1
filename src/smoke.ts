import { randomUUID } from 'node:crypto';
import { SqlAppsClient, ApiError } from './client.js';
import { z } from 'zod';

const identitySchema = z.object({ oid: z.string().min(1), tenantId: z.string().min(1) });
const restPageSchema = z.object({
  value: z.array(z.object({ id: z.string(), owner_oid: z.string().optional(), blob_key: z.never().optional() })),
});
const graphqlPageSchema = z.object({
  errors: z.never().optional(),
  data: z.object({ fileJobs: z.object({ items: z.array(z.object({ id: z.string() })) }) }),
});

async function readData(api: SqlAppsClient, oid: string): Promise<void> {
  const rest = restPageSchema.parse(await (await api.request('/api/FileJob?$first=5')).json());
  if (rest.value.some(row => row.owner_oid !== undefined && row.owner_oid.toLowerCase() !== oid.toLowerCase())) {
    throw new Error('REST data path returned another user\'s row');
  }
  graphqlPageSchema.parse(await (await api.request('/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ fileJobs(first: 5) { items { id filename status } } }' }),
  })).json());
}

export async function smoke(
  origin: string, userToken: string, otherUserToken: string, fetcher: typeof fetch = fetch, functionsUrl?: string,
): Promise<void> {
  const user = new SqlAppsClient({ baseUrl: origin, getAccessToken: async () => userToken, fetch: fetcher });
  const other = new SqlAppsClient({ baseUrl: origin, getAccessToken: async () => otherUserToken, fetch: fetcher });
  const who = identitySchema.parse(await (await user.request('/auth/me')).json());
  const otherWho = identitySchema.parse(await (await other.request('/auth/me')).json());
  if (who.oid === otherWho.oid || who.tenantId !== otherWho.tenantId) throw new Error('Two different verified users in the configured tenant are required');
  const id = randomUUID();
  const filename = `acceptance-${id}.txt`;
  let uploaded = false;
  const failures: unknown[] = [];
  try {
    await readData(user, who.oid);
    await readData(other, otherWho.oid);
    await user.upload(filename, Buffer.from('private acceptance data'));
    uploaded = true;
    if (Buffer.from(await user.download(filename)).toString() !== 'private acceptance data') throw new Error('File roundtrip payload mismatch');
    for (const operation of [() => other.download(filename), () => other.deleteFile(filename)]) {
      await assertDenied(operation);
    }
    const result = z.object({ result: z.object({ user: identitySchema, input: z.object({ acceptance: z.string() }) }) })
      .parse(await user.echo({ acceptance: id }));
    if (result.result.user.oid !== who.oid || result.result.user.tenantId !== who.tenantId || result.result.input.acceptance !== id) {
      throw new Error('Function user context or payload mismatch');
    }
    if (functionsUrl) {
      const direct = await fetcher(new URL('/api/echo', functionsUrl), {
        method: 'POST', headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(10_000),
      });
      if (direct.status !== 401) throw new Error('Direct function user-token access was not rejected');
    }
    if ((await fetcher(new URL('/auth/me', origin))).status !== 401) throw new Error('Anonymous API access was not rejected');
    for (const path of ['/api/FileJob', '/graphql']) {
      const anonymous = await fetcher(new URL(path, origin), {
        method: path === '/graphql' ? 'POST' : 'GET',
        ...(path === '/graphql' ? { headers: { 'content-type': 'application/json' }, body: '{"query":"{ fileJobs { items { id } } }"}' } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (![401, 403].includes(anonymous.status)) throw new Error(`Anonymous ${path} request returned ${anonymous.status}`);
    }
  } catch (error) { failures.push(error); }
  finally {
    if (uploaded) {
      try { await user.deleteFile(filename); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Authenticated acceptance or fixture cleanup failed');
}

async function assertDenied(operation: () => Promise<unknown>) {
  try { await operation(); }
  catch (error) { if (error instanceof ApiError && [403, 404].includes(error.status)) return; throw error; }
  throw new Error('Cross-user operation unexpectedly succeeded');
}
