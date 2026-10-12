import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSelectedApplication } from '../src/application-build.js';
import {
  demoPublicationApprovalId, demoPublicationSchema, demoPublicationStatePath, planDemoPublication, publishDemo,
  readDemoPublicationState, validateDemoPublication, type DemoPublicationConfig,
} from '../src/demo-publication.js';
import type { Run } from '../src/process.js';

const base = {
  version: 1 as const,
  profile: 'public-demo' as const,
  securityPosture: 'starter' as const,
  hosting: 'static-web-apps' as const,
  name: 'sqlapps',
  subscriptionId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  resourceGroup: 'rg-sql-apps-demo',
  location: 'eastus',
  staticWebAppLocation: 'eastus2',
  deploymentId: '33333333-3333-4333-8333-333333333333',
  applicationName: 'sqlapps-33333333-web',
  staticWebAppName: 'sqlapps-demo-static',
  registryServer: 'example.azurecr.io',
  gatewayImage: 'example.azurecr.io/sqlapps-demo-api:1.0.0',
  dabImage: 'example.azurecr.io/sqlapps-demo-dab:1.0.0',
  selectedApplication: 'todo',
  selectedArtifact: '',
  sqlAdminObjectId: '44444444-4444-4444-8444-444444444444',
  sqlAdminName: 'Demo Administrator',
  schemaRunnerIp: '203.0.113.10',
  cost: { intent: 'review-paid-costs' as const, acknowledgeFixedCharges: true as const },
  sqlBillingMode: 'free-paused' as const,
  sqlSku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 },
  sqlMaxSizeBytes: 32 * 1024 ** 3,
  sqlBackupRedundancy: 'Local' as const,
  tags: { owner: 'tests' },
};

test('publication configuration is strict, SWA-only, ACR-bound and carries complete SQL policy', () => {
  const artifact = process.cwd();
  assert.equal(demoPublicationSchema.safeParse({ ...base, selectedArtifact: artifact }).success, true);
  for (const value of [
    { ...base, selectedArtifact: artifact, unknown: true },
    { ...base, selectedArtifact: artifact, hosting: 'container-apps' },
    { ...base, selectedArtifact: artifact, gatewayImage: 'other.azurecr.io/api:1' },
    { ...base, selectedArtifact: artifact, gatewayImage: 'example.azurecr.io/api:latest;bad' },
    { ...base, selectedArtifact: artifact, sqlMaxSizeBytes: 1 },
    { ...base, selectedArtifact: artifact, cost: { intent: 'zero-azure-spend', acknowledgeFixedCharges: false } },
    { ...base, selectedArtifact: artifact, cost: { intent: 'review-paid-costs', acknowledgeFixedCharges: false } },
  ]) assert.equal(demoPublicationSchema.safeParse(value).success, false);
});

test('publication accepts only explicit Starter posture', () => {
  const artifact = process.cwd();
  assert.equal(demoPublicationSchema.safeParse({
    ...base, selectedArtifact: artifact, securityPosture: 'starter',
  }).success, true);
  for (const securityPosture of [undefined, 'hardened', 'automatic']) {
    assert.equal(demoPublicationSchema.safeParse({
      ...base, selectedArtifact: artifact, securityPosture,
    }).success, false);
  }
});

test('review is read-only and approval binds configuration, artifact manifest and pending stages', async t => {
  const built = await buildSelectedApplication('.', 'todo', 'public-demo');
  t.after(() => rm(built.directory, { recursive: true, force: true }));
  const config = demoPublicationSchema.parse({ ...base, selectedArtifact: built.directory });
  await validateDemoPublication(config);
  const first = planDemoPublication(config);
  assert.deepEqual(first.pending, ['infrastructure', 'artifacts', 'schema', 'backend', 'static', 'ready']);
  assert.match(first.warning, /PUBLIC SYNTHETIC DEMO ONLY/);
  assert.match(first.review.join('\n'), /Static Web Apps eastus2/);
  assert.ok(first.review.includes(
    'Security posture: Starter; ACR image pulls use an Azure-managed Container App secret until separately approved hardening',
  ));
  assert.ok(first.excluded.includes(
    'No real/customer data, production SLA, custom domain, paid SQL fallback, production hardening, or default-hosting change',
  ));
  assert.match(first.review.join('\n'), /temporarily allow only 203\.0\.113\.10/);
  assert.notEqual(first.approval, planDemoPublication({ ...config, staticWebAppName: 'sqlapps-demo-other' }).approval);
  assert.notEqual(
    demoPublicationApprovalId(config),
    demoPublicationApprovalId({ ...config, securityPosture: 'hardened' }),
  );
  const manifest = join(built.directory, 'application-build.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, `${original}\n`);
  assert.notEqual(first.approval, planDemoPublication(config).approval);
  await writeFile(manifest, original);
});

function harness(config: DemoPublicationConfig, failure?: 'image' | 'schema' | 'backend' | 'static') {
  const calls: string[][] = [];
  const requests: string[] = [];
  const swaEnvironments: NodeJS.ProcessEnv[] = [];
  let sessions = 0;
  const deletedSessions = new Set<string>();
  let itemOwner: string | undefined;
  const digest = `sha256:${'a'.repeat(64)}`;
  const infrastructure = {
    environmentId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/managedEnvironments/env`,
    environmentName: 'env', applicationName: config.applicationName,
    runtimeIdentityResourceId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime`,
    runtimeIdentityName: 'runtime', runtimeIdentityClientId: '55555555-5555-4555-8555-555555555555',
    runtimeIdentityPrincipalId: '66666666-6666-4666-8666-666666666666', runtimeIdentityTenantId: config.tenantId,
    registryId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/example`,
    registryName: 'example', registryServer: config.registryServer,
    networkId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.Network/virtualNetworks/network`,
    subnetId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.Network/virtualNetworks/network/subnets/containers`,
    sqlServerId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.Sql/servers/server`,
    sqlServerName: 'server', sqlHost: 'server.database.windows.net',
    databaseId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.Sql/servers/server/databases/app`,
    databaseName: 'app', ownershipTags: { owner: 'tests' }, sqlBillingMode: config.sqlBillingMode,
  };
  const runtime = {
    applicationId: `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${config.applicationName}`,
    publicUrl: 'https://demo.example', backendUrl: 'https://backend.example',
    staticWebAppName: config.staticWebAppName,
  };
  const envelope = (value: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { value: item }])));
  const runner: Run = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === 'npx' && args.includes('deploy')) swaEnvironments.push(options?.env ?? {});
    if (args[0] === 'account' && args[1] === 'list') return '[]';
    if (args[0] === 'account' && args[1] === 'get-access-token') {
      if (args.includes('https://management.azure.com/')) {
        return JSON.stringify({ accessToken: 'management-token', tenant: config.tenantId,
          expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
      }
      return JSON.stringify({ accessToken: 'sql-sensitive-token' });
    }
    if (args[0] === 'acr' && args[1] === 'repository') return digest;
    if (failure === 'image' && args[0] === 'acr' && args[1] === 'build') throw new Error('image rejected');
    if (args[0] === 'staticwebapp' && args[1] === 'secrets') return 'static-deployment-token-for-tests';
    if (args[0] === 'deployment' && args.includes('infra/demo.bicep')) return envelope(infrastructure);
    if (args[0] === 'deployment' && args.includes('infra/demo-runtime.bicep')) return envelope(runtime);
    if (failure === 'schema' && args.some(arg => arg === '/Action:Publish')) throw new Error('schema rejected');
    return '';
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.origin === 'https://management.azure.com') {
      if (url.pathname.endsWith('/locations')) return Response.json({ value: [
        { name: config.location, displayName: 'East US' },
        { name: config.staticWebAppLocation, displayName: 'East US 2' },
      ] });
      if (url.pathname.endsWith('/permissions')) return Response.json({ value: [{ actions: ['*'], notActions: [] }] });
      const provider = /\/providers\/(Microsoft\.[^/]+)$/.exec(url.pathname)?.[1];
      if (provider) {
        const types: Record<string, string[]> = {
          'Microsoft.App': ['managedEnvironments', 'containerApps'], 'Microsoft.Sql': ['servers'],
          'Microsoft.Network': ['virtualNetworks'], 'Microsoft.ContainerRegistry': ['registries'],
          'Microsoft.ManagedIdentity': ['userAssignedIdentities'], 'Microsoft.Authorization': ['roleAssignments'],
          'Microsoft.Web': ['staticSites', 'staticSites/linkedBackends'],
        };
        return Response.json({ namespace: provider, registrationState: 'Registered',
          resourceTypes: types[provider]!.map(resourceType => ({
            resourceType, locations: [provider === 'Microsoft.Web' ? 'East US 2' : 'East US'],
          })) });
      }
      if (url.pathname.toLowerCase().endsWith(`/resourcegroups/${config.resourceGroup}`.toLowerCase())) {
        return Response.json({ id: `/subscriptions/${config.subscriptionId}/resourcegroups/${config.resourceGroup}`, location: config.location });
      }
      return Response.json({ subscriptionId: config.subscriptionId, tenantId: config.tenantId, state: 'Enabled' });
    }
    if (url.origin === runtime.backendUrl) {
      return Response.json({ error: 'denied' }, { status: 403 });
    }
    if (url.pathname === '/api/health/ready') {
      return new Response('', { status: failure === 'backend' ? 400 : 200 });
    }
    if (url.pathname === '/app.js') {
      return new Response(failure === 'static' ? 'upload-failed' :
        await readFile(join(config.selectedArtifact, 'static', 'app.js')), { status: failure === 'static' ? 400 : 200 });
    }
    if (url.pathname === '/') return new Response('<html></html>', { status: 200 });
    const requestHeaders = init?.headers as Record<string, string> | undefined;
    if (requestHeaders?.origin === 'https://foreign.invalid' ||
        requestHeaders?.['x-ms-client-principal'] !== undefined ||
        requestHeaders?.['x-ms-api-role'] !== undefined) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (url.pathname === '/api/session' && init?.method === 'POST') {
      sessions++;
      return Response.json({ expiresAt: new Date(Date.now() + 60_000).toISOString() },
        { status: 201, headers: { 'set-cookie': `__Host-sql_apps_session=session-${sessions}; Path=/; Secure; HttpOnly; SameSite=Strict` } });
    }
    if (url.pathname === '/api/session' && init?.method === 'DELETE') {
      deletedSessions.add(String(requestHeaders?.cookie));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/session' && deletedSessions.has(String(requestHeaders?.cookie))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (url.pathname === '/api/todos' && init?.method === 'POST') {
      itemOwner = requestHeaders?.cookie;
      return Response.json({ id: '77777777-7777-4777-8777-777777777777', title: 'test', completed: false }, { status: 201 });
    }
    if (url.pathname === '/api/todos') {
      return Response.json({ items: requestHeaders?.cookie === itemOwner ?
        [{ id: '77777777-7777-4777-8777-777777777777' }] : [] });
    }
    if (init?.method === 'PATCH') {
      if (requestHeaders?.cookie !== itemOwner) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ id: '77777777-7777-4777-8777-777777777777', title: 'test', completed: true });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch ${url} ${init?.method ?? 'GET'}`);
  };
  return { runner, fetcher, calls, requests, swaEnvironments };
}

async function cleanup(config: DemoPublicationConfig) {
  const path = demoPublicationStatePath(config);
  for (const suffix of ['', '.infrastructure.parameters.json', '.runtime.parameters.json', '.schema', '.lock']) {
    await rm(`${path}${suffix}`, { recursive: true, force: true });
  }
}

test('publication is ordered, resumable, atomic, token-free and uses the local SWA CLI', async t => {
  const built = await buildSelectedApplication('.', 'todo', 'public-demo');
  t.after(() => rm(built.directory, { recursive: true, force: true }));
  const config = demoPublicationSchema.parse({ ...base, selectedArtifact: built.directory,
    deploymentId: '88888888-8888-4888-8888-888888888888' });
  t.after(() => cleanup(config));
  const fake = harness(config);
  const approval = planDemoPublication(config).approval;
  const state = await publishDemo(config, fake.runner, fake.fetcher, approval);
  assert.equal(state.stage, 'ready');
  assert.equal(state.securityPosture, 'starter');
  assert.equal(state.runtime?.staticWebAppName, config.staticWebAppName);
  assert.equal(state.registryAuthentication, 'credential');
  assert.equal(state.acrAdminEnabled, true);
  assert.ok(fake.requests.some(request => new URL(request).pathname === '/api/todos'));
  assert.ok(fake.requests.some(request => new URL(request).pathname === '/api/health/ready'));
  assert.deepEqual(planDemoPublication(config, state).pending, []);
  assert.equal(fake.requests.some(request => request.includes('/providers/Microsoft.Authorization?')), false);
  const image = fake.calls.findIndex(call => call.includes('acr') && call.includes('build'));
  const infrastructure = fake.calls.findIndex(call => call.includes('infra/demo.bicep'));
  const schema = fake.calls.findIndex(call => call.includes('/Action:Publish'));
  const backend = fake.calls.findIndex(call => call.includes('infra/demo-runtime.bicep'));
  const staticDeploy = fake.calls.findIndex(call => call.includes('swa') && call.includes('deploy'));
  assert.ok(infrastructure < image && image < schema && schema < backend && backend < staticDeploy);
  const firewallCreate = fake.calls.findIndex(call => call.includes('firewall-rule') && call.includes('create'));
  const firewallDelete = fake.calls.findIndex(call => call.includes('firewall-rule') && call.includes('delete'));
  assert.ok(firewallCreate < schema && schema < firewallDelete && firewallDelete < backend);
  assert.ok(fake.calls[firewallCreate]!.includes(config.schemaRunnerIp));
  const swa = fake.calls[staticDeploy]!;
  assert.deepEqual(swa.slice(swa.indexOf('swa')), ['swa', 'deploy', join(built.directory, 'static'),
    '--env', 'production', '--no-use-keychain']);
  assert.equal(fake.calls.some(call => call.includes('static-deployment-token-for-tests')), false);
  assert.deepEqual(fake.swaEnvironments, [{
    SWA_CLI_DEPLOYMENT_TOKEN: 'static-deployment-token-for-tests',
    AZURE_STATIC_WEB_APPS_API_TOKEN: '',
    AZURE_CLIENT_ID: '',
    AZURE_CLIENT_SECRET: '',
    AZURE_TENANT_ID: '',
    AZURE_SUBSCRIPTION_ID: '',
  }]);
  const saved = await readFile(demoPublicationStatePath(config), 'utf8');
  assert.doesNotMatch(saved, /token|password|static-deployment-token-for-tests/i);
  assert.equal((await readDemoPublicationState(config)).workspaceHome, process.cwd());
  const infrastructureParameters = JSON.parse(
    await readFile(`${demoPublicationStatePath(config)}.infrastructure.parameters.json`, 'utf8'),
  );
  assert.equal(infrastructureParameters.parameters.registryName.value, 'example');
  const runtimeParameters = JSON.parse(await readFile(`${demoPublicationStatePath(config)}.runtime.parameters.json`, 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(runtimeParameters.parameters)
    .filter(([name]) => ['applicationName', 'environmentName', 'runtimeIdentityName', 'registryName',
      'sqlServerName', 'databaseName', 'staticWebAppName'].includes(name))
    .map(([name, parameter]) => [name, (parameter as { value: unknown }).value])), {
    applicationName: config.applicationName,
    environmentName: 'env',
    runtimeIdentityName: 'runtime',
    registryName: 'example',
    sqlServerName: 'server',
    databaseName: 'app',
    staticWebAppName: config.staticWebAppName,
  });
  assert.equal(runtimeParameters.parameters.staticWebAppLocation.value, config.staticWebAppLocation);
  assert.equal(runtimeParameters.parameters.securityPosture.value, 'starter');
  assert.equal(JSON.stringify(runtimeParameters).includes('password'), false);
  assert.equal(JSON.stringify(runtimeParameters).includes('credential'), false);
  const before = fake.calls.length;
  await publishDemo(config, fake.runner, fake.fetcher, planDemoPublication(config, state).approval);
  assert.equal(fake.calls.slice(before).some(call => call.includes('deployment') || call.includes('build')), false);
});

test('image failure retains infrastructure and resumes without redeploying the foundation', async t => {
  const built = await buildSelectedApplication('.', 'todo', 'public-demo');
  t.after(() => rm(built.directory, { recursive: true, force: true }));
  const config = demoPublicationSchema.parse({ ...base, selectedArtifact: built.directory,
    deploymentId: '14141414-1414-4141-8141-141414141414' });
  t.after(() => cleanup(config));
  const failed = harness(config, 'image');
  await assert.rejects(
    publishDemo(config, failed.runner, failed.fetcher, planDemoPublication(config).approval),
    /image rejected/,
  );
  const infrastructureState = await readDemoPublicationState(config);
  assert.equal(infrastructureState.stage, 'infrastructure');
  assert.ok(infrastructureState.infrastructure);
  assert.equal(infrastructureState.pinnedImages, null);

  const resumed = harness(config);
  const state = await publishDemo(
    config, resumed.runner, resumed.fetcher, planDemoPublication(config, infrastructureState).approval,
  );
  assert.equal(state.stage, 'ready');
  assert.equal(resumed.calls.some(call => call.includes('infra/demo.bicep')), false);
  assert.equal(resumed.calls.some(call => call.includes('acr') && call.includes('build')), true);
});

test('schema, backend, and static verification failures block all later publication stages', async t => {
  const built = await buildSelectedApplication('.', 'todo', 'public-demo');
  t.after(() => rm(built.directory, { recursive: true, force: true }));
  for (const [failure, deploymentId, lastStage] of [
    ['schema', '99999999-9999-4999-8999-999999999999', 'artifacts'],
    ['backend', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'schema'],
    ['static', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'backend'],
  ] as const) {
    const config = demoPublicationSchema.parse({ ...base, selectedArtifact: built.directory, deploymentId });
    t.after(() => cleanup(config));
    const fake = harness(config, failure);
    await assert.rejects(publishDemo(config, fake.runner, fake.fetcher, planDemoPublication(config).approval),
      failure === 'schema' ? /schema rejected/ :
        failure === 'backend' ? /Backend readiness/ : /Static content/);
    assert.equal((await readDemoPublicationState(config)).stage, lastStage);
    assert.equal(fake.calls.some(call => call.includes('swa') && call.includes('deploy')), failure === 'static');
    if (failure === 'schema') assert.equal(fake.calls.some(call => call.includes('infra/demo-runtime.bicep')), false);
  }
});
