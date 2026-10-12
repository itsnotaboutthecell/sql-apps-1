import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  DemoInfrastructure, DemoPinnedImages, DemoPublicationConfig, DemoPublicationPlanningInput,
} from './demo-publication.js';
import type { Run } from './process.js';

export const demoRuntimeOutputSchema = z.strictObject({
  applicationId: z.string().startsWith('/subscriptions/'),
  publicUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  backendUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  staticWebAppName: z.string().min(1),
});
export const demoRuntimeSchema = demoRuntimeOutputSchema.extend({
  staticWebAppId: z.string().startsWith('/subscriptions/'),
});
export type DemoRuntime = z.infer<typeof demoRuntimeSchema>;

export function demoRuntimeParameters(
  config: DemoPublicationConfig,
  infrastructure: DemoInfrastructure,
  pinnedImages: DemoPinnedImages,
  securityPosture: DemoPublicationPlanningInput['securityPosture'],
) {
  return {
    applicationName: config.applicationName,
    selectedApplication: config.selectedApplication,
    deploymentId: config.deploymentId,
    location: config.location,
    staticWebAppLocation: config.staticWebAppLocation,
    tags: config.tags,
    environmentName: infrastructure.environmentName,
    runtimeIdentityName: infrastructure.runtimeIdentityName,
    registryName: infrastructure.registryName,
    sqlServerName: infrastructure.sqlServerName,
    databaseName: infrastructure.databaseName,
    staticWebAppName: config.staticWebAppName,
    gatewayImage: pinnedImages.gatewayImage,
    dabImage: pinnedImages.dabImage,
    securityPosture,
  };
}

function deploymentOutputs(text: string) {
  const envelope = z.record(z.string(), z.object({ value: z.unknown() })).parse(JSON.parse(text));
  return demoRuntimeOutputSchema.parse(
    Object.fromEntries(Object.entries(envelope).map(([key, item]) => [key, item.value])),
  );
}

export async function deployDemoRuntime(
  config: DemoPublicationConfig,
  infrastructure: DemoInfrastructure,
  pinnedImages: DemoPinnedImages,
  securityPosture: DemoPublicationPlanningInput['securityPosture'],
  runner: Run,
  createParameterFile: (parameters: Record<string, unknown>) => Promise<string>,
): Promise<DemoRuntime> {
  const parameters = demoRuntimeParameters(config, infrastructure, pinnedImages, securityPosture);
  const deployed = deploymentOutputs(await runner('az', ['deployment', 'group', 'create',
    '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
    '--name', `${config.name}-${config.deploymentId.slice(0, 8)}-runtime`,
    '--template-file', 'infra/demo-runtime.bicep',
    '--parameters', `@${await createParameterFile(parameters)}`,
    '--query', 'properties.outputs', '-o', 'json',
  ]));
  const runtime = demoRuntimeSchema.parse({
    ...deployed,
    staticWebAppId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}` +
      `/providers/Microsoft.Web/staticSites/${deployed.staticWebAppName}`,
  });
  if (runtime.staticWebAppName !== config.staticWebAppName) {
    throw new Error('Runtime output selected another Static Web App');
  }
  return runtime;
}

async function waitForBackend(runtime: DemoRuntime, fetcher: typeof fetch) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetcher(new URL('/api/health/ready', runtime.publicUrl),
        { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (response.ok) break;
      if (![502, 503, 504].includes(response.status)) throw new Error(`Backend readiness returned ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Backend readiness returned')) throw error;
      if (attempt === 11) throw new Error('Backend readiness did not become reachable');
    }
    if (attempt === 11) throw new Error('Backend readiness did not pass');
    await new Promise(done => setTimeout(done, 5_000));
  }
  const denied = await fetcher(new URL('/api/session', runtime.backendUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://direct.invalid' },
    body: JSON.stringify({ synthetic: true }), signal: AbortSignal.timeout(5_000), redirect: 'error',
  });
  if (![401, 403].includes(denied.status)) throw new Error(`Direct backend API was not denied (${denied.status})`);
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function verifyStaticContent(runtime: DemoRuntime, artifact: string, fetcher: typeof fetch) {
  const expected = hash(await readFile(join(resolve(artifact), 'static', 'app.js')));
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const url = new URL('/app.js', runtime.publicUrl);
      url.searchParams.set('sql-apps-verify', expected);
      const response = await fetcher(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (response.ok && hash(Buffer.from(await response.arrayBuffer())) === expected) return;
      if (![404, 502, 503, 504].includes(response.status)) {
        throw new Error(`Static content verification returned ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Static content verification returned')) throw error;
      if (attempt === 11) throw new Error('Static content did not become reachable');
    }
    if (attempt === 11) throw new Error('Static content did not match the reviewed artifact');
    await new Promise(done => setTimeout(done, 5_000));
  }
}

export async function verifyDemoRuntime(
  runtime: DemoRuntime, fetcher: typeof fetch, artifact?: string,
): Promise<void> {
  if (artifact === undefined) await waitForBackend(runtime, fetcher);
  else await verifyStaticContent(runtime, artifact, fetcher);
}

export async function acceptDemoRuntime(
  runtime: DemoRuntime, artifact: string, fetcher: typeof fetch,
): Promise<void> {
  const origin = new URL(runtime.publicUrl).origin;
  const request = (path: string, init: RequestInit = {}) => fetcher(new URL(path, origin), {
    ...init, headers: { origin, ...init.headers }, signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  const home = await request('/');
  if (!home.ok) throw new Error(`Static application returned ${home.status}`);
  const started = await request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ synthetic: true }),
  });
  if (started.status !== 201) throw new Error(`Public session creation returned ${started.status}`);
  const setCookie = started.headers.get('set-cookie');
  const cookie = setCookie?.split(';', 1)[0];
  if (!cookie || !/^__Host-sql_apps_session=/.test(cookie) ||
      !setCookie || !/;\s*secure(?:;|$)/i.test(setCookie) || !/;\s*httponly(?:;|$)/i.test(setCookie) ||
      !/;\s*samesite=strict(?:;|$)/i.test(setCookie) || !/;\s*path=\/(?:;|$)/i.test(setCookie)) {
    throw new Error('Public session did not issue the expected secure cookie');
  }
  const foreignOrigin = await fetcher(new URL('/api/session', origin), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://foreign.invalid' },
    body: JSON.stringify({ synthetic: true }), signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (foreignOrigin.status !== 403) throw new Error(`Foreign-origin mutation was not rejected (${foreignOrigin.status})`);
  const forgedIdentity = await request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-ms-client-principal': 'forged', 'x-ms-api-role': 'anonymous' },
    body: JSON.stringify({ synthetic: true }),
  });
  if (forgedIdentity.status !== 403) throw new Error(`Forged platform identity headers were not rejected (${forgedIdentity.status})`);
  const ended = await request('/api/session', { method: 'DELETE', headers: { cookie } });
  if (ended.status !== 204) throw new Error(`Public session cleanup returned ${ended.status}`);
  const expired = await request('/api/session', { headers: { cookie } });
  if (expired.status !== 401) throw new Error(`Deleted public session remained usable (${expired.status})`);
  const acceptance = z.object({
    acceptPublicApplication: z.custom<(origin: string, fetcher: typeof fetch) => Promise<void>>(
      value => typeof value === 'function',
    ),
  }).parse(await import(pathToFileURL(join(resolve(artifact), 'acceptance', 'public.mjs')).href));
  await acceptance.acceptPublicApplication(origin, fetcher);
  await waitForBackend(runtime, fetcher);
}
