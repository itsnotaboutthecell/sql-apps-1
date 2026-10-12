import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { checkSelectedApplication, type ApplicationBuildManifest } from './application-build.js';
import { preflightDemo } from './azure-preflight.js';
import { reviewDemoCost } from './demo-cost.js';
import { saveJson, withDeploymentLock } from './deployment.js';
import type { Run } from './process.js';

const guid = z.string().uuid().transform(value => value.toLowerCase());
const imageReference = z.string().regex(
  /^[a-z0-9]+\.azurecr\.io\/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/,
  'Image must use an explicit tag or sha256 digest',
);
const sku = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  tier: z.string().regex(/^[A-Za-z]{1,32}$/),
  family: z.string().regex(/^[A-Za-z0-9]{1,32}$/).optional(),
  capacity: z.number().finite().positive(),
});

export const demoPublicationSchema = z.strictObject({
  version: z.literal(1),
  profile: z.literal('public-demo'),
  hosting: z.literal('static-web-apps'),
  name: z.string().regex(/^[a-z][a-z0-9-]{2,15}$/),
  subscriptionId: guid,
  tenantId: guid,
  resourceGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/).refine(value => !value.endsWith('.')),
  location: z.string().regex(/^[a-z0-9]+$/),
  staticWebAppLocation: z.string().regex(/^[a-z0-9]+$/),
  deploymentId: guid,
  applicationName: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  staticWebAppName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{2,39}$/),
  registryServer: z.string().regex(/^[a-z0-9]+\.azurecr\.io$/),
  gatewayImage: imageReference,
  dabImage: imageReference,
  selectedApplication: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  selectedArtifact: z.string().min(1),
  sqlAdminObjectId: guid,
  sqlAdminName: z.string().trim().min(1).max(128),
  schemaRunnerIp: z.ipv4(),
  cost: z.strictObject({
    intent: z.literal('review-paid-costs'),
    acknowledgeFixedCharges: z.literal(true),
  }),
  sqlBillingMode: z.enum(['free-paused', 'paid-reviewed']),
  sqlSku: sku,
  sqlMaxSizeBytes: z.number().int().min(104_857_600).max(Number.MAX_SAFE_INTEGER),
  sqlBackupRedundancy: z.enum(['Local', 'Zone', 'Geo', 'GeoZone']),
  tags: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), z.string().max(256)).default({}),
}).superRefine((value, context) => {
  for (const field of ['gatewayImage', 'dabImage'] as const) {
    if (!value[field].startsWith(`${value.registryServer}/`)) {
      context.addIssue({ code: 'custom', path: [field], message: 'Image must belong to the configured ACR' });
    }
  }
  if (value.gatewayImage === value.dabImage) {
    context.addIssue({ code: 'custom', path: ['dabImage'], message: 'Gateway and DAB images must use distinct references' });
  }
  if (value.sqlBillingMode === 'free-paused' &&
      (value.sqlSku.name !== 'GP_S_Gen5_2' || value.sqlSku.tier !== 'GeneralPurpose' ||
       value.sqlSku.family !== 'Gen5' || value.sqlSku.capacity !== 2 ||
       value.sqlMaxSizeBytes !== 32 * 1024 ** 3 || value.sqlBackupRedundancy !== 'Local')) {
    context.addIssue({ code: 'custom', path: ['sqlBillingMode'],
      message: 'free-paused must carry the exact reviewed free SQL sizing parameters' });
  }
});
export type DemoPublicationConfig = z.infer<typeof demoPublicationSchema>;

export const demoPublicationStages = ['artifacts', 'infrastructure', 'schema', 'backend', 'static', 'ready'] as const;
export type DemoPublicationStage = typeof demoPublicationStages[number];

const infrastructureSchema = z.strictObject({
  environmentId: z.string().startsWith('/subscriptions/'),
  environmentName: z.string().min(1),
  applicationName: z.string().min(1),
  runtimeIdentityResourceId: z.string().startsWith('/subscriptions/'),
  runtimeIdentityName: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  runtimeIdentityClientId: guid,
  runtimeIdentityPrincipalId: guid,
  runtimeIdentityTenantId: guid,
  registryId: z.string().startsWith('/subscriptions/'),
  registryName: z.string().min(1),
  registryServer: z.string().regex(/^[a-z0-9]+\.azurecr\.io$/),
  networkId: z.string().startsWith('/subscriptions/'),
  subnetId: z.string().startsWith('/subscriptions/'),
  sqlServerId: z.string().startsWith('/subscriptions/'),
  sqlServerName: z.string().regex(/^[a-z0-9-]{1,63}$/),
  sqlHost: z.string().regex(/^[a-z0-9-]+\.database\.windows\.net$/),
  databaseId: z.string().startsWith('/subscriptions/'),
  databaseName: z.literal('app'),
  ownershipTags: z.record(z.string(), z.string()),
  sqlBillingMode: z.enum(['free-paused', 'paid-reviewed']),
});
const runtimeOutputSchema = z.strictObject({
  applicationId: z.string().startsWith('/subscriptions/'),
  publicUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  backendUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  staticWebAppName: z.string().min(1),
});
const runtimeSchema = runtimeOutputSchema.extend({
  staticWebAppId: z.string().startsWith('/subscriptions/'),
});
const pinnedImagesSchema = z.strictObject({
  gatewayImage: z.string().regex(/@sha256:[a-f0-9]{64}$/),
  dabImage: z.string().regex(/@sha256:[a-f0-9]{64}$/),
});

export const demoPublicationStateSchema = z.strictObject({
  version: z.literal(1),
  profile: z.literal('public-demo'),
  stage: z.enum(demoPublicationStages),
  workspaceHome: z.string().min(1),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  pinnedImages: pinnedImagesSchema.nullable(),
  infrastructure: infrastructureSchema.nullable(),
  runtime: runtimeSchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export type DemoPublicationState = z.infer<typeof demoPublicationStateSchema>;

export interface PublicationPlan {
  approval: string;
  pending: DemoPublicationStage[];
  excluded: string[];
  review: string[];
  warning: string;
  configHash: string;
  artifactHash: string;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const parsedConfig = (input: DemoPublicationConfig) => demoPublicationSchema.parse(input);
const stageIndex = (stage: DemoPublicationStage) => demoPublicationStages.indexOf(stage);

function currentBinding(config: DemoPublicationConfig) {
  const parsed = parsedConfig(config);
  const workspaceHome = realpathSync('.');
  const artifact = resolve(parsed.selectedArtifact);
  const artifactManifest = readFileSync(join(artifact, 'application-build.json'));
  return {
    parsed, workspaceHome,
    configHash: hash(JSON.stringify(parsed)),
    artifactHash: hash(Buffer.concat([Buffer.from(realpathSync(artifact)), Buffer.from([0]), artifactManifest])),
  };
}

export function demoPublicationStatePath(config: DemoPublicationConfig): string {
  const parsed = parsedConfig(config);
  return resolve('.sql-apps', 'demo-publications',
    `${hash(`${parsed.subscriptionId}\0${parsed.resourceGroup}\0${parsed.deploymentId}`).slice(0, 20)}.json`);
}

function matchingState(state: DemoPublicationState | undefined, binding: ReturnType<typeof currentBinding>) {
  return state && state.workspaceHome === binding.workspaceHome && state.configHash === binding.configHash &&
    state.artifactHash === binding.artifactHash ? state : undefined;
}

export function planDemoPublication(
  config: DemoPublicationConfig, state?: DemoPublicationState,
): PublicationPlan {
  const binding = currentBinding(config);
  const matched = matchingState(state, binding);
  const pending = demoPublicationStages.slice(matched ? stageIndex(matched.stage) + 1 : 0);
  const approval = hash(JSON.stringify({
    version: 1, configHash: binding.configHash, artifactHash: binding.artifactHash,
    workspaceHome: binding.workspaceHome, pending,
  })).slice(0, 24);
  return {
    approval, pending: [...pending],
    review: [
      `Target: subscription ${binding.parsed.subscriptionId}, resource group ${binding.parsed.resourceGroup}, backend ${binding.parsed.location}, Static Web Apps ${binding.parsed.staticWebAppLocation}`,
      'Costs: paid fixed charges are acknowledged for review; actual regional/account pricing and grant consumption still require operator confirmation',
      `Images: publish or verify ${binding.parsed.gatewayImage} and ${binding.parsed.dabImage} from ${realpathSync(binding.parsed.selectedArtifact)}, then deploy immutable digests`,
      'Resources: managed identity, VNet/subnet, Container Apps environment, ACR Basic, Azure SQL, Static Web Apps Standard, and one linked two-container app',
      `Schema: temporarily allow only ${binding.parsed.schemaRunnerIp}, publish with Microsoft Entra authentication, then remove that firewall rule before runtime deployment`,
      'Cleanup: no automatic teardown; export required synthetic data, then separately approve deletion of only resources tagged with this deployment ID',
    ],
    excluded: [
      'No real/customer data, production SLA, custom domain, paid SQL fallback, role assignment, or default-hosting change',
      'No deployment token is accepted, printed, or persisted',
    ],
    warning: 'PUBLIC SYNTHETIC DEMO ONLY. Azure Static Web Apps Standard, ACR, networking, SQL, and runtime usage can incur charges.',
    configHash: binding.configHash, artifactHash: binding.artifactHash,
  };
}

export async function readDemoPublicationState(config: DemoPublicationConfig): Promise<DemoPublicationState> {
  const binding = currentBinding(config);
  const state = demoPublicationStateSchema.parse(JSON.parse(await readFile(demoPublicationStatePath(binding.parsed), 'utf8')));
  if (!matchingState(state, binding)) {
    throw new Error('Publication state belongs to another workspace, configuration, or selected artifact');
  }
  return state;
}

function outputs<T>(text: string, schema: z.ZodType<T>): T {
  const envelope = z.record(z.string(), z.object({ value: z.unknown() })).parse(JSON.parse(text));
  return schema.parse(Object.fromEntries(Object.entries(envelope).map(([key, item]) => [key, item.value])));
}

async function parameterFile(config: DemoPublicationConfig, suffix: string, parameters: Record<string, unknown>) {
  const path = `${demoPublicationStatePath(config)}.${suffix}.parameters.json`;
  await saveJson(path, { parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { value }])) });
  return path;
}

async function pinImage(config: DemoPublicationConfig, field: 'gatewayImage' | 'dabImage', runner: Run) {
  const image = config[field];
  const reference = image.slice(config.registryServer.length + 1);
  const digest = (await runner('az', ['acr', 'repository', 'show', '--subscription', config.subscriptionId,
    '--name', config.registryServer.split('.')[0]!, '--image', reference, '--query', 'digest', '-o', 'tsv'])).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`ACR returned an invalid digest for ${field}`);
  if (image.includes('@') && image.split('@')[1] !== digest) throw new Error(`Configured ${field} digest does not match ACR`);
  const repository = reference.split('@')[0]!.split(':')[0]!;
  return `${config.registryServer}/${repository}@${digest}`;
}

async function publishImages(config: DemoPublicationConfig, runner: Run) {
  const fields = [
    ['gatewayImage', 'Dockerfile'],
    ['dabImage', 'dab/Dockerfile'],
  ] as const;
  for (const [field, dockerfile] of fields) {
    if (!config[field].includes('@')) {
      await runner('az', ['acr', 'build', '--subscription', config.subscriptionId,
        '--registry', config.registryServer.split('.')[0]!,
        '--image', config[field].slice(config.registryServer.length + 1),
        '--file', dockerfile, resolve(config.selectedArtifact)]);
    }
  }
  return pinnedImagesSchema.parse({
    gatewayImage: await pinImage(config, 'gatewayImage', runner),
    dabImage: await pinImage(config, 'dabImage', runner),
  });
}

function guidSid(value: string) {
  const bytes = Buffer.from(value.replaceAll('-', ''), 'hex');
  return Buffer.concat([
    Buffer.from([...bytes.subarray(0, 4)].reverse()),
    Buffer.from([...bytes.subarray(4, 6)].reverse()),
    Buffer.from([...bytes.subarray(6, 8)].reverse()),
    bytes.subarray(8),
  ]).toString('hex').toUpperCase();
}

async function publishSelectedSchema(
  config: DemoPublicationConfig, manifest: ApplicationBuildManifest,
  infrastructure: z.infer<typeof infrastructureSchema>, runner: Run,
) {
  const directory = `${demoPublicationStatePath(config)}.schema`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await cp(join(resolve(config.selectedArtifact), 'sql'), directory, { recursive: true, dereference: false });
  const postDeploy = join(directory, 'post-deploy.sql');
  const grants = (await readFile(join(resolve(config.selectedArtifact), 'setup', 'grants.sql'), 'utf8'))
    .replaceAll('$(ApplicationUser)', infrastructure.runtimeIdentityName.replaceAll(']', ']]'));
  const principal = infrastructure.runtimeIdentityName.replaceAll(']', ']]');
  await writeFile(postDeploy, `${await readFile(postDeploy, 'utf8')}
IF DATABASE_PRINCIPAL_ID(N'${principal.replaceAll("'", "''")}') IS NULL
  CREATE USER [${principal}] WITH SID = 0x${guidSid(infrastructure.runtimeIdentityPrincipalId)}, TYPE = E;
GO
${grants}
`);
  const output = join(directory, 'output');
  await runner('dotnet', ['build', join(directory, 'database.sqlproj'), '--output', output]);
  const tokenText = await runner('az', ['account', 'get-access-token', '--tenant', config.tenantId,
    '--subscription', config.subscriptionId, '--resource', 'https://database.windows.net/', '-o', 'json']);
  const accessToken = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(tokenText)).accessToken;
  const firewallRule = `${config.name}-${config.deploymentId.slice(0, 8)}-schema-runner`;
  await runner('az', ['sql', 'server', 'firewall-rule', 'create',
    '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
    '--server', infrastructure.sqlServerName, '--name', firewallRule,
    '--start-ip-address', config.schemaRunnerIp, '--end-ip-address', config.schemaRunnerIp,
  ]);
  let publishError: unknown;
  try {
    await runner('dotnet', ['tool', 'run', 'sqlpackage', '--', '/Action:Publish',
      `/SourceFile:${join(output, 'database.dacpac')}`,
      `/TargetConnectionString:Server=tcp:${infrastructure.sqlHost},1433;Database=${infrastructure.databaseName};Encrypt=True;TrustServerCertificate=False;`,
      `/AccessToken:${accessToken}`, '/p:BlockOnPossibleDataLoss=True', '/p:DropObjectsNotInSource=False',
    ], { redact: [accessToken] });
  } catch (error) {
    publishError = error;
  }
  try {
    await runner('az', ['sql', 'server', 'firewall-rule', 'delete',
      '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
      '--server', infrastructure.sqlServerName, '--name', firewallRule,
    ]);
  } catch (cleanupError) {
    throw new AggregateError(
      publishError === undefined ? [cleanupError] : [publishError, cleanupError],
      'Schema publication failed or its temporary SQL firewall rule could not be removed',
    );
  }
  if (publishError !== undefined) throw publishError;
  if (manifest.name !== config.selectedApplication) throw new Error('Selected artifact application does not match publication configuration');
}

async function waitForBackend(publicUrl: string, backendUrl: string, fetcher: typeof fetch) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetcher(new URL('/api/health/ready', publicUrl),
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
  const denied = await fetcher(new URL('/api/session', backendUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://direct.invalid' },
    body: JSON.stringify({ synthetic: true }), signal: AbortSignal.timeout(5_000), redirect: 'error',
  });
  if (![401, 403].includes(denied.status)) throw new Error(`Direct backend API was not denied (${denied.status})`);
}

async function verifyStaticContent(
  publicUrl: string, artifact: string, fetcher: typeof fetch,
) {
  const expected = hash(await readFile(join(resolve(artifact), 'static', 'app.js')));
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const url = new URL('/app.js', publicUrl);
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

async function publicAcceptance(
  runtime: z.infer<typeof runtimeSchema>, artifact: string, fetcher: typeof fetch,
) {
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
  await waitForBackend(runtime.publicUrl, runtime.backendUrl, fetcher);
}

export async function validateDemoPublication(
  config: DemoPublicationConfig,
): Promise<{ config: DemoPublicationConfig; manifest: ApplicationBuildManifest }> {
  const parsed = parsedConfig(config);
  const home = await realpath('.');
  const manifest = await checkSelectedApplication(home, resolve(parsed.selectedArtifact), 'public-demo');
  if (manifest.name !== parsed.selectedApplication) throw new Error('Selected artifact application does not match publication configuration');
  const cost = reviewDemoCost({
    version: 1, profile: parsed.profile, hosting: parsed.hosting,
    intent: parsed.cost.intent, acknowledgeFixedCharges: parsed.cost.acknowledgeFixedCharges,
    sql: parsed.sqlBillingMode === 'free-paused' ? { mode: parsed.sqlBillingMode } : {
      mode: parsed.sqlBillingMode, sku: parsed.sqlSku,
      maxSizeBytes: parsed.sqlMaxSizeBytes, backupRedundancy: parsed.sqlBackupRedundancy,
    },
  });
  if (!cost.review.canProceedToWhatIf) throw new Error('Publication requires an acknowledged paid-cost review');
  return { config: parsed, manifest };
}

export async function publishDemo(
  input: DemoPublicationConfig, runner: Run, fetcher: typeof fetch = fetch, expectedApproval?: string,
): Promise<DemoPublicationState> {
  const config = parsedConfig(input);
  const binding = currentBinding(config);
  const path = demoPublicationStatePath(config);
  return withDeploymentLock(path, async () => {
    const validated = await validateDemoPublication(config);
    const assertArtifact = async () => {
      await checkSelectedApplication(binding.workspaceHome, resolve(config.selectedArtifact), 'public-demo');
      const current = currentBinding(config);
      if (current.workspaceHome !== binding.workspaceHome || current.configHash !== binding.configHash ||
          current.artifactHash !== binding.artifactHash) {
        throw new Error('Publication configuration or selected artifact changed during publication');
      }
    };
    let previous: DemoPublicationState | undefined;
    try { previous = await readDemoPublicationState(config); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (expectedApproval !== undefined && planDemoPublication(config, previous).approval !== expectedApproval) {
      throw new Error('The configuration, selected artifact, or pending publication work changed after review');
    }
    await preflightDemo({
      profile: config.profile, tenantId: config.tenantId, subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup, location: config.location,
      staticWebAppLocation: config.staticWebAppLocation,
      securityPosture: 'starter',
    }, runner, fetcher);
    await runner('az', ['bicep', 'version']);
    await runner('dotnet', ['tool', 'run', 'sqlpackage', '--', '/Version']);
    await runner('npx', ['--no-install', 'swa', '--version'], {
      env: { SWA_CLI_DEPLOYMENT_TOKEN: '', AZURE_STATIC_WEB_APPS_API_TOKEN: '' },
    });

    let state = matchingState(previous, binding) ?? demoPublicationStateSchema.parse({
      version: 1, profile: 'public-demo', stage: 'artifacts', workspaceHome: binding.workspaceHome,
      configHash: binding.configHash, artifactHash: binding.artifactHash,
      pinnedImages: null, infrastructure: null, runtime: null, updatedAt: new Date().toISOString(),
    });
    const persist = async (next: DemoPublicationState) => {
      state = demoPublicationStateSchema.parse({ ...next, updatedAt: new Date().toISOString() });
      await saveJson(path, state);
    };
    if (!previous) {
      const pinnedImages = await publishImages(config, runner);
      await assertArtifact();
      await persist({ ...state, stage: 'artifacts', pinnedImages });
    }
    if (stageIndex(state.stage) < stageIndex('infrastructure')) {
      if (!state.pinnedImages) throw new Error('Pinned image state is required before infrastructure');
      const parameters = {
        name: config.name, selectedApplication: config.selectedApplication, deploymentId: config.deploymentId,
        location: config.location, tenantId: config.tenantId, tags: config.tags,
        sqlAdminObjectId: config.sqlAdminObjectId, sqlAdminName: config.sqlAdminName,
        sqlBillingMode: config.sqlBillingMode, sqlSku: config.sqlSku,
        sqlMaxSizeBytes: config.sqlMaxSizeBytes, sqlBackupRedundancy: config.sqlBackupRedundancy,
      };
      const infrastructure = outputs(await runner('az', ['deployment', 'group', 'create',
        '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
        '--name', `${config.name}-${config.deploymentId.slice(0, 8)}-infrastructure`,
        '--template-file', 'infra/demo.bicep',
        '--parameters', `@${await parameterFile(config, 'infrastructure', parameters)}`,
        '--query', 'properties.outputs', '-o', 'json',
      ]), infrastructureSchema);
      if (infrastructure.applicationName !== config.applicationName ||
          infrastructure.registryServer !== config.registryServer ||
          infrastructure.runtimeIdentityTenantId !== config.tenantId ||
          infrastructure.sqlBillingMode !== config.sqlBillingMode) {
        throw new Error('Provisioned foundation outputs do not match the reviewed publication target');
      }
      await persist({ ...state, stage: 'infrastructure', infrastructure });
    }
    if (stageIndex(state.stage) < stageIndex('schema')) {
      if (!state.infrastructure) throw new Error('Infrastructure state is required before schema publication');
      await assertArtifact();
      await publishSelectedSchema(config, validated.manifest, state.infrastructure, runner);
      await persist({ ...state, stage: 'schema' });
    }
    if (stageIndex(state.stage) < stageIndex('backend')) {
      if (!state.infrastructure || !state.pinnedImages) throw new Error('Foundation and pinned images are required before backend deployment');
      const parameters = {
        applicationName: config.applicationName, selectedApplication: config.selectedApplication,
        deploymentId: config.deploymentId, location: config.location,
        staticWebAppLocation: config.staticWebAppLocation, tags: config.tags,
        environmentName: state.infrastructure.environmentName,
        runtimeIdentityName: state.infrastructure.runtimeIdentityName,
        registryName: state.infrastructure.registryName, sqlServerName: state.infrastructure.sqlServerName,
        databaseName: state.infrastructure.databaseName, staticWebAppName: config.staticWebAppName,
        gatewayImage: state.pinnedImages.gatewayImage, dabImage: state.pinnedImages.dabImage,
      };
      const deployed = outputs(await runner('az', ['deployment', 'group', 'create',
        '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
        '--name', `${config.name}-${config.deploymentId.slice(0, 8)}-runtime`,
        '--template-file', 'infra/demo-runtime.bicep',
        '--parameters', `@${await parameterFile(config, 'runtime', parameters)}`,
        '--query', 'properties.outputs', '-o', 'json',
      ]), runtimeOutputSchema);
      const runtime = runtimeSchema.parse({
        ...deployed,
        staticWebAppId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}` +
          `/providers/Microsoft.Web/staticSites/${deployed.staticWebAppName}`,
      });
      if (runtime.staticWebAppName !== config.staticWebAppName) throw new Error('Runtime output selected another Static Web App');
      await waitForBackend(runtime.publicUrl, runtime.backendUrl, fetcher);
      await persist({ ...state, stage: 'backend', runtime });
    }
    if (stageIndex(state.stage) < stageIndex('static')) {
      if (!state.runtime) throw new Error('Ready backend state is required before static deployment');
      await assertArtifact();
      const deploymentToken = (await runner('az', ['staticwebapp', 'secrets', 'list',
        '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
        '--name', config.staticWebAppName, '--query', 'properties.apiKey', '-o', 'tsv'],
      { sensitiveOutput: true })).trim();
      if (deploymentToken.length < 20 || /\s/.test(deploymentToken)) {
        throw new Error('Azure returned an invalid Static Web Apps deployment token');
      }
      await runner('npx', ['--no-install', 'swa', 'deploy', join(resolve(config.selectedArtifact), 'static'),
        '--env', 'production', '--no-use-keychain'], {
        env: {
          SWA_CLI_DEPLOYMENT_TOKEN: deploymentToken, AZURE_STATIC_WEB_APPS_API_TOKEN: '',
          AZURE_CLIENT_ID: '', AZURE_CLIENT_SECRET: '', AZURE_TENANT_ID: '', AZURE_SUBSCRIPTION_ID: '',
        },
        redact: [deploymentToken],
      });
      await verifyStaticContent(state.runtime.publicUrl, config.selectedArtifact, fetcher);
      await persist({ ...state, stage: 'static' });
    }
    if (stageIndex(state.stage) < stageIndex('ready')) {
      if (!state.runtime) throw new Error('Static acceptance requires saved runtime outputs');
      await publicAcceptance(state.runtime, config.selectedArtifact, fetcher);
      await persist({ ...state, stage: 'ready' });
    }
    return state;
  });
}

export async function demoPublicationStatus(
  config: DemoPublicationConfig, runner: Run, fetcher: typeof fetch = fetch,
) {
  const state = await readDemoPublicationState(config);
  const resources: Record<string, unknown> = {};
  if (state.infrastructure) {
    resources.foundation = JSON.parse(await runner('az', ['deployment', 'group', 'show',
      '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
      '--name', `${config.name}-${config.deploymentId.slice(0, 8)}-infrastructure`,
      '--query', '{provisioningState:properties.provisioningState,timestamp:properties.timestamp}', '-o', 'json']));
  }
  if (state.runtime) {
    resources.runtime = JSON.parse(await runner('az', ['containerapp', 'show',
      '--subscription', config.subscriptionId, '--resource-group', config.resourceGroup,
      '--name', config.applicationName,
      '--query', '{provisioningState:properties.provisioningState,runningStatus:properties.runningStatus}', '-o', 'json']));
    const [backend, publicSite, direct] = await Promise.all([
      fetcher(new URL('/api/health/ready', state.runtime.publicUrl), { signal: AbortSignal.timeout(5_000), redirect: 'error' }),
      fetcher(new URL('/', state.runtime.publicUrl), { signal: AbortSignal.timeout(5_000), redirect: 'error' }),
      fetcher(new URL('/api/session', state.runtime.backendUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://direct.invalid' },
        body: JSON.stringify({ synthetic: true }), signal: AbortSignal.timeout(5_000), redirect: 'error',
      }),
    ]);
    resources.health = { linkedBackend: backend.status, publicSite: publicSite.status, directBackend: direct.status };
  }
  return { stage: state.stage, updatedAt: state.updatedAt, resources };
}
