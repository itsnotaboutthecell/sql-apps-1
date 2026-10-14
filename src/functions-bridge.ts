import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface BridgeRequest {
  method: string;
  url: string;
  headers: Headers;
  body?: string | undefined;
}

const platformHeaders = new Set(['x-ms-client-principal', 'x-ms-api-role']);

export async function bridgeRequest(app: FastifyInstance, request: BridgeRequest): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!platformHeaders.has(name.toLowerCase())) headers[name] = value;
  });
  const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).parse(request.method);
  const response = await app.inject({
    method,
    url: `${url.pathname}${url.search}`,
    headers,
    ...(request.body === undefined ? {} : { payload: request.body }),
  });
  const outgoing = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) outgoing.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return new Response(response.payload, { status: response.statusCode, headers: outgoing });
}
