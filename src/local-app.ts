import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { bearerToken, entraVerifier, type VerifyUser } from './auth.js';
import type { JWTVerifyGetKey } from 'jose';
import { readLocalAuthentication, type LocalAuthentication } from './local-auth.mjs';
import { authRedirectPath } from './browser-config.js';
import { createGateway } from './gateway.js';
import { localOrigin, localPrincipal } from './local.js';
import { runtimeFor } from './workspace.mjs';
import type { RoleBasedProfile } from './role-based-profile.js';
import { probeReadiness } from './readiness.js';
import { projectPath } from './runtime-roots.js';

export const localAppOrigin = runtimeFor().origins.app;
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const developmentUsers = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Development Alice' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Development Bob' },
];

export async function createLocalApp(fetcher: typeof fetch, authorized: RoleBasedProfile,
  container = runtimeFor().defaultSql, authentication: LocalAuthentication = readLocalAuthentication(), entraKey?: JWTVerifyGetKey) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local development server is disabled in production');
  const provenance = z.object({ version: z.literal(2), home: z.literal(runtimeFor().home),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    toolingFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .passthrough()
    .parse(JSON.parse(await readFile(projectPath('dist', 'build-provenance.json'), 'utf8')));
  const sessions = new Map<string, { oid: string; expires: number }>();
  const previewIdentity = async (token: string) => {
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(token);
      throw new Error('Local session expired; select a development user again');
    }
    return { oid: session.oid, tenantId,
      roles: session.oid === developmentUsers[0]!.id ? [authorized.requiredRole] : [] };
  };
  const identity: VerifyUser = authentication.mode === 'entra'
    ? entraVerifier(authentication.tenantId, authentication.clientId, entraKey) : previewIdentity;
  const gatewayTenant = authentication.mode === 'entra' ? authentication.tenantId : tenantId;
  const gatewayClient = authentication.mode === 'entra' ? authentication.clientId : tenantId;
  const ready = async (): Promise<void> => {
    const signal = AbortSignal.timeout(4_000);
    await probeReadiness('data', async () => {
      const role = authorized.requiredRole;
      const response = await fetcher(new URL(authorized.readinessPath, localOrigin), {
        headers: { 'x-ms-client-principal': localPrincipal(developmentUsers[0]!.id, 'access_as_user', role),
          'x-ms-api-role': role },
        signal, redirect: 'error',
      });
      if (!response.ok) throw new Error(`Authorized data readiness returned HTTP ${response.status}`);
      await response.body?.cancel();
    });
  };
  const users = developmentUsers.map((user, index) => ({
    ...user, name: `${user.name} (${index === 0 ? 'simulated user with required role' : 'simulated user without required role'})`,
  }));
  const app = await createGateway({
    requiredRole: authorized.requiredRole, readinessPath: authorized.readinessPath,
    tenantId: gatewayTenant, apiClientId: gatewayClient, dabUrl: localOrigin,
    publicDirectory: projectPath('public'),
  }, {
    verifyUser: identity,
    ready,
    browserConfig: authentication.mode === 'entra' ? {
      mode: 'entra', tenantId: authentication.tenantId, clientId: authentication.clientId,
      scope: `api://${authentication.clientId}/access_as_user`, localBackend: true, readinessPath: authorized.readinessPath,
    } : { mode: 'local', readinessPath: authorized.readinessPath },
    requestGuard: async (request, reply) => {
      if (request.headers.host !== new URL(localAppOrigin).host) {
        return reply.code(403).send({ error: 'Use the loopback development origin' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== localAppOrigin) {
        return reply.code(403).send({ error: 'Local mutations require the same development origin' });
      }
    },
    fetch: async (url, options) => {
      const target = new URL(String(url));
      if (target.origin !== localOrigin) throw new Error('Local adapter only connects to the loopback data service');
      if (target.pathname === '/health') return fetcher(target, options);
      const headers = new Headers(options?.headers);
      const token = bearerToken(headers.get('authorization') ?? undefined);
      if (!token) throw new Error('Local data adapter requires a verified session');
      const user = await identity(token);
      headers.delete('authorization');
      headers.delete('x-ms-api-role');
      headers.set('x-ms-client-principal', localPrincipal(user.oid, 'access_as_user', authorized.requiredRole));
      headers.set('x-ms-api-role', authorized.requiredRole);
      return fetcher(target, { ...options, headers });
    },
  });
  app.get('/local/workspace', async () => {
    const runtime = runtimeFor();
    return { version: 1, id: runtime.id, mode: runtime.mode, origins: runtime.origins,
      container, sourceFingerprint: provenance.sourceFingerprint, authentication,
      profile: 'role-based-data' };
  });
  if (authentication.mode === 'preview') {
    app.get('/__dev/identity', async (_request, reply) => {
      reply.header('cache-control', 'no-store').type('text/html');
      return readFile(new URL('./web/developer.html', import.meta.url), 'utf8');
    });
    app.get('/__dev/identity.js', async (_request, reply) => {
      reply.header('cache-control', 'no-store').type('text/javascript');
      return readFile(new URL('./web/developer.bundle.js', import.meta.url), 'utf8');
    });
    app.get('/local/users', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { users };
    });
    app.post('/local/session', async (request, reply) => {
      const body = z.union([z.strictObject({ preview: z.literal(true) }), z.strictObject({ user: z.string() })])
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Choose local preview or a configured development user' });
      const selection = body.data;
      const user = 'preview' in selection ? developmentUsers[0] : developmentUsers.find(value => value.id === selection.user);
      if (!user) return reply.code(400).send({ error: 'Choose local preview or a configured development user' });
      const previous = bearerToken(request.headers.authorization);
      if (previous) sessions.delete(previous);
      for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
      if (sessions.size >= 1_000) return reply.code(429).send({ error: 'Too many local sessions; restart the development server' });
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { oid: user.id, expires: Date.now() + 8 * 60 * 60 * 1_000 });
      reply.header('cache-control', 'no-store');
      return { token };
    });
    app.delete('/local/session', async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (token) sessions.delete(token);
      return reply.code(204).send();
    });
  }
  app.addHook('onClose', async () => { sessions.clear(); });
  return app;
}

const readinessStatus = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.literal('not-ready'),
    dependency: z.enum(['data']).optional() }),
]);
const readinessPause = () => new Promise<void>(done => setTimeout(done, 1_000));
type LocalApp = Awaited<ReturnType<typeof createLocalApp>>;

export async function waitForLocalReadiness(app: LocalApp, pause = readinessPause): Promise<void> {
  let failedDependency = 'profile';
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await app.inject({ url: '/health/ready', headers: { host: new URL(localAppOrigin).host } });
    const body = readinessStatus.parse(response.json<unknown>());
    if (response.statusCode === 200 && body.status === 'ready') return;
    if (response.statusCode !== 503 || body.status !== 'not-ready') {
      throw new Error('Local readiness returned an unexpected HTTP status or response');
    }
    failedDependency = body.dependency ?? 'profile';
    if (attempt < 2) await pause();
  }
  throw new Error(`Local ${failedDependency} readiness failed after three read-only attempts. ` +
    'Inspect that dependency before an approved recovery command; no service reset or restart was performed.');
}

export async function startLocalGateway(app: LocalApp, container: string, pause = readinessPause): Promise<void> {
  try {
    await waitForLocalReadiness(app, pause);
    await app.listen({ host: '127.0.0.1', port: runtimeFor(container).ports.gateway });
    const response = await fetch(new URL('/health/ready', localAppOrigin),
      { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    const body = readinessStatus.parse(await response.json());
    if (response.status !== 200 || body.status !== 'ready') {
      const dependency = body.status === 'not-ready' ? body.dependency ?? 'profile' : 'profile';
      throw new Error(`Running local gateway ${dependency} readiness did not pass initial HTTP confirmation`);
    }
  } catch (cause) {
    try { await app.close(); }
    catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Initial local gateway readiness and cleanup failed; no ready URL is published');
    }
    throw new Error('Initial local gateway readiness failed; no ready URL is published', { cause });
  }
}

export async function serveLocalApp(container: string, authorized: RoleBasedProfile): Promise<void> {
  const authentication = readLocalAuthentication();
  const app = await createLocalApp(fetch, authorized, container, authentication);
  await startLocalGateway(app, container);
  console.log(`Local browser app ready at ${localAppOrigin}.`);
  console.log(authentication.mode === 'preview' ? 'Local preview identities are simulated; do not expose remotely.'
    : 'Microsoft Entra sign-in is verified; local DAB claims remain a development simulation.');
  if (authentication.mode === 'preview') console.log(`Developer identity testing: ${new URL('/__dev/identity', localAppOrigin).href}`);
  if (authentication.mode === 'entra') console.log(`Microsoft sign-in redirect URI: ${new URL(authRedirectPath, localAppOrigin).href}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close(); });
  }
}
