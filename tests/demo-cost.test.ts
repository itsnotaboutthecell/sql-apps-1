import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewDemoCost } from '../src/demo-cost.js';
import { run } from '../src/process.js';

const free = {
  version: 1, profile: 'public-demo', intent: 'zero-azure-spend',
  sql: { mode: 'free-paused' }, acknowledgeFixedCharges: false,
};

test('zero-spend review fails closed on registry/network charges despite SQL/compute grants', () => {
  const report = reviewDemoCost(free);
  assert.equal(report.hosting, 'container-apps');
  assert.equal(report.review.status, 'blocked-by-fixed-charges');
  assert.equal(report.review.canProceedToWhatIf, false);
  assert.equal(report.deployment.authorized, false);
  assert.equal(report.estimatedMonthlyCost, null);
  assert.equal(report.fixedCharges.length, 2);
  assert.equal(report.sql.parameters.sqlBillingMode, 'free-paused');
  assert.equal(report.sql.exhaustionBehavior, 'AutoPause');
  assert.equal(report.sql.parameters.sqlMaxSizeBytes, 32 * 1024 ** 3);
  assert.equal(report.sql.parameters.sqlBackupRedundancy, 'Local');
  assert.deepEqual(report.sql.parameters.sqlSku, { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 });
  assert.ok(report.sql.allowance);
  assert.equal(report.sql.allowance.computeVCoreSeconds, 100000);
  assert.equal(report.compute.allowance.vCpuSeconds, 180000);
  assert.equal(report.compute.allowance.memoryGiBSeconds, 360000);
  assert.equal(report.compute.allowance.requests, 2000000);
  assert.equal(report.compute.resources.vCpu, 0.75);
  assert.equal(report.compute.resources.memoryGiB, 1.5);
  assert.ok(Math.abs(report.compute.theoreticalActiveReplicaHours - 66.6666666667) < 0.000001);
  assert.equal(report.compute.actualUsage, 'not-queried');
  assert.equal(report.sql.actualUsage, 'not-queried');
  assert.match(report.monitoring.budgetWarning, /not.*cap/i);
  assert.match(report.sql.warning, /cannot revert/i);
  assert.match(report.references.note, /Free tier.*recurring monthly allowances.*not time-bound trial credits/);
});

test('Static Web Apps reports its Standard fixed charge without estimating a price', () => {
  const report = reviewDemoCost({ ...free, hosting: 'static-web-apps' });
  assert.equal(report.hosting, 'static-web-apps');
  assert.equal(report.estimatedMonthlyCost, null);
  assert.equal(report.fixedCharges.length, 3);
  assert.deepEqual(report.fixedCharges.at(-1), {
    resource: 'Azure Static Web Apps Standard',
    reason: 'A linked Container Apps backend requires Standard; the Container App, ACR, SQL, and networking remain.',
    pricing: 'https://azure.microsoft.com/pricing/details/app-service/static/',
  });
});

test('paid candidate cost guidance includes the Static Web Apps Standard charge', async () => {
  const reference = await readFile('docs/reference/demo-cost.md', 'utf8');
  assert.match(reference, /Separately reviewing paid supporting resources[\s\S]*"hosting": "static-web-apps"/);
});

test('paid cost review requires an explicit acknowledgement even when SQL stays free-paused', () => {
  assert.equal(reviewDemoCost({ ...free, intent: 'review-paid-costs' }).review.status, 'fixed-charge-acknowledgement-required');
  const report = reviewDemoCost({ ...free, intent: 'review-paid-costs', acknowledgeFixedCharges: true });
  assert.equal(report.review.status, 'ready-for-target-cost-review');
  assert.equal(report.review.canProceedToWhatIf, true);
  assert.equal(report.deployment.authorized, false);
  assert.equal(report.estimatedMonthlyCost, null);
  assert.equal(report.sql.exhaustionBehavior, 'AutoPause');
});

test('ordinary paid SQL is separate from irreversible free-tier paid continuation', () => {
  const report = reviewDemoCost({
    ...free, intent: 'review-paid-costs', acknowledgeFixedCharges: true,
    sql: {
      mode: 'paid-reviewed', sku: { name: 'S0', tier: 'Standard', capacity: 10 },
      maxSizeBytes: 250 * 1024 ** 3, backupRedundancy: 'Geo',
    },
  });
  assert.equal(report.sql.parameters.sqlBillingMode, 'paid-reviewed');
  assert.equal(report.sql.parameters.sqlSku.name, 'S0');
  assert.equal(report.sql.exhaustionBehavior, 'not-a-free-tier');
  assert.equal(report.sql.allowance, null);
  assert.match(report.sql.warning, /existing.*database/i);
});

test('invalid cost choices fail before approval or cloud access and never imply paid fallback', () => {
  for (const input of [
    { ...free, profile: 'authenticated-application' },
    { ...free, hosting: 'free' },
    { ...free, intent: 'free-trial' },
    { ...free, maxMonthlyCost: 0 },
    { ...free, acknowledgeFixedCharges: 'true' },
    { ...free, acknowledgeFixedCharges: true },
    { ...free, sql: { mode: 'BillOverUsage' } },
    { ...free, sql: { mode: 'free-paused', exhaustionBehavior: 'BillOverUsage' } },
    { ...free, sql: { mode: 'free-paused', maxSizeBytes: 64 * 1024 ** 3 } },
    { ...free, sql: { mode: 'paid-reviewed' } },
    { ...free, intent: 'review-paid-costs', sql: { mode: 'paid-reviewed',
      sku: { name: 'S0', tier: 'Standard', capacity: -1 }, maxSizeBytes: 1024, backupRedundancy: 'Local' } },
    { ...free, sql: { mode: 'paid-reviewed',
      sku: { name: 'S0', tier: 'Standard', capacity: 10 }, maxSizeBytes: 1024 ** 3, backupRedundancy: 'Local' } },
  ]) assert.throws(() => reviewDemoCost(input));
});

test('example and actual CLI show an honest offline blocked report with a nonzero exit', async () => {
  const example = JSON.parse(await readFile('azure-demo-cost.example.json', 'utf8'));
  assert.deepEqual(example, free);
  assert.equal(reviewDemoCost(example).review.status, 'blocked-by-fixed-charges');
  await assert.rejects(run(process.execPath, [resolve('dist', 'src', 'cli.js'), 'demo-cost',
    resolve('azure-demo-cost.example.json')]), error =>
    error instanceof Error && /failed \(2\)/.test(error.message) &&
    /blocked-by-fixed-charges/.test(error.message) && /"authorized": false/.test(error.message));
  await assert.rejects(run(process.execPath, [resolve('dist', 'src', 'cli.js'), 'demo-cost']),
    /explicit.*cost.*azure-demo-cost\.example\.json.*azure-role-based-cost\.example\.json/is);
});

test('actual CLI can review acknowledged costs but never reports deployment or a price quote', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-cost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cost review.json');
  await writeFile(path, JSON.stringify({ ...free, intent: 'review-paid-costs', acknowledgeFixedCharges: true }));
  const output = JSON.parse(await run(process.execPath, [resolve('dist', 'src', 'cli.js'), 'demo-cost', path]));
  assert.equal(output.review.status, 'ready-for-target-cost-review');
  assert.equal(output.deployment.authorized, false);
  assert.equal(output.deployment.ready, false);
  assert.equal(output.estimatedMonthlyCost, null);
  await writeFile(path, JSON.stringify({ ...free, sql: { mode: 'BillOverUsage' } }));
  await assert.rejects(run(process.execPath, [resolve('dist', 'src', 'cli.js'), 'demo-cost', path]), /failed \(1\)/);
});
