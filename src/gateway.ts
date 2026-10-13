import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { bearerToken, type VerifyUser, type UserIdentity } from './auth.js';
import { accessFor } from './access.js';
import type { RuntimeConfig } from './config.js';
import type { BrowserConfig } from './browser-config.js';
import { DependencyReadinessError } from './readiness.js';

export interface GatewayDependencies {
  verifyUser: VerifyUser;
  fetch: typeof fetch;
  browserConfig?: BrowserConfig;
  requestGuard?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  ready?: () => Promise<void>;
}

interface AuthenticatedRequest extends FastifyRequest {
  identity: UserIdentity | null;
  accessToken: string | null;
}

export async function createGateway(config: RuntimeConfig, dependencies: GatewayDependencies) {
  const { requiredRole } = config;
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie'], level: 'info' },
    requestTimeout: 35_000,
  });
  app.decorateRequest('identity', null);
  app.decorateRequest('accessToken', null);
  if (dependencies.requestGuard) app.addHook('onRequest', dependencies.requestGuard);
  app.setErrorHandler((error, request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error &&
      typeof error.statusCode === 'number' ? error.statusCode : 500;
    request.log.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    void reply.code(status).send({
      error: status >= 500 ? 'Service operation failed' : error instanceof Error ? error.message : 'Invalid request',
      requestId: request.id,
    });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://login.microsoftonline.com; frame-src 'self' https://login.microsoftonline.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  });
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (dependencies.ready) {
        await dependencies.ready();
        return { status: 'ready' };
      }
      const response = await dependencies.fetch(new URL('/health', config.dabUrl), { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return reply.code(503).send({ status: 'not-ready' });
      return { status: 'ready' };
    } catch (error) {
      const dependency = error instanceof DependencyReadinessError ? error.dependency : undefined;
      app.log.warn({ errorType: error instanceof Error ? error.name : 'UnknownError',
        ...(dependency ? { dependency } : {}) }, 'Dependency readiness check failed');
      return reply.code(503).send({ status: 'not-ready', ...(dependency ? { dependency } : {}) });
    }
  });
  app.get('/auth/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return dependencies.browserConfig ?? {
      mode: 'entra',
      tenantId: config.tenantId,
      clientId: config.apiClientId,
      scope: `api://${config.apiClientId}/access_as_user`,
      readinessPath: config.readinessPath,
    };
  });
  await app.register(async protectedRoutes => {
    protectedRoutes.addHook('onRequest', async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ error: 'Bearer access token required' });
      let identity: UserIdentity;
      try {
        identity = await dependencies.verifyUser(token);
      } catch (error) {
        request.log.warn({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Access token rejected');
        return reply.code(401).send({ error: 'Invalid access token' });
      }
      const authenticated = request as AuthenticatedRequest;
      authenticated.identity = identity;
      authenticated.accessToken = token;
      if (request.routeOptions.url !== '/auth/me' && !accessFor(identity, requiredRole).allowed) {
        return reply.code(403).send({ error: 'Authorized role required' });
      }
    });
    protectedRoutes.addHook('onSend', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
    });
    protectedRoutes.get('/auth/me', async request => {
      const identity = (request as AuthenticatedRequest).identity!;
      return { ...identity, access: accessFor(identity, requiredRole) };
    });
    protectedRoutes.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/*',
      handler: proxyData,
    });
    protectedRoutes.post('/graphql', proxyData);
    async function proxyData(request: FastifyRequest, reply: import('fastify').FastifyReply) {
      const url = new URL(config.dabUrl);
      const incoming = new URL(request.raw.url ?? '/', 'http://gateway.invalid');
      url.pathname = incoming.pathname;
      url.search = incoming.search;
      const headers = new Headers({ authorization: `Bearer ${(request as AuthenticatedRequest).accessToken}` });
      if (request.headers['if-match'] === '*') headers.set('if-match', '*');
      headers.set('x-ms-api-role', requiredRole);
      if (request.body !== undefined) headers.set('content-type', 'application/json');
      const response = await dependencies.fetch(url, {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      reply.code(response.status);
      reply.header('content-type', response.headers.get('content-type') ?? 'application/json');
      return reply.send(response.body ?? undefined);
    }
  });
  await app.register(fastifyStatic, { root: resolve(config.publicDirectory), index: ['index.html'] });
  return app;
}
