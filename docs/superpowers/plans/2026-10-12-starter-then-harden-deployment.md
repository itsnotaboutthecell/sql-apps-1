# Starter-Then-Harden Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a working public synthetic demo deployable with ordinary Contributor-level permissions, then provide a separately approved in-place hardening operation that switches ACR pulls to managed identity.

**Architecture:** Keep Static Web Apps, Container Apps, internal DAB, and managed-identity Azure SQL unchanged. Starter publication enables ACR administrator access and lets ARM resolve `listCredentials()` directly into a Container App secret; hardening later creates the scoped `AcrPull` assignment, redeploys the same runtime with identity-based registry authentication, verifies it, and disables ACR administrator access.

**Tech Stack:** Node.js 22, TypeScript 5.9, Zod 4, Node test runner, Azure CLI, Bicep, Azure Static Web Apps CLI, Azure Container Apps, Azure Container Registry, Azure SQL Database.

---

## File Map

### Create

- `src/demo-init.ts` — derive a strict Starter publication configuration from the selected app and signed-in Azure context.
- `src/demo-runtime.ts` — own shared runtime parameter construction, deployment, readiness, and public acceptance.
- `src/demo-hardening.ts` — own hardening plans, state, resumable stages, and status.
- `src/demo-cleanup.ts` — plan and delete only reconciled deployment-owned resources.
- `infra/demo-harden-role.bicep` — create only the owned registry-scoped `AcrPull` assignment.
- `tests/demo-init.test.ts` — guided configuration and no-write Azure discovery tests.
- `tests/demo-hardening.test.ts` — hardening order, failure, resume, and state tests.
- `tests/demo-cleanup.test.ts` — cleanup ownership, ordering, approval, and shared-resource preservation.

### Modify

- `src/azure-preflight.ts` — make permission/provider checks explicit for `starter` versus `hardened`.
- `src/demo-publication.ts` — require Starter posture, persist posture evidence, and delegate runtime behavior.
- `src/cli.ts` — expose `demo-init` and `demo-harden`, and improve Starter/Hardened output.
- `infra/demo.bicep` — remove the initial role assignment and enable ACR administrator access for Starter.
- `infra/demo-runtime.bicep` — support explicit Starter or Hardened registry authentication.
- `tests/azure-preflight.test.ts` — prove Contributor-compatible Starter preflight and IAM-gated hardening.
- `tests/demo-publication.test.ts` — prove approval binding, server-side secret handling, Starter state, and status.
- `tests/demo-infra.test.mjs` — compile and inspect both registry-authentication modes and the hardening role template.
- `tests/guide.test.mjs` — enforce idea-to-deployment-first documentation.
- `azure-demo-target.example.json` — add explicit Starter posture.
- `azure-demo-publication.example.json` — add explicit Starter posture and guided fields.
- `docs/reference/demo-deployment.md` — document the guided Starter journey and later hardening.
- `docs/guides/sharing.md` — make Starter the recommended synthetic-demo path.
- `docs/maintainers/hosting-decision.md` — record the registry-authentication posture boundary.
- `.azure/plan.md` — replace the IAM-blocked initial deployment with Starter validation; retain hardening as optional follow-up.

Do not alter the authenticated `role-based-data` or full-foundation deployment paths.

---

### Task 1: Make Azure Preflight Posture-Aware

**Files:**
- Modify: `src/azure-preflight.ts`
- Modify: `tests/azure-preflight.test.ts`
- Modify: `azure-demo-target.example.json`

- [ ] **Step 1: Write failing schema and permission tests**

Add explicit posture to the fixture:

```ts
const target = {
  profile: 'public-demo' as const,
  securityPosture: 'starter' as const,
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceGroup: 'sql-apps-demo',
  location: 'eastus',
};
```

Replace the role-assignment denial case in the general failure table with focused tests:

```ts
test('starter preflight does not require role assignment writes', async () => {
  const fake = harness({
    permissions: [{ actions: ['*'], notActions: ['Microsoft.Authorization/roleAssignments/write'] }],
  });
  const result = await preflightDemo(target, fake.runner, fake.fetcher);
  assert.equal(result.securityPosture, 'starter');
  assert.equal(result.authorization.status, 'eligible-for-what-if');
});

test('starter preflight requires server-side ACR credential access', async () => {
  const fake = harness({
    permissions: [{ actions: ['*'], notActions: ['Microsoft.ContainerRegistry/registries/listCredentials/action'] }],
  });
  await assert.rejects(preflightDemo(target, fake.runner, fake.fetcher),
    (error: unknown) => error instanceof DemoPreflightError &&
      error.code === 'WRITE_AUTHORIZATION_MISSING' &&
      /listCredentials/.test(error.message));
});

test('hardening preflight requires role assignment writes', async () => {
  const fake = harness({
    permissions: [{ actions: ['*'], notActions: ['Microsoft.Authorization/roleAssignments/write'] }],
  });
  await assert.rejects(preflightDemo({ ...target, securityPosture: 'hardened' }, fake.runner, fake.fetcher),
    (error: unknown) => error instanceof DemoPreflightError &&
      error.code === 'WRITE_AUTHORIZATION_MISSING' &&
      /roleAssignments/.test(error.message));
});
```

Also add `{ ...target, securityPosture: 'automatic' }` to the invalid input cases.

- [ ] **Step 2: Compile and verify the tests fail**

Run:

```powershell
npx tsc
node --test dist\tests\azure-preflight.test.js
```

Expected: FAIL because `securityPosture` is not accepted and Starter still requires `roleAssignments/write`.

- [ ] **Step 3: Add the posture contract and conditional requirements**

In `src/azure-preflight.ts`, make posture mandatory:

```ts
export const demoTargetSchema = z.strictObject({
  profile: z.literal('public-demo'),
  securityPosture: z.enum(['starter', 'hardened']),
  tenantId: guid,
  subscriptionId: guid,
  resourceGroup: z.string().regex(/^[a-zA-Z0-9_().-]{1,90}$/).refine(value => !value.endsWith('.')),
  location: z.string().regex(/^[a-z][a-z0-9]{1,31}$/),
  staticWebAppLocation: z.string().regex(/^[a-z][a-z0-9]{1,31}$/).optional(),
});
```

Build provider checks without requiring the Authorization provider for Starter:

```ts
const baseProviders = {
  'Microsoft.App': ['managedEnvironments', 'containerApps'],
  'Microsoft.Sql': ['servers'],
  'Microsoft.Network': ['virtualNetworks'],
  'Microsoft.ContainerRegistry': ['registries'],
  'Microsoft.ManagedIdentity': ['userAssignedIdentities'],
  'Microsoft.Web': ['staticSites', 'staticSites/linkedBackends'],
} as const;

const providers = target.securityPosture === 'hardened'
  ? { ...baseProviders, 'Microsoft.Authorization': ['roleAssignments'] as const }
  : baseProviders;
```

Construct posture-specific permission lists:

```ts
const starterActions = [
  'Microsoft.Resources/deployments/write',
  ...Object.entries(baseProviders).flatMap(([namespace, types]) =>
    types.map(type => `${namespace}/${type}/write`)),
  'Microsoft.Sql/servers/databases/write',
  'Microsoft.Sql/servers/administrators/write',
  'Microsoft.Sql/servers/virtualNetworkRules/write',
  'Microsoft.Sql/servers/firewallRules/write',
  'Microsoft.Sql/servers/firewallRules/delete',
  'Microsoft.Network/virtualNetworks/subnets/write',
  'Microsoft.Network/virtualNetworks/subnets/join/action',
  'Microsoft.Network/virtualNetworks/subnets/joinViaServiceEndpoint/action',
  'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
  'Microsoft.ContainerRegistry/registries/scheduleRun/action',
  'Microsoft.ContainerRegistry/registries/runs/read',
  'Microsoft.ContainerRegistry/registries/listCredentials/action',
  'Microsoft.Web/staticSites/listSecrets/action',
  ...(group === null ? ['Microsoft.Resources/subscriptions/resourceGroups/write'] : []),
];
const actions = target.securityPosture === 'hardened'
  ? [...starterActions, 'Microsoft.Authorization/roleAssignments/write']
  : starterActions;
```

Return `securityPosture: target.securityPosture` in the preflight report.

- [ ] **Step 4: Update the example target**

Add:

```json
"securityPosture": "starter"
```

immediately after `"profile": "public-demo"` in `azure-demo-target.example.json`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\azure-preflight.test.js
```

Expected: all Azure preflight tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src\azure-preflight.ts tests\azure-preflight.test.ts azure-demo-target.example.json
git commit -m "feat: add starter Azure preflight" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Bind Starter Posture Into Publication

**Files:**
- Modify: `src/demo-publication.ts`
- Modify: `tests/demo-publication.test.ts`
- Modify: `azure-demo-publication.example.json`

- [ ] **Step 1: Write failing configuration, approval, and state tests**

Add `securityPosture: 'starter' as const` to the publication fixture. Add:

```ts
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

test('publication review and state report Starter posture', async t => {
  const built = await buildSelectedApplication('.', 'todo', 'public-demo');
  t.after(() => rm(built.directory, { recursive: true, force: true }));
  const config = demoPublicationSchema.parse({
    ...base, selectedArtifact: built.directory,
    deploymentId: '12121212-1212-4121-8121-121212121212',
  });
  t.after(() => cleanup(config));
  const plan = planDemoPublication(config);
  assert.match(plan.review.join('\n'), /Security posture: Starter/);
  const fake = harness(config);
  const state = await publishDemo(config, fake.runner, fake.fetcher, plan.approval);
  assert.equal(state.securityPosture, 'starter');
});
```

Assert that changing `securityPosture` changes the approval ID.

- [ ] **Step 2: Compile and verify failure**

Run:

```powershell
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: FAIL because publication and state schemas do not contain `securityPosture`.

- [ ] **Step 3: Implement the strict publication and state fields**

Add to `demoPublicationSchema`:

```ts
securityPosture: z.literal('starter'),
```

Add to `demoPublicationStateSchema`:

```ts
securityPosture: z.enum(['starter', 'hardened', 'partially-hardened']),
registryAuthentication: z.enum(['credential', 'managed-identity']),
acrAdminEnabled: z.boolean(),
```

Add a non-completed initial state:

```ts
const demoPublicationStateStages = ['planned', ...demoPublicationStages] as const;
stage: z.enum(demoPublicationStateStages),
```

`planned` is local orchestration state only and must never be reported as a
completed Azure stage.

Initialize Starter state with:

```ts
securityPosture: 'starter',
registryAuthentication: 'credential',
acrAdminEnabled: true,
```

Pass posture into preflight:

```ts
await preflightDemo({
  profile: config.profile,
  securityPosture: config.securityPosture,
  tenantId: config.tenantId,
  subscriptionId: config.subscriptionId,
  resourceGroup: config.resourceGroup,
  location: config.location,
  staticWebAppLocation: config.staticWebAppLocation,
}, runner, fetcher);
```

Add this exact review line:

```ts
'Security posture: Starter; ACR image pulls use an Azure-managed Container App secret until separately approved hardening',
```

Remove `role assignment` from the excluded list and replace it with:

```ts
'No real/customer data, production SLA, custom domain, paid SQL fallback, production hardening, or default-hosting change',
```

- [ ] **Step 4: Update the publication example**

Add:

```json
"securityPosture": "starter"
```

after the profile in `azure-demo-publication.example.json`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: all publication tests PASS after updating existing state fixtures.

- [ ] **Step 6: Commit**

```powershell
git add src\demo-publication.ts tests\demo-publication.test.ts azure-demo-publication.example.json
git commit -m "feat: bind starter deployment posture" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Deploy Starter Registry Authentication Server-Side

**Files:**
- Modify: `infra/demo.bicep`
- Modify: `infra/demo-runtime.bicep`
- Modify: `tests/demo-infra.test.mjs`
- Modify: `tests/demo-publication.test.ts`

- [ ] **Step 1: Write failing infrastructure assertions**

In `tests/demo-infra.test.mjs`, compile `infra/demo.bicep` and
`infra/demo-runtime.bicep`, then assert:

```js
const registry = foundation.resources.find(resource =>
  resource.type === 'Microsoft.ContainerRegistry/registries');
assert.equal(registry.properties.adminUserEnabled, true);
assert.equal(foundation.resources.some(resource =>
  resource.type === 'Microsoft.Authorization/roleAssignments'), false);

const app = runtime.resources.find(resource =>
  resource.type === 'Microsoft.App/containerApps');
assert.match(JSON.stringify(app.properties.configuration.secrets), /listCredentials/);
assert.equal(app.properties.configuration.registries[0].passwordSecretRef, 'registry-password');
assert.equal('identity' in app.properties.configuration.registries[0], false);
```

In `tests/demo-publication.test.ts`, assert that the runtime parameter file:

```ts
assert.equal(JSON.stringify(runtimeParameters).includes('password'), false);
assert.equal(JSON.stringify(runtimeParameters).includes('credential'), false);
```

Change the ordering assertion to require the registry infrastructure before
image publication:

```ts
assert.ok(infrastructure < image && image < schema && schema < backend && backend < staticDeploy);
```

Add a failure test proving an image build failure persists only the completed
`infrastructure` stage and resumes from image publication without recreating
the foundation.

- [ ] **Step 2: Run infrastructure tests and verify failure**

Run:

```powershell
npm run infra:build
npm run infra:test-demo
```

Expected: FAIL because ACR administrator access is disabled and the role assignment still exists.

- [ ] **Step 3: Change the foundation template to Starter**

In `infra/demo.bicep`, set:

```bicep
properties: {
  adminUserEnabled: true
  publicNetworkAccess: 'Enabled'
  policies: {
    azureADAuthenticationAsArmPolicy: {
      status: 'enabled'
    }
  }
}
```

Delete `acrPull` and the `pullRole` resource. Do not change the runtime identity,
SQL, VNet, subnet rule, or ownership outputs.

- [ ] **Step 4: Provision the registry before publishing images**

Change:

```ts
export const demoPublicationStages = [
  'infrastructure', 'artifacts', 'schema', 'backend', 'static', 'ready',
] as const;
```

Initialize unsaved orchestration state with `stage: 'planned'`. Deploy
`infra/demo.bicep` when the state is `planned`, persist `infrastructure`, then
run `publishImages` and persist `artifacts`. The foundation parameters must
include:

```ts
registryName: config.registryServer.split('.')[0]!,
```

This removes the existing impossible dependency in which publication tries to
build images in a registry that the later infrastructure stage has not created.

- [ ] **Step 5: Add explicit runtime authentication mode**

In `infra/demo-runtime.bicep`, add:

```bicep
@allowed([
  'starter'
  'hardened'
])
param securityPosture string

var starterRegistry = securityPosture == 'starter'
var registryCredentials = starterRegistry ? registry.listCredentials() : null
```

Set Container App configuration:

```bicep
secrets: starterRegistry ? [
  {
    name: 'registry-password'
    value: registryCredentials!.passwords[0].value
  }
] : []
registries: starterRegistry ? [
  {
    server: registry.properties.loginServer
    username: registryCredentials!.username
    passwordSecretRef: 'registry-password'
  }
] : [
  {
    server: registry.properties.loginServer
    identity: runtimeIdentity.id
  }
]
```

Do not output `registryCredentials` or use it in tags, environment variables,
deployment names, or diagnostics.

- [ ] **Step 6: Pass Starter posture from publication**

Add to runtime parameters in `publishDemo`:

```ts
securityPosture: config.securityPosture,
```

Update the publication harness to inspect the runtime deployment arguments and
assert there is no secret parameter.

- [ ] **Step 7: Compile and run focused tests**

Run:

```powershell
npm run infra:build
npm run infra:test-demo
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: all commands PASS.

- [ ] **Step 8: Commit**

```powershell
git add infra\demo.bicep infra\demo-runtime.bicep tests\demo-infra.test.mjs src\demo-publication.ts tests\demo-publication.test.ts
git commit -m "feat: deploy starter registry credentials safely" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Extract Shared Runtime Deployment and Acceptance

**Files:**
- Create: `src/demo-runtime.ts`
- Modify: `src/demo-publication.ts`
- Modify: `tests/demo-publication.test.ts`

- [ ] **Step 1: Add a characterization test for the shared boundary**

Export runtime types and add:

```ts
test('runtime deployment validates the reviewed resource names and acceptance', async t => {
  const built = await buildSelectedApplication('.', 'todo', 'public-demo');
  t.after(() => rm(built.directory, { recursive: true, force: true }));
  const config = demoPublicationSchema.parse({
    ...base, selectedArtifact: built.directory,
    deploymentId: '13131313-1313-4131-8131-131313131313',
  });
  t.after(() => cleanup(config));
  const fake = harness(config);
  const state = await publishDemo(config, fake.runner, fake.fetcher, planDemoPublication(config).approval);
  assert.equal(state.runtime?.staticWebAppName, config.staticWebAppName);
  assert.equal(state.securityPosture, 'starter');
});
```

- [ ] **Step 2: Run the characterization test**

Run:

```powershell
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: PASS before refactoring.

- [ ] **Step 3: Create the focused runtime module**

Move these responsibilities from `src/demo-publication.ts` to
`src/demo-runtime.ts` without changing behavior:

```ts
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
  pinnedImages: PinnedImages,
  securityPosture: 'starter' | 'hardened',
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
```

Export `deployDemoRuntime`, `verifyDemoRuntime`, and `acceptDemoRuntime`.
`deployDemoRuntime` must accept a callback that creates the non-secret parameter
file, so state-path ownership remains in `demo-publication.ts`.

- [ ] **Step 4: Delegate publication runtime behavior**

Replace inline runtime deployment/readiness/acceptance code with imports from
`src/demo-runtime.ts`. Keep publication stage ordering and persisted state
unchanged.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: all publication tests PASS with no changed call order.

- [ ] **Step 6: Commit**

```powershell
git add src\demo-runtime.ts src\demo-publication.ts tests\demo-publication.test.ts
git commit -m "refactor: isolate public demo runtime operations" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Generate a Guided Starter Configuration

**Files:**
- Create: `src/demo-init.ts`
- Create: `tests/demo-init.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing no-write discovery tests**

Create a runner/fetch harness and test:

```ts
test('guided init derives a complete Starter publication without Azure writes', async () => {
  const calls: string[][] = [];
  const accessToken = [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({
      oid: '33333333-3333-4333-8333-333333333333',
      name: 'Demo User',
    })).toString('base64url'),
    'signature',
  ].join('.');
  const runner: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'account' && args[1] === 'show') {
      return JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
      });
    }
    if (args[0] === 'account' && args[1] === 'get-access-token') {
      return JSON.stringify({ accessToken });
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.ipify.org?format=json');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({ ip: '203.0.113.10' });
  };
  const config = await initDemoPublication({
    subscriptionId: '11111111-1111-4111-8111-111111111111',
    resourceGroup: 'alpowers',
    location: 'eastus',
    staticWebAppLocation: 'eastus2',
    selectedApplication: 'todo',
    selectedArtifact: 'C:\\artifact',
    owner: 'alpowers',
  }, runner, fetcher, () => '44444444-4444-4444-8444-444444444444');
  assert.equal(config.securityPosture, 'starter');
  assert.equal(config.registryServer, 'sqlappsdemo444444444444.azurecr.io');
  assert.equal(config.gatewayImage, `${config.registryServer}/sqlapps-todo-api:44444444`);
  assert.equal(config.schemaRunnerIp, '203.0.113.10');
  assert.equal(calls.some(call => call.includes('ad')), false);
  assert.ok(calls.every(call => !['create', 'update', 'set', 'delete'].includes(call[2] ?? '')));
});
```

Also test refusal to overwrite an existing configuration in the CLI test path
and rejection of a malformed public-IP response.

- [ ] **Step 2: Compile and verify failure**

Run:

```powershell
npx tsc
node --test dist\tests\demo-init.test.js
```

Expected: FAIL because `src/demo-init.ts` does not exist.

- [ ] **Step 3: Implement deterministic configuration derivation**

Create:

```ts
export const demoInitOptionsSchema = z.strictObject({
  subscriptionId: z.string().uuid(),
  resourceGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/),
  location: z.string().regex(/^[a-z0-9]+$/),
  staticWebAppLocation: z.string().regex(/^[a-z0-9]+$/),
  selectedApplication: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  selectedArtifact: z.string().min(1),
  owner: z.string().trim().min(1).max(256),
});

export async function initDemoPublication(
  input: z.input<typeof demoInitOptionsSchema>,
  runner: Run,
  fetcher: typeof fetch = fetch,
  newId: () => string = randomUUID,
): Promise<DemoPublicationConfig> {
  const options = demoInitOptionsSchema.parse(input);
  const account = z.object({
    id: z.literal(options.subscriptionId),
    tenantId: z.string().uuid(),
  }).parse(JSON.parse(await runner('az', [
    'account', 'show', '--subscription', options.subscriptionId,
    '--query', '{id:id,tenantId:tenantId}', '-o', 'json',
  ])));
  const tokenEnvelope = z.object({ accessToken: z.string().min(1) }).parse(JSON.parse(
    await runner('az', [
      'account', 'get-access-token',
      '--subscription', options.subscriptionId,
      '--resource', 'https://management.azure.com/',
      '-o', 'json',
    ], { sensitiveOutput: true }),
  ));
  const tokenParts = tokenEnvelope.accessToken.split('.');
  if (tokenParts.length !== 3) throw new Error('Azure CLI returned a malformed ARM access token');
  const claims = z.object({
    oid: z.string().uuid(),
    name: z.string().trim().min(1).max(128).optional(),
    preferred_username: z.string().trim().min(1).max(128).optional(),
  }).parse(JSON.parse(Buffer.from(tokenParts[1]!, 'base64url').toString('utf8')));
  const sqlAdminName = claims.name ?? claims.preferred_username;
  if (!sqlAdminName) throw new Error('The ARM identity token does not identify the SQL administrator name');
  const ipResponse = await fetcher('https://api.ipify.org?format=json', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
    redirect: 'error',
  });
  if (!ipResponse.ok) throw new Error(`Public IPv4 discovery returned HTTP ${ipResponse.status}`);
  const schemaRunnerIp = z.object({ ip: z.ipv4() }).parse(await ipResponse.json()).ip;
  const deploymentId = z.string().uuid().parse(newId()).toLowerCase();
  const token = deploymentId.replaceAll('-', '').slice(0, 12);
  const short = deploymentId.slice(0, 8);
  const registryName = `sqlappsdemo${token}`;
  const registryServer = `${registryName}.azurecr.io`;
  return demoPublicationSchema.parse({
    version: 1,
    profile: 'public-demo',
    securityPosture: 'starter',
    hosting: 'static-web-apps',
    name: 'sqlapps',
    subscriptionId: account.id,
    tenantId: account.tenantId,
    resourceGroup: options.resourceGroup,
    location: options.location,
    staticWebAppLocation: options.staticWebAppLocation,
    deploymentId,
    applicationName: `sqlapps-${short}-web`,
    staticWebAppName: `sqlapps-${short}-static`,
    registryServer,
    gatewayImage: `${registryServer}/sqlapps-${options.selectedApplication}-api:${short}`,
    dabImage: `${registryServer}/sqlapps-${options.selectedApplication}-dab:${short}`,
    selectedApplication: options.selectedApplication,
    selectedArtifact: resolve(options.selectedArtifact),
    sqlAdminObjectId: claims.oid,
    sqlAdminName,
    schemaRunnerIp,
    cost: { intent: 'review-paid-costs', acknowledgeFixedCharges: true },
    sqlBillingMode: 'free-paused',
    sqlSku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 },
    sqlMaxSizeBytes: 32 * 1024 ** 3,
    sqlBackupRedundancy: 'Local',
    tags: { environment: 'synthetic-demo', owner: options.owner },
  });
}
```

Change `infra/demo.bicep` to accept `registryName` as a parameter rather than
deriving it with `uniqueString`. Add
`registryName: config.registryServer.split('.')[0]!` to the foundation
deployment parameters, and retain the output equality check against the
reviewed `registryServer`.

- [ ] **Step 4: Add the CLI command**

Add `demo-init` to help and parse:

```text
demo-init <new-publication.json>
  --subscription <id>
  --resource-group <name>
  --location <region>
  --static-web-app-location <region>
  --application <name>
  --artifact <absolute-path>
  --owner <tag-value>
```

Use `existsSync(resolve(configPath))` to refuse overwrite, call
`initDemoPublication`, save with `saveJson`, and print:

```text
Wrote <path> for Starter public-demo publication. Nothing was created in Azure.
Next (read-only): demo-preflight <target>, then demo-publish <path>.
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-init.test.js dist\tests\demo-publication.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src\demo-init.ts tests\demo-init.test.ts src\cli.ts infra\demo.bicep src\demo-publication.ts tests\demo-publication.test.ts
git commit -m "feat: generate starter publication configuration" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Report Deployment and Security Posture Separately

**Files:**
- Modify: `src/demo-publication.ts`
- Modify: `tests/demo-publication.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing status assertions**

Extend the status harness for:

```ts
if (args[0] === 'acr' && args[1] === 'show') {
  return JSON.stringify({ adminUserEnabled: true });
}
if (args[0] === 'containerapp' && args[1] === 'show') {
  return JSON.stringify({
    provisioningState: 'Succeeded',
    runningStatus: 'Running',
    registryAuthentication: 'credential',
  });
}
```

Assert:

```ts
const status = await demoPublicationStatus(config, fake.runner, fake.fetcher);
assert.equal(status.deployment, 'ready');
assert.equal(status.securityPosture, 'starter');
assert.equal(status.registryAuthentication, 'credential');
assert.equal(status.acrAdminEnabled, true);
assert.match(status.nextAction, /demo-harden/);
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: FAIL because status returns only stage, timestamp, and resources.

- [ ] **Step 3: Implement bounded posture reconciliation**

Query only non-secret registry/runtime fields:

```ts
const registry = z.object({ adminUserEnabled: z.boolean() }).parse(JSON.parse(
  await runner('az', [
    'acr', 'show',
    '--subscription', config.subscriptionId,
    '--resource-group', config.resourceGroup,
    '--name', state.infrastructure.registryName,
    '--query', '{adminUserEnabled:adminUserEnabled}',
    '-o', 'json',
  ]),
));
```

Return:

```ts
return {
  deployment: state.stage === 'ready' && resources.health?.linkedBackend === 200 ? 'ready' : 'not-ready',
  securityPosture: state.securityPosture,
  registryAuthentication: state.registryAuthentication,
  acrAdminEnabled: registry.adminUserEnabled,
  stage: state.stage,
  updatedAt: state.updatedAt,
  resources,
  nextAction: state.securityPosture === 'starter'
    ? `Review and run demo-harden for deployment ${config.deploymentId} when scoped IAM permission is available.`
    : 'No registry-authentication hardening is pending.',
};
```

Do not call `az acr credential show`.

- [ ] **Step 4: Improve completion output**

After Starter publication, print:

```text
Public-demo publication completed at <url>.
Security posture: Starter.
Next: run demo-status, then review demo-harden when scoped IAM permission is available.
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-publication.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src\demo-publication.ts tests\demo-publication.test.ts src\cli.ts
git commit -m "feat: report starter deployment posture" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Add the Resumable Hardening State Machine

**Files:**
- Create: `src/demo-hardening.ts`
- Create: `infra/demo-harden-role.bicep`
- Create: `tests/demo-hardening.test.ts`
- Modify: `src/demo-runtime.ts`
- Modify: `src/demo-publication.ts`

- [ ] **Step 1: Write failing plan and ordering tests**

Define expected stages:

```ts
const hardeningStages = [
  'role-assignment',
  'identity-runtime',
  'accepted',
  'credentials-disabled',
  'verified',
] as const;
```

Test the plan:

```ts
test('hardening review binds the ready Starter deployment and exact pending stages', async t => {
  const fixture = await readyStarterFixture(t);
  const plan = planDemoHardening(fixture.config, fixture.publication);
  assert.deepEqual(plan.pending, hardeningStages);
  assert.match(plan.review.join('\n'), /AcrPull/);
  assert.match(plan.review.join('\n'), /disable ACR administrator access only after acceptance/);
  assert.notEqual(plan.approval, planDemoHardening(
    { ...fixture.config, deploymentId: '99999999-9999-4999-8999-999999999999' },
    fixture.publication,
  ).approval);
});
```

Test safe order:

```ts
test('hardening assigns pull, deploys identity auth, accepts, disables credentials, then verifies', async t => {
  const fixture = await readyStarterFixture(t);
  const fake = hardeningHarness(fixture.config);
  const plan = planDemoHardening(fixture.config, fixture.publication);
  const state = await hardenDemo(
    fixture.config, fixture.publication, fake.runner, fake.fetcher, plan.approval,
  );
  assert.equal(state.stage, 'verified');
  assert.equal(state.securityPosture, 'hardened');
  const role = fake.calls.findIndex(call => call.includes('infra/demo-harden-role.bicep'));
  const runtime = fake.calls.findIndex(call => call.includes('infra/demo-runtime.bicep'));
  const disable = fake.calls.findIndex(call =>
    call.includes('acr') && call.includes('update') && call.includes('false'));
  const restart = fake.calls.findIndex(call =>
    call.includes('containerapp') && call.includes('revision') && call.includes('restart'));
  assert.ok(role < runtime && runtime < disable && disable < restart);
});
```

Add failure tests proving:

- role/runtime/acceptance failure leaves publication state as Starter;
- disable/final verification failure records `partially-hardened`;
- rerun resumes from the saved hardening stage;
- repeated success makes no Azure write.

- [ ] **Step 2: Compile and verify failure**

Run:

```powershell
npx tsc
node --test dist\tests\demo-hardening.test.js
```

Expected: FAIL because hardening module and template do not exist.

- [ ] **Step 3: Create the narrow role-assignment template**

Create `infra/demo-harden-role.bicep`:

```bicep
targetScope = 'resourceGroup'

param runtimeIdentityName string
param registryName string

var acrPull = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtimeIdentity.id, acrPull)
  scope: registry
  properties: {
    roleDefinitionId: acrPull
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output roleAssignmentId string = pullRole.id
```

- [ ] **Step 4: Implement hardening schemas and approval**

Create strict state:

```ts
export const demoHardeningStateSchema = z.strictObject({
  version: z.literal(1),
  profile: z.literal('public-demo'),
  stage: z.enum(hardeningStages),
  workspaceHome: z.string().min(1),
  publicationConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  publicationUpdatedAt: z.iso.datetime(),
  securityPosture: z.enum(['starter', 'partially-hardened', 'hardened']),
  roleAssignmentId: z.string().startsWith('/subscriptions/').nullable(),
  updatedAt: z.iso.datetime(),
});
```

Store it beside publication state using:

```ts
export const demoHardeningStatePath = (config: DemoPublicationConfig) =>
  `${demoPublicationStatePath(config)}.hardening.json`;
```

`planDemoHardening` must reject a publication that is not at `ready`, does not
belong to the current binding, or lacks runtime/infrastructure/pinned-image
state. Hash the config hash, publication timestamp, workspace home, and pending
stages into a 24-character approval ID.

- [ ] **Step 5: Implement the safe hardening stages**

In `hardenDemo`:

1. Call `preflightDemo` with `securityPosture: 'hardened'`.
2. Deploy `infra/demo-harden-role.bicep`, validate its `roleAssignmentId`
   output, and persist that exact ID before continuing.
3. Reuse `deployDemoRuntime(..., 'hardened')`.
4. Run `acceptDemoRuntime`.
5. Disable ACR administrator access:

```ts
await runner('az', [
  'acr', 'update',
  '--subscription', config.subscriptionId,
  '--resource-group', config.resourceGroup,
  '--name', publication.infrastructure.registryName,
  '--admin-enabled', 'false',
]);
```

6. Query the active revision name, restart it, wait for readiness, and rerun
   acceptance:

```ts
const revision = z.string().min(1).parse((await runner('az', [
  'containerapp', 'revision', 'list',
  '--subscription', config.subscriptionId,
  '--resource-group', config.resourceGroup,
  '--name', config.applicationName,
  '--query', '[?properties.active].name | [0]',
  '-o', 'tsv',
])).trim());
await runner('az', [
  'containerapp', 'revision', 'restart',
  '--subscription', config.subscriptionId,
  '--resource-group', config.resourceGroup,
  '--name', config.applicationName,
  '--revision', revision,
]);
await verifyDemoRuntime(publication.runtime, fetcher);
await acceptDemoRuntime(publication.runtime, config.selectedArtifact, fetcher);
```

Persist after each completed stage. After `accepted`, update publication state
to `partially-hardened` and `managed-identity`. After final verification, set:

```ts
securityPosture: 'hardened',
registryAuthentication: 'managed-identity',
acrAdminEnabled: false,
```

If credential disable or final verification fails, preserve
`partially-hardened`; do not claim success or silently redeploy Starter.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-hardening.test.js dist\tests\demo-publication.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src\demo-hardening.ts src\demo-runtime.ts src\demo-publication.ts infra\demo-harden-role.bicep tests\demo-hardening.test.ts
git commit -m "feat: add resumable demo hardening" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Wire the Hardening CLI and Status

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/demo-publication.ts`
- Modify: `tests/demo-hardening.test.ts`
- Modify: `tests/demo-publication.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add tests that execute:

```ts
await run(process.execPath, ['dist/src/cli.js', 'help']);
```

and require `demo-init`, `demo-harden`, and Starter/Hardened wording.

Add a test that invokes `demo-harden <config>` without approval and asserts:

```text
Pending hardening stages: role-assignment -> identity-runtime -> accepted -> credentials-disabled -> verified
Approval ID: <id>
After explicit approval: demo-harden <config> --approve <id>
```

Add a stale approval test requiring a fresh review.

- [ ] **Step 2: Compile and verify failure**

Run:

```powershell
npx tsc
node --test dist\tests\demo-hardening.test.js
```

Expected: FAIL because `demo-harden` is not routed.

- [ ] **Step 3: Add CLI routing**

Import:

```ts
import {
  hardenDemo, planDemoHardening, readDemoHardeningState,
  type DemoHardeningState,
} from './demo-hardening.js';
```

Route `demo-harden` beside `demo-publish`. It must:

- parse the same strict publication configuration;
- validate and read a ready publication state;
- read matching hardening state if present;
- print review output when `--approve` is absent;
- reject stale/wrong approval;
- print an exact resume command on failure;
- print `Security posture: Hardened` only after final verification.

Do not auto-run hardening after Starter publication.

- [ ] **Step 4: Reconcile hardening in status**

`demoPublicationStatus` should read matching hardening state if present and
combine it with live ACR/container state:

```ts
securityPosture:
  hardening?.stage === 'verified' && !registry.adminUserEnabled
    ? 'hardened'
    : hardening
      ? 'partially-hardened'
      : 'starter',
```

If live state contradicts saved state, return `deployment: 'not-ready'` and an
actionable mismatch instead of silently trusting either source.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-hardening.test.js dist\tests\demo-publication.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src\cli.ts src\demo-publication.ts tests\demo-hardening.test.ts tests\demo-publication.test.ts
git commit -m "feat: expose public demo hardening workflow" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Update the Idea-to-Deployment Documentation

**Files:**
- Modify: `docs/reference/demo-deployment.md`
- Modify: `docs/guides/sharing.md`
- Modify: `docs/maintainers/hosting-decision.md`
- Modify: `docs/reference/demo-cost.md`
- Modify: `tests/guide.test.mjs`
- Modify: `.azure/plan.md`

- [ ] **Step 1: Write failing documentation assertions**

Add:

```js
assert.match(demoDeployment,
  /Build[\s\S]*demo-init[\s\S]*demo-preflight[\s\S]*demo-publish[\s\S]*working URL[\s\S]*demo-harden/i);
assert.match(demoDeployment,
  /Starter[\s\S]*ordinary Contributor[\s\S]*Hardened[\s\S]*roleAssignments\/write/i);
assert.match(demoDeployment,
  /registry credentials[\s\S]*ARM[\s\S]*never enter the local publication process/i);
assert.match(sharing, /idea[\s\S]*Starter demo[\s\S]*working URL[\s\S]*harden/i);
assert.doesNotMatch(sharing, /publishing candidate.*not yet the default/i);
assert.match(hostingDecision, /Starter.*credential-based ACR pull.*Hardened.*managed identity/is);
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node --test tests\guide.test.mjs
```

Expected: FAIL because docs still describe the public-demo path as a candidate
and do not explain Starter/Hardened.

- [ ] **Step 3: Rewrite the primary journey**

Document this command order:

```powershell
npm run app:build -- todo public-demo
npm run azure -- demo-cost azure-demo-cost.json
npm run azure -- demo-init azure-demo-publication.json `
  --subscription <id> `
  --resource-group <name> `
  --location eastus `
  --static-web-app-location eastus2 `
  --application todo `
  --artifact <selected-artifact-path> `
  --owner <owner-tag>
npm run azure -- demo-preflight azure-demo-target.json
npm run azure -- demo-publish azure-demo-publication.json
npm run azure -- demo-publish azure-demo-publication.json --approve <reviewed-id>
npm run azure -- demo-status azure-demo-publication.json
```

After the working URL, document optional hardening:

```powershell
npm run azure -- demo-harden azure-demo-publication.json
npm run azure -- demo-harden azure-demo-publication.json --approve <reviewed-id>
```

State plainly:

- Starter is the default synthetic-demo posture.
- Starter needs ordinary Contributor-equivalent resource permissions plus ACR
  credential access.
- Hardened adds scoped `roleAssignments/write`.
- ACR passwords are resolved inside ARM and never reach the local process.
- Starter is not production readiness.

- [ ] **Step 4: Update the Azure validation plan**

In `.azure/plan.md`:

- change the initial validation target to Starter;
- remove initial `roleAssignments/write` as a blocker;
- add live Starter deployment and acceptance;
- keep hardening as an optional separately approved phase;
- preserve `alpowers` and unrelated resources;
- retain a fresh destructive confirmation before owned-resource cleanup.

- [ ] **Step 5: Run documentation tests**

Run:

```powershell
node --test tests\guide.test.mjs
```

Expected: all guide tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add docs\reference\demo-deployment.md docs\guides\sharing.md docs\maintainers\hosting-decision.md docs\reference\demo-cost.md tests\guide.test.mjs .azure\plan.md
git commit -m "docs: lead with starter deployment" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If `.azure/plan.md` is intentionally session-only, do not force-add it; update
it locally and omit it from the commit.

---

### Task 10: Add Deployment-Owned Cleanup

**Files:**
- Create: `src/demo-cleanup.ts`
- Create: `tests/demo-cleanup.test.ts`
- Modify: `src/cli.ts`
- Modify: `docs/reference/demo-deployment.md`

- [ ] **Step 1: Write failing ownership and ordering tests**

Create fixtures with unrelated resources in the shared group and exact owned
resources tagged with the deployment ID:

```ts
test('cleanup plans only exact deployment-owned resources in dependency order', async () => {
  const fixture = readyStarterState();
  const runner = cleanupRunner([
    resource(fixture.config, 'Microsoft.App/containerApps', fixture.config.applicationName),
    resource(fixture.config, 'Microsoft.Web/staticSites', fixture.config.staticWebAppName),
    resource(fixture.config, 'Microsoft.App/managedEnvironments', fixture.publication.infrastructure!.environmentName),
    resource(fixture.config, 'Microsoft.ManagedIdentity/userAssignedIdentities', fixture.publication.infrastructure!.runtimeIdentityName),
    resource(fixture.config, 'Microsoft.ContainerRegistry/registries', fixture.publication.infrastructure!.registryName),
    resource(fixture.config, 'Microsoft.Network/virtualNetworks', 'sqlapps-network'),
    resource(fixture.config, 'Microsoft.Sql/servers', fixture.publication.infrastructure!.sqlServerName),
    {
      id: `/subscriptions/${fixture.config.subscriptionId}/resourceGroups/${fixture.config.resourceGroup}` +
        '/providers/Microsoft.Web/sites/unrelated',
      type: 'Microsoft.Web/sites',
      name: 'unrelated',
      tags: { owner: 'alpowers' },
    },
  ]);
  const plan = await planDemoCleanup(fixture.config, fixture.publication, undefined, runner);
  assert.equal(plan.resources.some(item => item.id.endsWith('/unrelated')), false);
  assert.deepEqual(plan.resources.map(item => item.type), [
    'Microsoft.App/containerApps',
    'Microsoft.Web/staticSites',
    'Microsoft.Sql/servers',
    'Microsoft.App/managedEnvironments',
    'Microsoft.ManagedIdentity/userAssignedIdentities',
    'Microsoft.ContainerRegistry/registries',
    'Microsoft.Network/virtualNetworks',
  ]);
});
```

Add tests that:

- reject a tagged resource outside the exact subscription/resource group;
- reject an unknown tagged resource type rather than deleting it;
- include the exact hardening role-assignment ID first when present;
- reject a stale approval after inventory changes;
- remove local publication/hardening state only after Azure inventory is empty;
- never call `az group delete`.

- [ ] **Step 2: Compile and verify failure**

Run:

```powershell
npx tsc
node --test dist\tests\demo-cleanup.test.js
```

Expected: FAIL because `src/demo-cleanup.ts` does not exist.

- [ ] **Step 3: Implement strict inventory discovery**

Create:

```ts
const ownedResourceSchema = z.strictObject({
  id: z.string().startsWith('/subscriptions/'),
  name: z.string().min(1),
  type: z.enum([
    'Microsoft.App/containerApps',
    'Microsoft.Web/staticSites',
    'Microsoft.Sql/servers',
    'Microsoft.App/managedEnvironments',
    'Microsoft.ManagedIdentity/userAssignedIdentities',
    'Microsoft.ContainerRegistry/registries',
    'Microsoft.Network/virtualNetworks',
  ]),
  tags: z.record(z.string(), z.string()),
});

const deletionOrder = new Map([
  ['Microsoft.App/containerApps', 0],
  ['Microsoft.Web/staticSites', 1],
  ['Microsoft.Sql/servers', 2],
  ['Microsoft.App/managedEnvironments', 3],
  ['Microsoft.ManagedIdentity/userAssignedIdentities', 4],
  ['Microsoft.ContainerRegistry/registries', 5],
  ['Microsoft.Network/virtualNetworks', 6],
]);
```

Discover with:

```ts
const inventory = z.array(ownedResourceSchema).parse(JSON.parse(await runner('az', [
  'resource', 'list',
  '--subscription', config.subscriptionId,
  '--resource-group', config.resourceGroup,
  '--tag', `sql-apps-deployment=${config.deploymentId}`,
  '--query', '[].{id:id,name:name,type:type,tags:tags}',
  '-o', 'json',
])));
```

For every result, require:

```ts
const scope = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/`;
if (!item.id.toLowerCase().startsWith(scope.toLowerCase())) {
  throw new Error('Owned-resource discovery left the exact approved resource-group scope');
}
if (item.tags['sql-apps-deployment'] !== config.deploymentId ||
    item.tags['sql-apps-profile'] !== 'public-demo') {
  throw new Error('Resource ownership tags do not match the reviewed deployment');
}
```

Require the discovered IDs for every non-null publication output to match the
saved IDs or expected resource IDs. Fail closed on missing, extra, or unknown
tagged resources.

- [ ] **Step 4: Implement the approval-bound cleanup plan**

Return:

```ts
export interface DemoCleanupPlan {
  approval: string;
  resources: readonly { id: string; type: string; name: string }[];
  review: readonly string[];
  warning: string;
}
```

Hash the publication config hash, workspace home, deployment ID, optional exact
role-assignment ID, and ordered inventory into a 24-character approval.

The review must say:

```text
Delete only the listed resources tagged for deployment <id>.
Preserve resource group <name> and every unrelated resource.
Local publication state is removed only after Azure confirms the owned inventory is empty.
```

- [ ] **Step 5: Implement deletion and post-verification**

Delete an optional exact role-assignment ID first:

```ts
await runner('az', [
  'role', 'assignment', 'delete',
  '--subscription', config.subscriptionId,
  '--ids', hardening.roleAssignmentId,
]);
```

Delete each reviewed ID individually:

```ts
for (const resource of plan.resources) {
  await runner('az', [
    'resource', 'delete',
    '--subscription', config.subscriptionId,
    '--ids', resource.id,
  ]);
}
```

Rerun strict discovery. If anything remains, throw and preserve local state.
Only after an empty result remove:

- publication state;
- hardening state;
- generated infrastructure/runtime parameter files;
- generated schema directory.

Never delete `.azure/plan.md`, session target/publication files, the resource
group, or unrelated resources.

- [ ] **Step 6: Wire `demo-cleanup` into the CLI**

Review mode:

```text
DESTRUCTIVE: remove only resources owned by deployment <id>.
Preserved: resource group alpowers and all unrelated resources.
Resources:
- <type> <id>
Approval ID: <id>
After explicit approval: demo-cleanup <config> --approve <id>
```

Approved mode must recompute inventory and reject a stale ID before the first
delete.

- [ ] **Step 7: Document cleanup**

Add the review command and explicit approval command after validation. State
that cleanup never deletes a shared resource group and that Azure inventory is
reconciled again before and after deletion.

- [ ] **Step 8: Run focused tests**

Run:

```powershell
npx tsc
node --test dist\tests\demo-cleanup.test.js dist\tests\demo-publication.test.js dist\tests\demo-hardening.test.js
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add src\demo-cleanup.ts tests\demo-cleanup.test.ts src\cli.ts docs\reference\demo-deployment.md
git commit -m "feat: add deployment-owned demo cleanup" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Run Complete Static Validation

**Files:**
- Review all files changed in Tasks 1-10

- [ ] **Step 1: Run the focused cloud suite**

Run:

```powershell
npm run build
npx tsc
node --test dist\tests\azure-preflight.test.js dist\tests\demo-init.test.js dist\tests\demo-publication.test.js dist\tests\demo-hardening.test.js
npm run infra:build
npm run infra:test-demo
node --test tests\guide.test.mjs
```

Expected: every command exits 0.

- [ ] **Step 2: Run the complete repository suite**

Run:

```powershell
npm test
```

Expected: all core and selected-example tests PASS.

- [ ] **Step 3: Run formatting and generated-artifact checks**

Run:

```powershell
git --no-pager diff --check
git --no-pager status --short
```

Expected: `diff --check` exits 0; status contains only intended changes and
pre-existing unrelated work.

- [ ] **Step 4: Review secret boundaries**

Run:

```powershell
rg -n "listCredentials|registry-password|passwordSecretRef|adminUserEnabled" infra src tests
rg -n "passwords\\[|credential show|acr credential" src tests
```

Expected:

- `listCredentials()` appears only in Bicep Starter runtime configuration and
  static contract tests;
- no local code calls `az acr credential show`;
- no publication state/config field stores an ACR password;
- hardening disables admin access only after acceptance.

- [ ] **Step 5: Commit validation-driven fixes if needed**

If validation required code changes, add only those exact files and commit:

```powershell
git commit -m "fix: complete starter deployment validation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Do not create an empty commit.

---

### Task 12: Validate a Live Starter Deployment

**Files:**
- Update locally: `.azure/plan.md`
- Use session-only: cost, target, and publication JSON files

- [ ] **Step 1: Invoke required Azure validation workflow**

Invoke the `azure-validate` skill. Record every static command and result in
`.azure/plan.md`. Do not deploy if validation reports an error.

- [ ] **Step 2: Confirm exact Azure context**

Use `ask_user` to reconfirm:

- subscription `AzureSQLPMDemos_adbadram`
  (`fa58cf66-caaf-4ba9-875d-f310d3694845`);
- existing resource group `alpowers`;
- backend `eastus`;
- Static Web Apps `eastus2`;
- reviewed paid charges;
- cleanup limited to resources carrying the fresh deployment ID.

- [ ] **Step 3: Run Starter preflight**

Generate a fresh Starter publication with `demo-init`, then run:

```powershell
npm run azure -- demo-preflight <session-target.json>
```

Expected: exit 0 with `securityPosture: starter` and
`authorization.status: eligible-for-what-if`, despite no
`roleAssignments/write`.

- [ ] **Step 4: Review exact publication writes**

Run:

```powershell
npm run azure -- demo-publish <session-publication.json>
```

Expected: read-only review output with `Security posture: Starter`, exact
pending stages, known charges, cleanup boundary, and approval ID.

- [ ] **Step 5: Obtain explicit publication approval**

Use `ask_user` with the exact subscription, resource group, regions, deployment
ID, resource inventory, paid charge sources, synthetic writes, and cleanup
boundary. Do not infer approval from this implementation plan.

- [ ] **Step 6: Invoke Azure deployment workflow and publish**

Invoke the `azure-deploy` skill, then run the exact approved command:

```powershell
npm run azure -- demo-publish <session-publication.json> --approve <reviewed-id>
```

Expected: publication completes at the Static Web Apps URL.

- [ ] **Step 7: Verify live Starter acceptance**

Run:

```powershell
npm run azure -- demo-status <session-publication.json>
```

Expected:

- `deployment: ready`;
- `securityPosture: starter`;
- `registryAuthentication: credential`;
- `acrAdminEnabled: true`;
- linked backend and public site return 200;
- direct backend returns 401 or 403;
- full synthetic session and CRUD acceptance already passed.

- [ ] **Step 8: Record proof and decide on optional hardening**

Update `.azure/plan.md` validation proof with exact commands, timestamps, and
results. Lack of IAM permission must not invalidate successful Starter
validation.

If the user wants hardening and suitable IAM permission exists, review and
approve `demo-harden` separately. Otherwise record it as a deferred production
hardening item.

- [ ] **Step 9: Obtain destructive cleanup confirmation**

Before deleting anything, use `ask_user` and list exact deployment-owned
resource IDs. Preserve the `alpowers` resource group and every unrelated
resource.

- [ ] **Step 10: Clean up and verify**

Run:

```powershell
npm run azure -- demo-cleanup <session-publication.json>
```

Review the exact inventory, obtain approval through `ask_user`, then run:

```powershell
npm run azure -- demo-cleanup <session-publication.json> --approve <reviewed-id>
```

Verify no resources with the fresh deployment ID remain and compare unrelated
inventory to the pre-deployment snapshot.

- [ ] **Step 11: Commit final evidence updates if intended**

Do not commit session target/publication files, credentials, tokens, public IP
values, or live resource IDs. Commit only reviewed documentation evidence that
is intended for the repository.
