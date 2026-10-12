import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApplicationError, composeApplication, type ApplicationAdapter, type ApplicationDefinition,
  type ApplicationProfile, type ProcedureParameters } from './application.js';
import { newSessionToken, readSession, sessionCookie, sessionCookieName, sessionHash, sessionMinutes, sessionToken } from './demo-session.js';

export interface DemoOptions {
  profile: ApplicationProfile;
  origin: string;
  dabUrl: string;
  transport?: 'direct' | 'static-web-apps';
  publicDirectory?: string;
}

export async function createDemoApplication(
  definition: ApplicationDefinition, options: DemoOptions, fetcher: typeof fetch = fetch,
): Promise<FastifyInstance> {
  const origin = new URL(options.origin);
  const data = new URL(options.dabUrl);
  const secure = options.profile === 'public-demo';
  const transport = options.transport ?? 'direct';
  if (origin.origin !== options.origin || origin.username || origin.password ||
      (secure ? origin.protocol !== 'https:' : origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1')) {
    throw new Error('Public demo requires an HTTPS origin; local test transport requires an exact loopback HTTP origin');
  }
  if (!secure && process.env.NODE_ENV === 'production') throw new Error('Local test transport is disabled in production');
  if (data.protocol !== 'http:' || data.hostname !== '127.0.0.1' || data.username || data.password ||
      data.pathname !== '/' || data.search || data.hash) {
    throw new Error('Demo data service must be an internal loopback HTTP origin, never a public proxy');
  }
  const cookieName = sessionCookieName(options.origin, secure);
  if (definition.limits.sessionMinutes !== sessionMinutes) {
    throw new Error(`Selected application session lifetime (${definition.limits.sessionMinutes} minutes) does not match the issued session cookie lifetime (${sessionMinutes} minutes)`);
  }
  const allowed = new Set(definition.procedures);
  for (const name of [...allowed, ...Object.values(definition.sessions)]) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !allowed.has(name)) throw new Error('Invalid selected procedure allowlist');
  }
  const execute = async (name: string, parameters: ProcedureParameters): Promise<unknown> => {
    if (!allowed.has(name)) throw new ApplicationError(500, 'Procedure is not part of this application');
    let response: Response;
    try {
      response = await fetcher(new URL(`/api/${name}`, data), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch (error) {
      throw new ApplicationError(503, error instanceof Error ? `Data service unavailable (${error.name})` : 'Data service unavailable');
    }
    if (!response.ok) throw new ApplicationError(503, `Data procedure returned HTTP ${response.status}`);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new ApplicationError(502, 'Data procedure did not return JSON'); }
    const envelope = z.object({ value: z.array(z.unknown()) }).safeParse(value);
    if (!envelope.success) throw new ApplicationError(502, 'Data procedure returned an invalid envelope');
    return envelope.data.value;
  };
  const adapter: ApplicationAdapter = {
    profile: options.profile, capabilities: ['data', 'visitor-sessions'], execute,
    async subject(request) {
      const token = sessionToken(request, cookieName);
      if (!token) throw new ApplicationError(401, 'Start a synthetic visitor session first');
      const hash = sessionHash(token);
      if (!await readSession(adapter, definition.sessions.get, hash)) {
        throw new ApplicationError(401, 'Visitor session expired; start a new synthetic session');
      }
      return hash;
    },
    async ready() {
      const parsed = z.array(z.strictObject({ status: z.literal('ready'), schema_version: z.literal(1) })).length(1)
        .safeParse(await execute(definition.sessions.ready, {}));
      if (!parsed.success) throw new ApplicationError(503, 'Selected SQL procedure readiness failed');
    },
    async register(app) {
      app.addHook('onRequest', async (request, reply) => {
        if (['/health/live', '/health/ready', '/api/health/live', '/api/health/ready']
          .includes(request.url.split('?')[0]!)) return;
        if ((transport === 'direct' && request.headers.host !== origin.host) ||
            request.headers['x-ms-client-principal'] !== undefined ||
            request.headers['x-ms-api-role'] !== undefined ||
            (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== options.origin)) {
          return reply.code(403).send({ error: 'Use this application origin without submitted identities or roles' });
        }
      });
      app.get('/api/application/config', async () => ({
        profile: options.profile, syntheticDataOnly: true,
        sessionMinutes: definition.limits.sessionMinutes,
        itemLimit: definition.limits.itemLimit, titleLimit: definition.limits.titleLimit,
        mutationsPerMinute: definition.limits.mutationsPerMinute,
        globalSessionLimit: definition.limits.globalSessionLimit,
        globalMutationsPerMinute: definition.limits.globalMutationsPerMinute,
      }));
      app.post('/api/session', async (request, reply) => {
        if (!z.strictObject({ synthetic: z.literal(true) }).safeParse(request.body).success) {
          throw new ApplicationError(400, 'Explicitly acknowledge synthetic data only');
        }
        const existing = sessionToken(request, cookieName);
        if (existing) {
          const session = await readSession(adapter, definition.sessions.get, sessionHash(existing));
          if (session) return session;
        }
        const token = newSessionToken();
        const created = await readSession(adapter, definition.sessions.create, sessionHash(token));
        if (!created) throw new ApplicationError(503, 'Session creation did not produce a live session');
        reply.header('set-cookie', sessionCookie(cookieName, token, secure));
        return reply.code(201).send(created);
      });
      app.get('/api/session', async request => {
        const token = sessionToken(request, cookieName);
        if (!token) throw new ApplicationError(401, 'No visitor session');
        const session = await readSession(adapter, definition.sessions.get, sessionHash(token));
        if (!session) throw new ApplicationError(401, 'Visitor session expired');
        return session;
      });
      app.delete('/api/session', async (request, reply) => {
        const token = sessionToken(request, cookieName);
        if (token) {
          await readSession(adapter, definition.sessions.delete, sessionHash(token));
        }
        reply.header('set-cookie', sessionCookie(cookieName, '', secure, true));
        return reply.code(204).send();
      });
    },
  };
  return composeApplication(definition, adapter, options.publicDirectory);
}
