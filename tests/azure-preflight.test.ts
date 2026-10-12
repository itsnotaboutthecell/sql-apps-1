import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightDemo, DemoPreflightError, demoTargetSchema } from '../src/azure-preflight.js';
import type { Run } from '../src/process.js';
import { run } from '../src/process.js';

const target = {
  profile: 'public-demo' as const,
  securityPosture: 'starter' as const,
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceGroup: 'sql-apps-demo', location: 'eastus',
};
const otherTenant = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secret = 'synthetic-sensitive-token';
function harness(options: {
  cacheFailure?: boolean; tokenFailure?: string; tenant?: string; expired?: boolean;
  armTenant?: string; forbidden?: string; missingGroup?: boolean; provider?: string; wrongRegion?: boolean;
  permissions?: readonly { actions: readonly string[]; notActions: readonly string[] }[];
} = {}) {
  const calls: string[][] = [];
  const requests: string[] = [];
  const runner: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'account' && args[1] === 'list') {
      if (options.cacheFailure) throw new Error(`Default-tenant Graph denied; ${secret}`);
      return '[]';
    }
    if (args[0] === 'account' && args[1] === 'get-access-token') {
      assert.ok(args.includes('--tenant'));
      assert.equal(args[args.indexOf('--tenant') + 1], target.tenantId);
      assert.ok(args.includes('https://management.azure.com/'));
      if (options.tokenFailure) throw new Error(`${options.tokenFailure}; ${secret}`);
      return JSON.stringify({ accessToken: secret, tenant: options.tenant ?? target.tenantId,
        expires_on: String(Math.floor(Date.now() / 1000) + (options.expired ? -30 : 3600)) });
    }
    throw new Error(`Unexpected CLI operation: ${args.join(' ')}`);
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.href);
    assert.equal(url.origin, 'https://management.azure.com');
    assert.ok(url.pathname.startsWith(`/subscriptions/${target.subscriptionId}`));
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (options.forbidden) return Response.json({ error: { code: options.forbidden, message: secret } }, { status: 403 });
    if (url.pathname.endsWith('/permissions')) return Response.json({ value: options.permissions ?? [{ actions: ['*'], notActions: [] }] });
    if (url.pathname.endsWith(`/resourcegroups/${target.resourceGroup}`)) {
      return options.missingGroup ? Response.json({}, { status: 404 }) :
        Response.json({ id: `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`, location: target.location });
    }
    const provider = /\/providers\/(Microsoft\.[^/]+)$/.exec(url.pathname)?.[1];
    if (provider) {
      const types: Record<string, string[]> = {
        'Microsoft.App': ['managedEnvironments', 'containerApps'],
        'Microsoft.Sql': ['servers'],
        'Microsoft.Network': ['virtualNetworks'],
        'Microsoft.ContainerRegistry': ['registries'],
        'Microsoft.ManagedIdentity': ['userAssignedIdentities'],
        'Microsoft.Authorization': ['roleAssignments'],
        'Microsoft.Web': ['staticSites', 'staticSites/linkedBackends'],
      };
      return Response.json({ namespace: provider, registrationState: options.provider === provider ? 'NotRegistered' : 'Registered',
        resourceTypes: types[provider]!.map(resourceType => ({ resourceType, locations: [options.wrongRegion ? 'West Europe' : 'East US'] })) });
    }
    if (url.pathname.endsWith('/locations')) return Response.json({ value: [{ name: target.location, displayName: 'East US' }] });
    return Response.json({ subscriptionId: target.subscriptionId, tenantId: options.armTenant ?? target.tenantId, state: 'Enabled' });
  };
  return { runner, fetcher, calls, requests };
}

test('public demo preflight accepts actual tenant-scoped ARM access despite an empty subscription cache', async () => {
  const fake = harness();
  const result = await preflightDemo(target, fake.runner, fake.fetcher);
  assert.equal(result.cache.status, 'not-found');
  assert.equal(result.arm.status, 'verified');
  assert.equal(result.authorization.status, 'eligible-for-what-if');
  assert.equal(result.policy.status, 'not-yet-evaluated');
  assert.equal(result.costs.status, 'not-evaluated');
  assert.match(result.costs.action, /demo-cost.*before what-if/);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(fake.calls.every(call => !call.includes('ad') && !call.includes('set') && !call.includes('login')));
});

test('starter preflight does not require role-assignment writes', async () => {
  const fake = harness({ permissions: [{ actions: ['*'], notActions: ['Microsoft.Authorization/roleAssignments/write'] }] });
  const result = await preflightDemo(target, fake.runner, fake.fetcher);
  assert.equal(result.securityPosture, 'starter');
  assert.equal(result.authorization.status, 'eligible-for-what-if');
  assert.ok(!fake.requests.some(request => request.includes('/providers/Microsoft.Authorization?')));
});

test('starter preflight requires ACR credential listing', async () => {
  const fake = harness({
    permissions: [{ actions: ['*'], notActions: ['Microsoft.ContainerRegistry/registries/listCredentials/action'] }],
  });
  await assert.rejects(preflightDemo(target, fake.runner, fake.fetcher), error =>
    error instanceof DemoPreflightError && error.code === 'WRITE_AUTHORIZATION_MISSING' &&
    /listCredentials/.test(error.message));
});

test('hardened preflight requires role-assignment writes', async () => {
  const fake = harness({ permissions: [{ actions: ['*'], notActions: ['Microsoft.Authorization/roleAssignments/write'] }] });
  await assert.rejects(preflightDemo(
    { ...target, securityPosture: 'hardened' },
    fake.runner,
    fake.fetcher,
  ), error => error instanceof DemoPreflightError && error.code === 'WRITE_AUTHORIZATION_MISSING' &&
    /roleAssignments/.test(error.message));
});

test('default-tenant discovery/Graph errors are separate evidence, not a revoked-login conclusion', async () => {
  const fake = harness({ cacheFailure: true, missingGroup: true });
  const result = await preflightDemo(target, fake.runner, fake.fetcher);
  assert.equal(result.cache.status, 'unavailable');
  assert.equal(result.resourceGroup.status, 'requires-approved-creation');
  assert.equal(result.arm.status, 'verified');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('tenant mismatch and expired tokens stop before confusing cache evidence with authoritative access', async () => {
  for (const [options, code] of [
    [{ tenant: otherTenant }, 'TOKEN_TENANT_MISMATCH'],
    [{ armTenant: otherTenant }, 'SUBSCRIPTION_TENANT_MISMATCH'],
    [{ expired: true }, 'TOKEN_EXPIRED'],
    [{ tokenFailure: 'AADSTS700082 expired refresh token' }, 'TENANT_TOKEN_REQUIRED'],
  ] as const) {
    const fake = harness(options);
    await assert.rejects(preflightDemo(target, fake.runner, fake.fetcher), error =>
      error instanceof DemoPreflightError && error.code === code && !JSON.stringify(error).includes(secret) &&
      !error.message.includes(secret));
    if ('expired' in options || 'tenant' in options || 'tokenFailure' in options) assert.equal(fake.requests.length, 0);
  }
});

test('policy, ARM denial, provider availability, region and write authorization have distinct safe failures', async () => {
  for (const [options, code] of [
    [{ forbidden: 'RequestDisallowedByPolicy' }, 'AZURE_POLICY_DENIED'],
    [{ forbidden: 'AuthorizationFailed' }, 'ARM_FORBIDDEN'],
    [{ provider: 'Microsoft.Sql' }, 'PROVIDER_REGISTRATION_REQUIRED'],
    [{ wrongRegion: true }, 'REGION_UNSUPPORTED'],
    [{ permissions: [{ actions: ['*/read'], notActions: [] }] }, 'WRITE_AUTHORIZATION_MISSING'],
    [{ permissions: [{ actions: ['*'], notActions: ['Microsoft.Sql/servers/firewallRules/delete'] }] }, 'WRITE_AUTHORIZATION_MISSING'],
    [{ permissions: [{ actions: ['*'], notActions: ['Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'] }] }, 'WRITE_AUTHORIZATION_MISSING'],
    [{ permissions: [{ actions: ['*'], notActions: ['Microsoft.Network/virtualNetworks/subnets/joinViaServiceEndpoint/action'] }] }, 'WRITE_AUTHORIZATION_MISSING'],
  ] as const) {
    const fake = harness(options);
    await assert.rejects(preflightDemo(target, fake.runner, fake.fetcher), error =>
      error instanceof DemoPreflightError && error.code === code && !error.message.includes(secret));
    assert.ok(fake.calls.every(call => call[1] === 'account'));
  }
});

test('profile and unknown target settings are rejected before Azure operations', async () => {
  const fake = harness();
  for (const value of [
    { ...target, profile: 'authenticated-application' }, { ...target, location: 'eastus;injected' },
    { ...target, graph: true }, { ...target, subscriptionId: 'not-a-subscription' },
    { ...target, securityPosture: 'automatic' },
  ]) {
    assert.equal(demoTargetSchema.safeParse(value).success, false);
    await assert.rejects(preflightDemo(value, fake.runner, fake.fetcher));
  }
  assert.equal(fake.calls.length, 0);
});

test('ARM transient failures retry narrowly and stop at a bounded count', async () => {
  const fake = harness();
  let attempts = 0;
  const unstable: typeof fetch = async (input, init) => {
    if (String(input).endsWith('api-version=2022-12-01')) {
      attempts++;
      return Response.json({ error: { code: 'ServiceUnavailable' } }, { status: 503 });
    }
    return fake.fetcher(input, init);
  };
  await assert.rejects(preflightDemo(target, fake.runner, unstable), error =>
    error instanceof DemoPreflightError && error.code === 'ARM_TRANSIENT_FAILURE');
  assert.equal(attempts, 3);
});

test('CLI exposes separate read-only demo diagnostics without requiring full-foundation configuration', async () => {
  const output = await run(process.execPath, ['dist/src/cli.js', 'help']);
  assert.match(output, /demo-preflight/);
  assert.doesNotMatch(output, /Run npm run build/, 'help must not bypass the guarded consent-run build path');
  await assert.rejects(run(process.execPath, ['dist/src/cli.js', 'demo-preflight']), /explicit.*target configuration/i);
});

test('CLI reports configuration schema problems as readable paths, not raw JSON issue dumps', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-zod-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'bad.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile('azure-role-based.example.json', 'utf8')), bogusKey: 1 }));
  await assert.rejects(run(process.execPath, ['dist/src/cli.js', 'validate', path]), (error: Error) =>
    /bogusKey/.test(error.message) && !error.message.includes('"code"'));
});

test('offline validate compares the Azure role-based config with role-based-data.json and requires declared procedures', async t => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFile } = await import('node:child_process');
  const cli = resolve('dist/src/cli.js');
  const example = JSON.parse(await readFile('azure-role-based.example.json', 'utf8'));
  const dab = JSON.parse(await readFile('dab/dab-config.json', 'utf8'));
  dab.entities = { ShiftsReady: { source: { object: 'dbo.ShiftsReady', type: 'stored-procedure' },
    rest: { enabled: true, methods: ['get'] }, graphql: false, permissions: [{ role: 'Volunteer', actions: ['execute'] }] } };
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-rb-validate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dab'));
  await mkdir(join(directory, 'sql'));
  await writeFile(join(directory, 'dab', 'dab-config.json'), JSON.stringify(dab));
  await writeFile(join(directory, 'role-based-data.json'),
    JSON.stringify({ profile: 'role-based-data', requiredRole: 'Volunteer', readinessPath: '/api/ShiftsReady' }));
  const validate = (config: unknown) => writeFile(join(directory, 'azure.json'), JSON.stringify(config)).then(() =>
    new Promise<{ code: number; output: string }>(done => execFile(process.execPath, [cli, 'validate', 'azure.json'], { cwd: directory },
      (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, output: stdout + stderr }))));

  const stale = await validate(example);
  assert.notEqual(stale.code, 0);
  assert.match(stale.output, /requiredRole.*AppUser.*Volunteer.*role-based-data\.json/s);

  const aligned = { ...example, requiredRole: 'Volunteer', readinessPath: '/api/ShiftsReady' };
  const missing = await validate(aligned);
  assert.notEqual(missing.code, 0, 'validate must not pass before artifacts/provision when a DAB procedure is absent from sql/');
  assert.match(missing.output, /dbo\.ShiftsReady/);
  assert.match(missing.output, /sql\//);

  await writeFile(join(directory, 'sql', 'ShiftsReady.sql'), 'CREATE PROCEDURE dbo.ShiftsReady AS SELECT 1;');
  const valid = await validate(aligned);
  assert.equal(valid.code, 0, valid.output);
  assert.match(valid.output, /Configuration valid/);
});

test('permission pagination follows same-scope pages before deciding that write access is missing', async () => {
  const fake = harness();
  let pages = 0;
  const paged: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/permissions')) {
      pages++;
      if (!url.searchParams.has('$skiptoken')) return Response.json({
        value: [{ actions: ['*/read'], notActions: [] }], nextLink: `${url.href}&$skiptoken=next`,
      });
    }
    return fake.fetcher(input, init);
  };
  assert.equal((await preflightDemo(target, fake.runner, paged)).authorization.status, 'eligible-for-what-if');
  assert.equal(pages, 2);
});

test('ARM pagination rejects foreign endpoints and cycles without forwarding the token', async () => {
  for (const kind of ['foreign-host', 'foreign-subscription', 'foreign-version', 'userinfo', 'fragment', 'http', 'cycle']) {
    const fake = harness();
    const paged: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://management.azure.com');
      assert.ok(url.pathname.startsWith(`/subscriptions/${target.subscriptionId}`));
      if (url.pathname.endsWith('/permissions')) {
        const next = new URL(url);
        if (kind === 'foreign-host') next.hostname = 'unrelated.invalid';
        if (kind === 'foreign-subscription') next.pathname = next.pathname.replace(target.subscriptionId, otherTenant);
        if (kind === 'foreign-version') next.searchParams.set('api-version', '2020-01-01');
        if (kind === 'userinfo') next.username = 'untrusted';
        if (kind === 'fragment') next.hash = 'untrusted';
        if (kind === 'http') next.protocol = 'http:';
        return Response.json({ value: [{ actions: ['*'], notActions: [] }], nextLink: next.href });
      }
      return fake.fetcher(input, init);
    };
    await assert.rejects(preflightDemo(target, fake.runner, paged), error =>
      error instanceof DemoPreflightError && error.code === 'ARM_INVALID_RESPONSE');
  }
});

test('ARM pagination stops at ten pages even when every next link is unique', async () => {
  const fake = harness();
  let pages = 0;
  const paged: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/permissions')) {
      pages++;
      url.searchParams.set('$skiptoken', String(pages));
      return Response.json({ value: [{ actions: ['*'], notActions: [] }], nextLink: url.href });
    }
    return fake.fetcher(input, init);
  };
  await assert.rejects(preflightDemo(target, fake.runner, paged), error =>
    error instanceof DemoPreflightError && error.code === 'ARM_INVALID_RESPONSE');
  assert.equal(pages, 10);
});

test('transport retries recover transient failures but do not retry TLS failures', async () => {
  for (const transient of [true, false]) {
    const fake = harness();
    let attempts = 0;
    const unstable: typeof fetch = async (input, init) => {
      attempts++;
      if (attempts === 1) throw new TypeError(secret, {
        cause: Object.assign(new Error(secret), { code: transient ? 'ECONNRESET' : 'CERT_HAS_EXPIRED' }),
      });
      return fake.fetcher(input, init);
    };
    if (transient) assert.equal((await preflightDemo(target, fake.runner, unstable)).arm.status, 'verified');
    else {
      await assert.rejects(preflightDemo(target, fake.runner, unstable), error =>
        error instanceof DemoPreflightError && error.code === 'ARM_TRANSPORT_FAILED' && !error.message.includes(secret));
      assert.equal(attempts, 1);
    }
  }
});

test('malformed ARM data and legacy local-time token expiration fail without exposing response contents', async () => {
  const fake = harness();
  const malformed: typeof fetch = async () => Response.json({ secret });
  await assert.rejects(preflightDemo(target, fake.runner, malformed), error =>
    error instanceof DemoPreflightError && error.code === 'ARM_INVALID_RESPONSE' && !error.message.includes(secret));
  const legacy: Run = async (command, args) => args[1] === 'get-access-token' ?
    JSON.stringify({ accessToken: secret, tenant: target.tenantId, expiresOn: '2099-01-01 00:00:00' }) :
    fake.runner(command, args);
  await assert.rejects(preflightDemo(target, legacy, fake.fetcher), error =>
    error instanceof DemoPreflightError && error.code === 'TOKEN_FORMAT_INVALID' && !error.message.includes(secret));
  assert.equal(fake.requests.length, 0);
});
