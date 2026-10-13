import { z } from 'zod';
import { ApiError, SqlAppsClient } from './client.js';
import { developmentUsers, localAppOrigin } from './local-app.js';
import type { RoleBasedProfile } from './role-based-profile.js';

export async function testLocalApp(profile: RoleBasedProfile, fetcher: typeof fetch = fetch): Promise<void> {
  const tokens: string[] = [];
  const failures: unknown[] = [];
  try {
    for (const [index, user] of developmentUsers.entries()) {
      const response = await fetcher(`${localAppOrigin}/local/session`, {
        method: 'POST', headers: { origin: localAppOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ user: user.id }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Local session setup failed (${response.status})`);
      const { token } = z.object({ token: z.string().min(32) }).parse(await response.json());
      tokens.push(token);
      const client = new SqlAppsClient({ baseUrl: localAppOrigin, getAccessToken: async () => token, fetch: fetcher });
      const identity = z.object({ oid: z.string() }).parse(await (await client.request('/auth/me')).json());
      if (identity.oid !== user.id) throw new Error('Gateway assigned the wrong development identity');
      const status = await client.readiness(profile.readinessPath).then(() => 200,
        (error: unknown) => { if (error instanceof ApiError) return error.status; throw error; });
      const expected = index === 0 ? 200 : 403;
      if (status !== expected) throw new Error(`${profile.readinessPath} returned ${status} for ${user.name}; expected ${expected}`);
    }
    if ((await fetcher(`${localAppOrigin}/auth/me`)).status !== 401) throw new Error('Gateway accepted anonymous access');
    if ((await fetcher(`${localAppOrigin}${profile.readinessPath}`)).status !== 401) throw new Error('Gateway served data anonymously');
  } catch (error) { failures.push(error); }
  finally {
    for (const token of tokens) {
      try {
        const response = await fetcher(`${localAppOrigin}/local/session`, {
          method: 'DELETE', headers: { origin: localAppOrigin, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Local session cleanup failed (${response.status})`);
      } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Local gateway acceptance or cleanup failed');
}
