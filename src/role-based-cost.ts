import { z } from 'zod';

const schema = z.strictObject({
  version: z.literal(1), profile: z.literal('role-based-data'),
  intent: z.enum(['zero-azure-spend', 'review-paid-costs']),
  acknowledgeFixedCharges: z.boolean(),
}).refine(value => value.intent !== 'zero-azure-spend' || !value.acknowledgeFixedCharges,
  'Zero-spend intent cannot acknowledge paid charges');

export function reviewRoleBasedCost(input: unknown) {
  const config = schema.parse(input);
  const permitted = config.intent === 'review-paid-costs' && config.acknowledgeFixedCharges;
  return {
    version: 1, profile: config.profile, intent: config.intent,
    review: { canProceedToWhatIf: permitted,
      status: permitted ? 'ready-for-target-cost-review' : 'blocked-by-paid-infrastructure',
      nextAction: permitted ? 'Review current regional/account prices and obtain separate target/what-if approval.' :
        'Stay local or separately review paid SQL, registry and private-network charges; no paid fallback is authorized.' },
    estimatedMonthlyCost: null, pricingStatus: 'not-quoted-region-currency-and-account-review-required',
    deployment: { authorized: false, ready: false },
    resources: [
      { name: 'Azure SQL', sku: 'GP_S_Gen5_2 free limit', minCapacity: 0.5,
        billing: 'free-limit serverless database; auto-pauses at monthly exhaustion instead of continuing into paid usage' },
      { name: 'ACR', sku: 'not-verified', billing: 'configured dedicated registry; review its actual tier, storage and build charges' },
      { name: 'Gateway and DAB', sku: 'Container Apps Consumption', minReplicas: 0, maxReplicas: 2,
        each: { vCpu: 0.5, memoryGiB: 1 }, billing: 'both services scale to zero; cold starts and shared grant exhaustion remain explicit limits' },
      { name: 'Private networking', billing: 'SQL private endpoint, DNS and managed VNet infrastructure charges' },
      { name: 'Log Analytics', billing: 'ingestion and retention charges' },
    ],
    excluded: ['Functions', 'Blob/Queue/Table storage', 'Key Vault', 'Functions/storage/vault private endpoints'],
    cleanup: 'Review/export application data and remove only explicitly owned resources with separate approval; discovery is not reuse consent.',
    monitoring: 'Review actual/forecast costs in app and managed infrastructure groups. Budgets are delayed alerts, not hard caps.',
    references: {
      sql: 'https://azure.microsoft.com/pricing/details/azure-sql-database/single/',
      containers: 'https://azure.microsoft.com/pricing/details/container-apps/',
      registry: 'https://azure.microsoft.com/pricing/details/container-registry/',
      network: 'https://azure.microsoft.com/pricing/details/private-link/',
      logs: 'https://azure.microsoft.com/pricing/details/monitor/',
    },
  };
}
