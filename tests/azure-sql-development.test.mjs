import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cloud;
try { cloud = await import('../dist/src/azure-sql-development.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const request = { version: 1, target: { version: 1, provider: 'azure', server: 'example.database.windows.net', database: 'development',
  subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'development' },
location: 'eastus2', administratorObjectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', administratorName: 'Development administrator',
clientIp: '203.0.113.10', createResourceGroup: false, cost: 'free-only' };

test('database-only provisioning plans require exact target, IP, free-only cost and explicit resource-group effects', async () => {
  assert.equal(typeof cloud?.planDevelopmentSql, 'function');
  const plan = await cloud.planDevelopmentSql(process.cwd(), request);
  assert.match(plan.approval, /^[a-f0-9]{12}$/);
  assert.equal(plan.request.cost, 'free-only');
  assert.equal(plan.request.createResourceGroup, false);
  for (const invalid of [{ ...request, clientIp: '0.0.0.0' }, { ...request, cost: 'paid' },
    { ...request, password: 'secret' }, { ...request, target: { ...request.target, server: 'other.example' } }]) {
    await assert.rejects(cloud.planDevelopmentSql(process.cwd(), invalid));
  }
});

test('development infrastructure provisions SQL only and never opens broad Azure or internet firewall rules', async () => {
  const source = await readFile(new URL('../infra/development-sql.bicep', import.meta.url), 'utf8');
  assert.match(source, /Microsoft\.Sql\/servers/);
  assert.match(source, /freeLimitExhaustionBehavior: 'AutoPause'/);
  assert.match(source, /startIpAddress: clientIp/);
  assert.match(source, /endIpAddress: clientIp/);
  assert.doesNotMatch(source, /Microsoft\.Web|Microsoft\.App|0\.0\.0\.0|255\.255\.255\.255|BillOverUsage/);
});

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sql-apps-development-sql-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const plan = await cloud.planDevelopmentSql(home, request), calls = [];
  const runner = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === 'powershell.exe') return options.input;
    if (args.includes('show')) return JSON.stringify({ id: request.target.subscriptionId, tenantId: request.target.tenantId });
    if (args.includes('get-access-token')) return JSON.stringify({ accessToken: 'synthetic-management-token' });
    if (args.includes('build')) return '{"resources":[]}';
    throw new Error('Unexpected command');
  };
  let submitted = false;
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.includes('/deployments/')) {
      if (options.method === 'PUT') { submitted = true; return Response.json({}); }
      return submitted ? Response.json({ properties: { provisioningState: 'Succeeded' } }) : Response.json({}, { status: 404 });
    }
    if (url.includes('/databases/')) return Response.json({ properties: { useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' } });
    if (url.includes('/servers/')) return Response.json({}, { status: 404 });
    return Response.json({});
  };
  return { home, plan, calls, runner, fetcher };
}

test('database provisioning refuses stale approvals and wrong accounts before resource changes', async t => {
  const f = await fixture(t);
  await assert.rejects(cloud.provisionDevelopmentSql(f.home, { ...f.plan, effects: [] }, f.runner, f.fetcher), /stale/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(cloud.provisionDevelopmentSql(f.home, f.plan, async () => JSON.stringify({ id: 'other', tenantId: request.target.tenantId }), f.fetcher), /account/);
  assert.equal(f.calls.length, 0);
});

test('database provisioning never adopts an existing server without a matching receipt', async t => {
  const f = await fixture(t);
  await assert.rejects(cloud.provisionDevelopmentSql(f.home, f.plan, f.runner, async () => Response.json({})), /already exists/);
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('database provisioning resumes its exact deployment without duplicate resources or secret arguments', async t => {
  const f = await fixture(t);
  const first = await cloud.provisionDevelopmentSql(f.home, f.plan, f.runner, f.fetcher);
  assert.deepEqual(await cloud.provisionDevelopmentSql(f.home, f.plan, f.runner, f.fetcher), first);
  const puts = f.calls.filter(call => call.method === 'PUT');
  assert.equal(puts.length, 1);
  const body = JSON.parse(puts[0].body);
  assert.equal(body.properties.mode, 'Incremental');
  assert.equal(body.properties.parameters.clientIp.value, request.clientIp);
  const password = body.properties.parameters.administratorPassword.value;
  assert.match(password, /^SqlApps1!/);
  assert.equal(f.calls.filter(Array.isArray).flat().some(value => value.includes(password) || value.includes('synthetic-management-token')), false);
});

test('free-offer refusal is surfaced without paid fallback or automatic resource deletion', async t => {
  const f = await fixture(t);
  const fetcher = (url, options) => options.method === 'PUT'
    ? Response.json({ error: { code: 'FreeOfferNotAvailable' } }, { status: 400 }) : f.fetcher(url, options);
  await assert.rejects(cloud.provisionDevelopmentSql(f.home, f.plan, f.runner, fetcher), /FreeOfferNotAvailable/);
  assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
});

test('provisioning verifies AutoPause rather than treating ARM deployment success as free-only readiness', async t => {
  const f = await fixture(t);
  await assert.rejects(cloud.provisionDevelopmentSql(f.home, f.plan, f.runner, (url, options) =>
    url.includes('/databases/') ? Response.json({ properties: { useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' } }) : f.fetcher(url, options)));
});
