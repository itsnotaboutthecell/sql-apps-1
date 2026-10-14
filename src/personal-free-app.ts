import { z } from 'zod';
import { parseOwnerPrincipal } from './swa-principal.js';
import type { ProcedureDefinition } from './sql-procedure-runtime.js';

export interface PersonalFreeRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/${string}`;
  procedure: ProcedureDefinition;
}

export interface PersonalFreeRuntime {
  execute(
    ownerId: string,
    procedure: string,
    values: Record<string, string | boolean | number | null>,
  ): Promise<unknown[]>;
  ready(): Promise<void>;
}

export interface PersonalFreeRequest {
  method: string;
  url: string;
  headers: Headers;
  body?: unknown;
}

const scalar = z.union([z.string(), z.boolean(), z.number(), z.null()]);

export function createPersonalFreeHandler(routes: readonly PersonalFreeRoute[], runtime: PersonalFreeRuntime) {
  const routeMap = new Map(routes.map(route => [`${route.method} ${route.path}`, route]));
  if (routeMap.size !== routes.length) throw new Error('Personal-free routes must be unique');
  return async (request: PersonalFreeRequest): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/api/health/ready' && request.method === 'GET') {
      try {
        await runtime.ready();
        return Response.json({ status: 'ready' });
      } catch {
        return Response.json({ status: 'not-ready' }, { status: 503 });
      }
    }
    let principal;
    try {
      principal = parseOwnerPrincipal(request.headers.get('x-ms-client-principal'));
    } catch (error) {
      const forbidden = error instanceof Error && /owner role/i.test(error.message);
      return Response.json({ error: forbidden ? 'Owner role required' : 'Authentication required' },
        { status: forbidden ? 403 : 401 });
    }
    const route = routeMap.get(`${request.method} ${url.pathname}`);
    if (!route) return Response.json({ error: 'Route not found' }, { status: 404 });
    const candidate = request.method === 'GET'
      ? Object.fromEntries(url.searchParams.entries())
      : request.body ?? {};
    const parsed = z.record(z.string(), scalar).safeParse(candidate);
    if (!parsed.success) return Response.json({ error: 'Invalid procedure parameters' }, { status: 400 });
    try {
      const rows = await runtime.execute(principal.ownerId, route.procedure.name, parsed.data);
      return Response.json({ value: rows });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Procedure failed' }, { status: 500 });
    }
  };
}
