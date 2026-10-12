import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDemoPublicationFile, initDemoPublication } from '../src/demo-init.js';
import { demoPublicationSchema } from '../src/demo-publication.js';
import { createJsonFile } from '../src/deployment.js';
import { run, type Run, type RunOptions } from '../src/process.js';

const subscriptionId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const operatorId = '33333333-3333-4333-8333-333333333333';
const deploymentId = 'ABCDEF12-3456-4789-ABCD-EF1234567890';
const options = {
  subscriptionId,
  resourceGroup: 'rg-sqlapps-demo',
  location: 'eastus',
  staticWebAppLocation: 'eastus2',
  selectedApplication: 'todo',
  selectedArtifact: '.',
  owner: '  Demo Owner  ',
};

function jwt(claims: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

function harness(ipResponse: Response = Response.json({ ip: '203.0.113.10' })) {
  const calls: { command: string; args: readonly string[]; options: RunOptions | undefined }[] = [];
  const requests: { input: string; init: RequestInit | undefined }[] = [];
  const runner: Run = async (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions });
    if (args[0] === 'account' && args[1] === 'show') return JSON.stringify({ id: subscriptionId, tenantId });
    if (args[0] === 'account' && args[1] === 'get-access-token') {
      return JSON.stringify({ accessToken: jwt({ oid: operatorId, name: 'Ada Lovelace' }) });
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return ipResponse;
  };
  return { runner, fetcher, calls, requests };
}

test('initDemoPublication derives a complete deterministic Starter publication', async () => {
  const fake = harness();
  const publication = await initDemoPublication(options, fake.runner, fake.fetcher, () => deploymentId);

  assert.deepEqual(demoPublicationSchema.parse(publication), publication);
  assert.equal(publication.deploymentId, deploymentId.toLowerCase());
  assert.equal(publication.profile, 'public-demo');
  assert.equal(publication.securityPosture, 'starter');
  assert.equal(publication.hosting, 'static-web-apps');
  assert.equal(publication.name, 'sqlapps');
  assert.equal(publication.subscriptionId, subscriptionId);
  assert.equal(publication.tenantId, tenantId);
  assert.equal(publication.applicationName, 'sqlapps-abcdef12-web');
  assert.equal(publication.staticWebAppName, 'sqlapps-abcdef12-static');
  assert.equal(publication.registryServer, 'sqlappsdemoabcdef123456.azurecr.io');
  assert.equal(publication.gatewayImage, 'sqlappsdemoabcdef123456.azurecr.io/sqlapps-todo-api:abcdef12');
  assert.equal(publication.dabImage, 'sqlappsdemoabcdef123456.azurecr.io/sqlapps-todo-dab:abcdef12');
  assert.equal(publication.selectedArtifact, resolve('.'));
  assert.equal(publication.sqlAdminObjectId, operatorId);
  assert.equal(publication.sqlAdminName, 'Ada Lovelace');
  assert.equal(publication.schemaRunnerIp, '203.0.113.10');
  assert.deepEqual(publication.cost, { intent: 'review-paid-costs', acknowledgeFixedCharges: true });
  assert.deepEqual(publication.sqlSku, {
    name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2,
  });
  assert.equal(publication.sqlBillingMode, 'free-paused');
  assert.equal(publication.sqlMaxSizeBytes, 32 * 1024 ** 3);
  assert.equal(publication.sqlBackupRedundancy, 'Local');
  assert.deepEqual(publication.tags, { environment: 'synthetic-demo', owner: 'Demo Owner' });
});

test('initializer uses only account discovery and a sensitive ARM token call', async () => {
  const fake = harness();
  await initDemoPublication(options, fake.runner, fake.fetcher, () => deploymentId);

  assert.deepEqual(fake.calls.map(call => [call.command, ...call.args]), [
    ['az', 'account', 'show', '--subscription', subscriptionId, '--query', '{id:id,tenantId:tenantId}', '-o', 'json'],
    ['az', 'account', 'get-access-token', '--subscription', subscriptionId,
      '--resource', 'https://management.azure.com/', '-o', 'json'],
  ]);
  assert.equal(fake.calls[1]?.options?.sensitiveOutput, true);
  assert.ok(fake.calls.every(call => !call.args.includes('ad')));
  assert.ok(fake.calls.every(call => !call.args.some(arg => ['create', 'update', 'set', 'delete'].includes(arg))));
});

test('initializer requests public IPv4 without authorization and rejects bad responses explicitly', async () => {
  const fake = harness();
  await initDemoPublication(options, fake.runner, fake.fetcher, () => deploymentId);
  assert.equal(fake.requests[0]?.input, 'https://api.ipify.org?format=json');
  assert.equal(new Headers(fake.requests[0]?.init?.headers).has('authorization'), false);
  assert.equal(new Headers(fake.requests[0]?.init?.headers).get('accept'), 'application/json');
  assert.equal(fake.requests[0]?.init?.redirect, 'error');
  assert.ok(fake.requests[0]?.init?.signal);

  for (const [response, message] of [
    [Response.json({ ip: '2001:db8::1' }), /valid public IPv4/i],
    [Response.json({ ip: '10.0.0.8' }), /valid public IPv4/i],
    [Response.json({ address: '203.0.113.10' }), /malformed.*IPv4/i],
    [Response.json({ ip: '203.0.113.10' }, { status: 503 }), /failed.*503/i],
  ] as const) {
    const broken = harness(response);
    await assert.rejects(
      initDemoPublication(options, broken.runner, broken.fetcher, () => deploymentId),
      message,
    );
  }
});

test('initializer validates account and JWT identity evidence without Graph fallback', async () => {
  const base = harness();
  const wrongAccount: Run = async (_command, args, runOptions) => {
    if (args[1] === 'show') return JSON.stringify({ id: operatorId, tenantId });
    return base.runner('az', args, runOptions);
  };
  await assert.rejects(
    initDemoPublication(options, wrongAccount, base.fetcher, () => deploymentId),
    /requested subscription/i,
  );

  for (const token of ['two.parts', jwt({ oid: operatorId }), jwt({ oid: 'not-a-uuid', preferred_username: 'ada@contoso.com' })]) {
    const invalidToken: Run = async (_command, args) => args[1] === 'show'
      ? JSON.stringify({ id: subscriptionId, tenantId })
      : JSON.stringify({ accessToken: token });
    await assert.rejects(
      initDemoPublication(options, invalidToken, base.fetcher, () => deploymentId),
      /token|claim|identity/i,
    );
  }
});

test('demo-init CLI refuses to overwrite before Azure discovery', async t => {
  const directory = resolve('.task-demo-init-test');
  const path = resolve(directory, 'existing.json');
  await mkdir(directory, { recursive: true });
  await writeFile(path, '{"sentinel":true}');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    run(process.execPath, [resolve('dist/src/cli.js'), 'demo-init', path,
      '--subscription', subscriptionId, '--resource-group', options.resourceGroup,
      '--location', options.location, '--static-web-app-location', options.staticWebAppLocation,
      '--application', options.selectedApplication, '--artifact', '.', '--owner', 'Demo Owner']),
    /already exists.*never overwrites/i,
  );
});

test('demo-init does not overwrite a configuration created during discovery', async t => {
  const directory = resolve('.task-demo-init-race-test');
  const path = resolve(directory, 'publication.json');
  const concurrent = '{"concurrent":true}';
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fake = harness();
  let discoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
  let finishDiscovery!: () => void;
  const blocked = new Promise<void>(resolve => { finishDiscovery = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    discoveryStarted();
    await blocked;
    return fake.fetcher(input, init);
  };

  const initializing = createDemoPublicationFile(path, options, fake.runner, fetcher, () => deploymentId);
  const rejected = assert.rejects(
    initializing,
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );
  await started;
  await writeFile(path, concurrent);
  finishDiscovery();
  await rejected;
  assert.equal(await readFile(path, 'utf8'), concurrent);
});

test('atomic publication collision preserves the destination and removes its temporary file', async t => {
  const directory = resolve('.task-demo-publication-collision-test');
  const path = join(directory, 'publication.json');
  const existing = '{"existing":true}';
  await mkdir(directory, { recursive: true });
  await writeFile(path, existing);
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    createJsonFile(path, { replacement: true }),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );

  assert.equal(await readFile(path, 'utf8'), existing);
  assert.deepEqual(await readdir(directory), ['publication.json']);
});

test('temporary name collision preserves the unowned file and does not publish', async t => {
  const directory = resolve('.task-demo-temporary-collision-test');
  const path = join(directory, 'publication.json');
  const temporary = join(directory, 'existing.tmp');
  const existing = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, existing);
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    createJsonFile(path, { replacement: true }, () => temporary),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );

  assert.deepEqual(await readFile(temporary), existing);
  await assert.rejects(
    readFile(path),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

test('pre-publication write failure leaves no final file or temporary artifact', async t => {
  const directory = resolve('.task-demo-publication-write-failure-test');
  const path = join(directory, `${'x'.repeat(240)}.json`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(createJsonFile(path, { publication: true }));

  assert.deepEqual(await readdir(directory), []);
});
