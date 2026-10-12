import { z } from 'zod';

const sku = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  tier: z.string().regex(/^[A-Za-z]{1,32}$/),
  capacity: z.number().finite().positive(),
  family: z.string().regex(/^[A-Za-z0-9]{1,32}$/).optional(),
});
const costSchema = z.strictObject({
  version: z.literal(1), profile: z.literal('public-demo'),
  hosting: z.enum(['container-apps', 'static-web-apps']).default('container-apps'),
  intent: z.enum(['zero-azure-spend', 'review-paid-costs']),
  acknowledgeFixedCharges: z.boolean(),
  sql: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('free-paused') }),
    z.strictObject({
      mode: z.literal('paid-reviewed'), sku,
      maxSizeBytes: z.number().int().min(104857600).max(Number.MAX_SAFE_INTEGER),
      backupRedundancy: z.enum(['Local', 'Zone', 'Geo', 'GeoZone']),
    }),
  ]),
}).superRefine((value, context) => {
  if (value.intent === 'zero-azure-spend' && (value.sql.mode !== 'free-paused' || value.acknowledgeFixedCharges)) {
    context.addIssue({ code: 'custom', message: 'A zero-spend intent requires free-paused SQL and cannot acknowledge paid fixed charges.' });
  }
});

export function reviewDemoCost(input: unknown) {
  const config = costSchema.parse(input);
  const free = config.sql.mode === 'free-paused';
  const status = config.intent === 'zero-azure-spend' ? 'blocked-by-fixed-charges' :
    !config.acknowledgeFixedCharges ? 'fixed-charge-acknowledgement-required' : 'ready-for-target-cost-review';
  const containers = [
    { name: 'gateway', vCpu: 0.25, memoryGiB: 0.5 },
    { name: 'data', vCpu: 0.5, memoryGiB: 1 },
  ];
  const vCpu = containers.reduce((total, container) => total + container.vCpu, 0);
  const memoryGiB = containers.reduce((total, container) => total + container.memoryGiB, 0);
  const sqlParameters = config.sql.mode === 'free-paused' ? {
    sqlBillingMode: config.sql.mode,
    sqlSku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 },
    sqlMaxSizeBytes: 32 * 1024 ** 3, sqlBackupRedundancy: 'Local',
  } : {
    sqlBillingMode: config.sql.mode, sqlSku: config.sql.sku,
    sqlMaxSizeBytes: config.sql.maxSizeBytes, sqlBackupRedundancy: config.sql.backupRedundancy,
  };
  return {
    version: 1, profile: config.profile, hosting: config.hosting, intent: config.intent,
    review: {
      status, canProceedToWhatIf: status === 'ready-for-target-cost-review',
      nextAction: config.intent === 'zero-azure-spend' ?
        'Stay local or separately review an alternative secure hosting/image distribution design. The current template has fixed charges; do not provision it as free or weaken SQL access.' :
        !config.acknowledgeFixedCharges ?
          'Review registry and managed-network pricing before explicitly acknowledging their fixed charges. No deployment approval is inferred.' :
          'Review region/currency/account pricing, existing grant consumption and target eligibility before separately approved what-if. Pricing and deployment readiness are not verified.',
    },
    deployment: { authorized: false, ready: false, scope: 'Offline review for new minimal demo databases only; not a deployment command or existing-database conversion.' },
    estimatedMonthlyCost: null,
    pricingStatus: 'not-quoted-region-currency-and-account-review-required',
    fixedCharges: [
      { resource: 'ACR Basic', reason: 'Private registry has a recurring tier charge, independent of app traffic.',
        pricing: 'https://azure.microsoft.com/pricing/details/container-registry/' },
      { resource: 'Custom-network Container Apps managed infrastructure',
        reason: 'Managed public IP/load-balancer infrastructure can incur charges even when app replicas scale to zero.',
        pricing: 'https://learn.microsoft.com/azure/container-apps/custom-virtual-networks#managed-resources' },
      ...(config.hosting === 'static-web-apps' ? [{
        resource: 'Azure Static Web Apps Standard',
        reason: 'A linked Container Apps backend requires Standard; the Container App, ACR, SQL, and networking remain.',
        pricing: 'https://azure.microsoft.com/pricing/details/app-service/static/',
      }] : []),
    ],
    sql: {
      parameters: sqlParameters,
      exhaustionBehavior: free ? 'AutoPause' : 'not-a-free-tier',
      allowance: free ? { computeVCoreSeconds: 100000, dataGiB: 32, backupGiB: 32, databasesPerSubscription: 10 } : null,
      actualUsage: 'not-queried',
      eligibility: 'not-verified-region-subscription-and-free-slot-check-required',
      warning: free ?
        'AutoPause makes SQL unavailable until next calendar month when the free limit is reached. Idle auto-pause/cold resume can affect responsiveness. Open connections can prevent idle auto-pause. Paid continuation cannot revert to monthly-limit AutoPause; never enable it automatically or fall back to paid SQL.' :
        'Ordinary SQL billing requires reviewed sizing. This is not free-tier paid continuation or permission to convert an existing database; review existing state and irreversible changes separately.',
    },
    compute: {
      plan: 'Consumption', minReplicas: 0, maxReplicas: 1,
      containers, resources: { vCpu, memoryGiB },
      allowance: { vCpuSeconds: 180000, memoryGiBSeconds: 360000, requests: 2000000, scope: 'subscription-per-calendar-month' },
      theoreticalActiveReplicaHours: Math.min(180000 / vCpu, 360000 / memoryGiB) / 3600,
      actualUsage: 'not-queried',
      warning: 'Illustrative active allocation time with all grants unused, not visitor-hours or a spending cap. Both gateway and DAB count. Startup, idle gaps, bots and other subscription apps affect consumption; overages are billable.',
    },
    monitoring: {
      status: 'workspace-provisioned-alerts-not-configured',
      logs: 'The demo environment sends Container Apps console logs to its own Log Analytics workspace, capped at 0.1 GB per day and 30 day retention so it stays inside the included free allowance. Ingestion above the cap is dropped, not billed; raising the cap or retention is billable.',
      sql: 'Check Free monthly vCore amount / Free amount remaining in the SQL portal; create a reviewed alert before exhaustion.',
      compute: 'Review subscription-wide Container Apps usage and remaining grants, not just this app or request count.',
      costs: 'Review actual and forecast costs across the app resource group and its managed infrastructure resource group. Keep cleanup ownership explicit.',
      budgetWarning: 'Budgets are delayed alerts, not a hard spending cap; they do not stop resources or consumption.',
      scaleTriggers: ['Allowance exhaustion', 'Cold starts are unacceptable', 'People rely on continuous availability',
        'Measured capacity/latency pressure', 'Real-data access, retention or recovery requirements'],
    },
    references: {
      checkedOn: '2026-10-09',
      sql: 'https://learn.microsoft.com/azure/azure-sql/database/free-offer',
      compute: 'https://learn.microsoft.com/azure/container-apps/billing',
      logs: 'https://azure.microsoft.com/pricing/details/monitor/',
      budgets: 'https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets',
      note: 'Free tier means recurring monthly allowances, not time-bound trial credits or unlimited usage. Documented allowances are not subscription eligibility, live usage or a price quote. Recheck before deployment.',
    },
  };
}
