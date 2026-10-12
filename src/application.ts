import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';

export type ApplicationProfile = 'local-simulation' | 'public-demo';
export interface ApplicationRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}
export type ProcedureParameters = Record<string, string | boolean | null>;
export interface ApplicationLimits {
  sessionMinutes: number;
  itemLimit: number;
  titleLimit: number;
  mutationsPerMinute: number;
  globalMutationsPerMinute: number;
  globalSessionLimit: number;
}
export interface ApplicationServices {
  subject(request: FastifyRequest): Promise<string>;
  execute(name: string, parameters: ProcedureParameters): Promise<unknown>;
}
export interface ApplicationDefinition {
  name: string;
  capabilities: readonly string[];
  profiles: readonly ApplicationProfile[];
  routes: readonly ApplicationRoute[];
  inputs: {
    browser: string;
    html: string;
    css: string;
    sqlProject: string;
    sqlFiles: readonly string[];
    grants: string;
    dab: string;
    publicAcceptance: string;
  };
  procedures: readonly string[];
  sessions: { create: string; get: string; delete: string; ready: string };
  limits: ApplicationLimits;
  register(app: FastifyInstance, services: ApplicationServices): Promise<void>;
}
export interface ApplicationAdapter extends ApplicationServices {
  profile: ApplicationProfile;
  capabilities: readonly string[];
  register(app: FastifyInstance): Promise<void>;
  ready(): Promise<void>;
}
export class ApplicationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export async function composeApplication(
  definition: ApplicationDefinition, adapter: ApplicationAdapter, publicDirectory?: string,
): Promise<FastifyInstance> {
  if (!definition.profiles.includes(adapter.profile)) {
    throw new Error(`Selected application does not support profile ${adapter.profile}`);
  }
  for (const capability of definition.capabilities) {
    if (!adapter.capabilities.includes(capability)) throw new Error(`Selected application requires capability ${capability}`);
  }
  for (const route of definition.routes) {
    if (!route.path.startsWith('/api/')) {
      throw new Error(`Public application routes must start with /api/: ${route.method} ${route.path}`);
    }
  }
  const app = Fastify({
    bodyLimit: 4096, requestTimeout: 35_000, exposeHeadRoutes: false,
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie'], level: 'info' },
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof ApplicationError ? error.statusCode :
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ?
        error.statusCode : 500;
    request.log.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Application request failed');
    void reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Service operation failed' : error instanceof Error ? error.message : 'Invalid request',
      requestId: request.id,
    });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });
  try {
    await adapter.register(app);
    const captured: ApplicationRoute[] = [];
    await app.register(async routes => {
      routes.addHook('onRoute', route => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            throw new Error(`Selected application route contract includes unsupported method ${method}`);
          }
          captured.push({ method: method as ApplicationRoute['method'], path: route.url });
        }
      });
      await definition.register(routes, adapter);
    });
    const live = async () => ({ status: 'live' });
    const ready = async (_request: unknown, reply: { code(statusCode: number): { send(payload: unknown): unknown } }) => {
      try {
        await adapter.ready();
        return { status: 'ready', application: definition.name };
      } catch (error) {
        app.log.warn({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Selected application readiness failed');
        return reply.code(503).send({ status: 'not-ready', application: definition.name });
      }
    };
    app.get('/health/live', live);
    app.get('/health/ready', ready);
    app.get('/api/health/live', live);
    app.get('/api/health/ready', ready);
    app.get('/application/manifest', async () => ({
      version: 1, name: definition.name, capabilities: [...definition.capabilities].sort(), routes: definition.routes,
    }));
    if (publicDirectory) await app.register(fastifyStatic, { root: resolve(publicDirectory), prefix: '/' });
    await app.ready();
    const key = (route: ApplicationRoute) => `${route.method} ${route.path}`;
    const actual = captured.map(key).sort();
    const expected = definition.routes.map(key).sort();
    if (new Set(expected).size !== expected.length || actual.length !== expected.length ||
        actual.some((route, index) => route !== expected[index])) {
      throw new Error(`Selected application route contract mismatch: expected ${expected.join(', ')}; registered ${actual.join(', ')}`);
    }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
