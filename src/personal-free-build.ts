import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { toolingRoot } from './runtime-roots.js';

const parameterType = z.enum(['nvarchar', 'uniqueidentifier', 'bit', 'int', 'datetime2']);
const routeSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/api\/[A-Za-z][A-Za-z0-9_/-]*$/),
  procedure: z.strictObject({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
    parameters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), parameterType),
  }),
});
const apiSchema = z.strictObject({
  version: z.literal(1),
  authenticationProvider: z.enum(['aad', 'github', 'google']),
  routes: z.array(routeSchema).min(1).superRefine((routes, context) => {
    const routeKeys = new Set<string>();
    const procedures = new Set<string>();
    for (const [index, route] of routes.entries()) {
      const key = `${route.method} ${route.path}`;
      if (routeKeys.has(key)) {
        context.addIssue({ code: 'custom', path: [index], message: `Duplicate personal-free route: ${key}` });
      }
      routeKeys.add(key);
      if (procedures.has(route.procedure.name)) {
        context.addIssue({
          code: 'custom', path: [index, 'procedure', 'name'],
          message: `Duplicate personal-free procedure: ${route.procedure.name}`,
        });
      }
      procedures.add(route.procedure.name);
    }
  }),
});

export interface PersonalFreeBuildManifest {
  version: 1;
  sourceHash: string;
  files: { path: string; sha256: string }[];
}

async function files(directory: string, base = directory): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Personal-free build inputs must not contain symbolic links');
    if (entry.isDirectory()) output.push(...await files(path, base));
    else if (entry.isFile()) output.push(path.slice(base.length + 1).replaceAll('\\', '/'));
  }
  return output.sort();
}

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export async function buildPersonalFreeArtifact(root: string, destination: string): Promise<PersonalFreeBuildManifest> {
  root = resolve(root);
  destination = resolve(destination);
  const api = apiSchema.parse(JSON.parse(await readFile(join(root, 'personal-free-api.json'), 'utf8')));
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, 'static'), { recursive: true });
  await mkdir(join(temporary, 'api', 'dist'), { recursive: true });
  let published = false;
  try {
    for (const name of ['index.html', 'style.css', 'app.js', 'staticwebapp.config.json']) {
      const source = join(root, 'public', name);
      if (!(await stat(source)).isFile()) throw new Error(`Personal-free static input is not a file: ${name}`);
      await copyFile(source, join(temporary, 'static', name));
    }
    const readinessPath = api.routes.find(route => route.method === 'GET')?.path;
    if (!readinessPath) throw new Error('Personal-free API requires at least one GET route for readiness');
    await writeFile(join(temporary, 'static', 'auth-config.json'), `${JSON.stringify({
      mode: 'static-web-apps',
      provider: api.authenticationProvider,
      readinessPath,
    })}\n`);
    for (const name of ['personal-free-app.js', 'swa-principal.js', 'sql-procedure-runtime.js']) {
      await copyFile(join(toolingRoot, 'dist', 'src', name), join(temporary, 'api', 'dist', name));
    }
    const entry = `import { app } from '@azure/functions';
import { createPersonalFreeHandler, parsePersonalFreeBody } from './personal-free-app.js';
import { createProcedureRuntime } from './sql-procedure-runtime.js';
const routes = ${JSON.stringify(api.routes)};
const runtime = createProcedureRuntime(process.env, routes.map(route => route.procedure));
const handler = createPersonalFreeHandler(routes, runtime);
app.http('sqlAppsApi', {
  route: '{*path}',
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  authLevel: 'anonymous',
  handler: async request => {
    let body;
    if (!['GET','HEAD'].includes(request.method)) {
      const text = await request.text();
      try {
        body = text ? parsePersonalFreeBody(text) : undefined;
      } catch (error) {
        if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) {
          return { status: 400, jsonBody: { error: error.message } };
        }
        throw error;
      }
    }
    const response = await handler({ method: request.method, url: request.url, headers: request.headers, body });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
  },
});\n`;
    await writeFile(join(temporary, 'api', 'dist', 'index.mjs'), entry);
    await writeFile(join(temporary, 'api', 'host.json'), `${JSON.stringify({
      version: '2.0',
      extensionBundle: { id: 'Microsoft.Azure.Functions.ExtensionBundle', version: '[4.*, 5.0.0)' },
    }, null, 2)}\n`);
    await writeFile(join(temporary, 'api', 'package.json'), `${JSON.stringify({
      name: 'sql-apps-personal-free-api',
      private: true,
      type: 'module',
      main: 'dist/index.mjs',
      engines: { node: '22' },
      dependencies: {
        '@azure/functions': '4.16.5',
        mssql: '12.7.0',
        zod: '4.6.5',
      },
    }, null, 2)}\n`);
    const delivered = await files(temporary);
    const snapshots = await Promise.all(delivered.map(async path => ({
      path,
      sha256: digest(await readFile(join(temporary, path))),
    })));
    const manifest: PersonalFreeBuildManifest = {
      version: 1,
      sourceHash: digest(JSON.stringify({ api, snapshots })),
      files: snapshots,
    };
    await writeFile(join(temporary, 'personal-free-build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    published = true;
    return manifest;
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}
