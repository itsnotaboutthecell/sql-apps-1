import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { ApplicationError, type ApplicationDefinition, type ApplicationServices, type ProcedureParameters } from '../../src/application.js';
import { identifier, itemSchema, createSchema, updateSchema } from './contract.js';
const result = z.array(z.strictObject({
  outcome: z.enum(['ok', 'expired', 'not_found', 'quota', 'rate_limited']),
  id: identifier.nullable(), title: z.string().nullable(), completed: z.boolean().nullable(),
})).min(1);
const errors = {
  expired: [401, 'Visitor session expired; start a new synthetic session'],
  not_found: [404, 'Item not found in this visitor session'],
  quota: [409, 'This visitor session already has 50 items'],
  rate_limited: [429, 'This visitor session allows 30 mutations per minute'],
} as const;

async function execute(services: ApplicationServices, request: FastifyRequest, name: string, parameters: ProcedureParameters = {}) {
  const tokenHash = await services.subject(request);
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new ApplicationError(500, 'Invalid server-resolved session');
  const parsed = result.safeParse(await services.execute(name, { ...parameters, token_hash: tokenHash }));
  if (!parsed.success) throw new ApplicationError(502, 'Invalid application procedure result');
  const first = parsed.data[0]!;
  if (first.outcome !== 'ok') {
    if (parsed.data.length !== 1 || first.id !== null || first.title !== null || first.completed !== null) {
      throw new ApplicationError(502, 'Invalid application error result');
    }
    const [status, message] = errors[first.outcome];
    throw new ApplicationError(status, message);
  }
  if (parsed.data.some(row => row.outcome !== 'ok')) throw new ApplicationError(502, 'Inconsistent application procedure result');
  return parsed.data;
}

function item(value: unknown) {
  const parsed = itemSchema.safeParse(value);
  if (!parsed.success) throw new ApplicationError(502, 'Invalid application item');
  return { ...parsed.data, id: parsed.data.id.toLowerCase() };
}
function parameters(request: FastifyRequest): string {
  const parsed = z.strictObject({ id: identifier }).safeParse(request.params);
  if (!parsed.success) throw new ApplicationError(400, 'A valid item id is required');
  return parsed.data.id;
}

export const application: ApplicationDefinition = {
  name: 'todo',
  capabilities: ['data', 'visitor-sessions'],
  profiles: ['local-simulation', 'public-demo'],
  routes: [
    { method: 'GET', path: '/api/todos' },
    { method: 'POST', path: '/api/todos' },
    { method: 'PATCH', path: '/api/todos/:id' },
    { method: 'DELETE', path: '/api/todos/:id' },
  ],
  inputs: {
    browser: 'web/app.ts', html: 'web/index.html', css: 'web/app.css',
    sqlProject: 'demo/database.sqlproj',
    sqlFiles: ['demo/schema.sql', 'demo/procedures.sql', 'demo/post-deploy.sql'],
    grants: 'demo/grants.sql', dab: 'demo/dab-config.json',
    publicAcceptance: 'tests/public-acceptance.ts',
  },
  procedures: ['CreateSession', 'GetSession', 'DeleteSession', 'Readiness', 'List', 'Create', 'Update', 'Delete'],
  sessions: { create: 'CreateSession', get: 'GetSession', delete: 'DeleteSession', ready: 'Readiness' },
  limits: {
    sessionMinutes: 60, itemLimit: 50, titleLimit: 200,
    mutationsPerMinute: 30, globalMutationsPerMinute: 300, globalSessionLimit: 1000,
  },
  async register(app, services) {
    app.get('/api/todos', async request => {
      if (!z.strictObject({}).safeParse(request.query).success) throw new ApplicationError(400, 'Item list does not accept owner or query fields');
      const rows = await execute(services, request, 'List');
      if (rows.length === 1 && rows[0]!.id === null && rows[0]!.title === null && rows[0]!.completed === null) return { items: [] };
      return { items: rows.map(({ id, title, completed }) => item({ id, title, completed })) };
    });
    app.post('/api/todos', async (request, reply) => {
      const body = createSchema.safeParse(request.body);
      if (!body.success) throw new ApplicationError(400, 'Only a title of 1 to 200 UTF-16 code units is accepted');
      const rows = await execute(services, request, 'Create', { title: body.data.title });
      if (rows.length !== 1) throw new ApplicationError(502, 'Invalid created item result');
      const { id, title: createdTitle, completed } = rows[0]!;
      return reply.code(201).send(item({ id, title: createdTitle, completed }));
    });
    app.patch('/api/todos/:id', async request => {
      const id = parameters(request);
      const body = updateSchema.safeParse(request.body);
      if (!body.success) throw new ApplicationError(400, 'Change only a title of 1 to 200 UTF-16 code units or a completion flag');
      const rows = await execute(services, request, 'Update', {
        id, title: body.data.title ?? null, completed: body.data.completed ?? null,
      });
      if (rows.length !== 1) throw new ApplicationError(502, 'Invalid updated item result');
      const { id: updatedId, title: updatedTitle, completed } = rows[0]!;
      if (updatedId?.toLowerCase() !== id.toLowerCase()) throw new ApplicationError(502, 'Updated item id mismatch');
      return item({ id: updatedId, title: updatedTitle, completed });
    });
    app.delete('/api/todos/:id', async (request, reply) => {
      const id = parameters(request);
      if (request.body !== undefined) throw new ApplicationError(400, 'Delete accepts no owner fields or body');
      const rows = await execute(services, request, 'Delete', { id });
      if (rows.length !== 1) throw new ApplicationError(502, 'Invalid deleted item result');
      const { id: deletedId, title, completed } = rows[0]!;
      if (item({ id: deletedId, title, completed }).id !== id.toLowerCase()) {
        throw new ApplicationError(502, 'Deleted item id mismatch');
      }
      return reply.code(204).send();
    });
  },
};
