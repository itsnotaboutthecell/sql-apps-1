# Demo cost review and SQL billing reference

For an overview before deciding whether to share your app, read [Costs and growth](../guides/costs.md). This reference documents the offline command, configuration and template settings.

**Free tier** means recurring monthly allowances, not trial credits or a guaranteed free deployment. The Azure SQL documentation uses "free offer" for its enrollment mechanism. Eligibility, usage limits and separate paid resources still apply.

## Offline demo cost review

After building, run:

```powershell
npm run azure -- demo-cost azure-demo-cost.example.json
```

This reads the [example contract](../../azure-demo-cost.example.json) and produces JSON without login, Azure requests, resource writes or changing subscription defaults. The example deliberately requests zero Azure spending.

**The current template cannot satisfy that request:** it creates ACR Basic and custom-network Container Apps managed infrastructure. Their charges do not disappear at zero app replicas. The report says `blocked-by-fixed-charges` and exits **2**, rather than producing a success-shaped free-deployment result.

- Exit **0**: the local choices permit a separate target/pricing/what-if review. Not approval to deploy.
- Exit **2**: zero-spend is blocked or fixed-charge acknowledgement is missing.
- Exit **1**: invalid input or command failure.

The command is an offline review, not an enforced Azure spending cap. It does not intercept arbitrary Bicep/CLI deployments or certify eligibility. The candidate guided publishing interface is documented in [public-demo deployment](demo-deployment.md); it remains gated and is not the default.

Do not remove narrow SQL access, enable a broad Azure-services rule, publish private source/images or change registries to claim zero cost. An alternative secure free-hosting/image-distribution design needs separate review. Stay local if zero cloud spend is mandatory and no verified design meets it.

### Separately reviewing paid supporting resources

If you choose to review paid supporting resources, use a local `azure-demo-cost.json`:

```json
{
  "version": 1,
  "profile": "public-demo",
  "hosting": "static-web-apps",
  "intent": "review-paid-costs",
  "sql": { "mode": "free-paused" },
  "acknowledgeFixedCharges": true
}
```

The acknowledgement concerns known fixed charges, not deployment permission or an agreed monthly price. Actual prices depend on region, currency, account/offer and usage. The report deliberately returns `estimatedMonthlyCost: null` until a real pricing review occurs; it does not invent dollar values.

For a separately chosen ordinary paid database:

```json
"sql": {
  "mode": "paid-reviewed",
  "sku": { "name": "S0", "tier": "Standard", "capacity": 10 },
  "maxSizeBytes": 268435456000,
  "backupRedundancy": "Geo"
}
```

Replace the SQL object in the complete paid-review configuration. This illustrates the contract, not a recommended sizing or price quote. The SKU must be supported for the selected region/subscription and reviewed for the actual workload. Unknown fields, paid SQL under zero-spend intent, and free-tier paid-continuation choices are rejected before cloud access.

The normal local configuration name is ignored by Git and excluded from Docker contexts. Keep secrets and actual application records out of cost configuration.

## New SQL database billing policy

The minimal [foundation template](../../infra/demo.bicep) requires an explicit `sqlBillingMode`:

- **`free-paused`:** General Purpose serverless `GP_S_Gen5_2`, maximum 2 vCores, minimum 0.5 vCore, 32 GiB maximum data, local backup redundancy and a 60-minute idle auto-pause delay. Sets `useFreeLimit: true` and `freeLimitExhaustionBehavior: AutoPause`.
- **`paid-reviewed`:** an ordinary paid database using the explicitly supplied SKU, maximum size and backup redundancy. It does not enable free-tier paid continuation.

Both modes retain required sizing parameters for the template contract. In free-paused mode the fixed free settings above take precedence; use the matching `sql.parameters` fragment returned by `demo-cost`. In paid-reviewed mode the supplied sizing is used. The cost fragment is not a full deployment parameter file or a supported manual substitute for the unfinished deployment guide.

If free enrollment fails because of eligibility, region, available slots or policy, stop and explain the failure. Never retry by disabling the free limit, changing the billing mode or selecting another region automatically.

This policy is for **new databases**. Do not apply it as an existing-database conversion or interpret a cost acknowledgement as approval for an irreversible change. In particular, Microsoft documents that free-tier paid continuation cannot revert to pause-at-monthly-limit behavior.

Under the free tier, exhaustion can make the database unavailable until the next calendar month. Idle auto-pause and resume also affect responsiveness. Open connections can prevent idle auto-pause; pooling, readiness probes and polling need live observation before promising that a deployed SQL/DAB app sleeps.

## Allowances and what consumes them

Current documentation reviewed on **2026-10-09**:

| Resource | Included amount | Scope and caveat |
| --- | --- | --- |
| SQL free tier | 100,000 vCore-seconds, 32 GB data and 32 GB backup storage | Per database/month, up to 10 databases per subscription; verify subscription/region eligibility. |
| Container Apps Consumption | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million HTTP requests | Shared across the subscription per calendar month; overages are billable. |
| DAB | No separate DAB service fee | Its container still consumes allocated CPU/memory. |
| ACR Basic | Paid registry tier | Recurring charge plus applicable additional usage; not stopped by app scale-to-zero. |
| Custom-network managed infrastructure | Applicable public-IP/load-balancer charges | Inspect the managed infrastructure resource group, not just the app resource group. |

The [minimal runtime](../../infra/demo-runtime.bicep) allocates 0.75 vCPU and 1.5 GiB across gateway and DAB. With all grants unused, the CPU and memory grants each cover about **66.7 active replica-hours**. This is illustrative allocation time, not visitor-hours, a price quote or a spending cap. Startup, gaps between visits, bots and other apps can consume allowances. Request allowance alone does not establish free operation.

SQL's 100,000 vCore-seconds equal about **27.8 vCore-hours**, not a user/query allowance. Maximum configured vCores do not mean that allocation is always consumed at that maximum; observe actual billing/usage.

Optional file storage, background jobs, observability, data transfer, build operations, AI and retention can add charges. Review the actual chosen capabilities, account-wide grant usage and full resource inventory.

## Visibility before growth

Neither `demo-cost`, `demo-preflight` nor the saved guide checkpoint queries actual costs/usage or configures alerts. Their reports state that explicitly.

Before cloud writes, review region/currency/account pricing and available grants. After separately approved deployment:

Use [Monitor usage and decide when to grow](monitor-growth.md) for an end-to-end workflow with the free Database Hub preview, SQL resource queries, and before/after verification. Monitoring requires separate opt-in setup; these SQL Apps commands do not enable it.

1. Check SQL's **Free monthly vCore amount** / **Free amount remaining** in the portal. The free-tier guidance describes a remaining-compute alert before exhaustion.
2. Review Container Apps consumption across the subscription. Avoid claiming this app has the whole shared grant.
3. Inspect actual and forecast costs in both the app resource group and the Container Apps managed infrastructure resource group.
4. Configure reviewed budget/usage alerts with explicit recipients and thresholds. **Budgets are delayed notifications, not hard spending caps; they do not stop resources.**
5. Keep resource ownership and a reviewed cleanup/export path. Stopping the app is not deleting a paid registry, database or networking resources; never delete user data automatically.

Choose paid growth when measured usage or requirements justify it: allowance exhaustion, unacceptable cold starts, people relying on availability, capacity/latency pressure, or stronger real-data recovery/access requirements. The learning profile may be inappropriate even for a small number of users.

Public visitor-session creation has no app-level admission throttle or rate limit: anyone may create a session at any rate. The application's SQL does enforce a **global live-session cap of 1000**; past it, `CreateSession` returns `capacity` and the gateway answers HTTP 429 until sessions expire (60 minutes) or are deleted. Because creation is unthrottled, roughly a thousand rapid requests can exhaust that cap and make the demo refuse new visitors for up to an hour. That is a deliberate availability-over-cost trade: the cap bounds database work rather than silently buying capacity. Popularity should prompt usage review and an explicitly approved move to paid capacity, not an automatic billing change. Per-session data/mutation limits still apply. Automated traffic can consume allowances too; this policy is not a spending cap or an availability guarantee. Free-tier SQL still pauses when its configured allowance is exhausted. These commands do not implement usage monitoring or automatically upgrade the application.

The demo environment ships Container Apps console logs to its own Log Analytics workspace so a failed visitor session can actually be diagnosed. The workspace is capped at 0.1 GB per day with 30 day retention, inside the included free allowance; ingestion above the cap is dropped rather than billed. Raising `logRetentionDays` or the daily cap is a billable change and needs its own cost review.

The zero-to-one replica limit bounds app capacity, not total cost. An authenticated real-data application needs its separate [production deployment review](deployment.md); never expose real sensitive data anonymously to achieve a cheaper demo.

## Compare the hosting candidates

The Static Web Apps option adds a Standard plan for static delivery and keeps one linked Container App for the Node API and internal DAB. It does not replace ACR, networking, SQL or Container Apps, so it is likely not cheaper than the current Container Apps default.

After recording current regional/account prices and measured workload usage in a local comparison configuration, run:

```powershell
npm run azure -- hosting-compare azure-demo-hosting-comparison.json
```

Compare both options using the same evidence date, region, currency, requests, transfer and active-backend hours. Unknown prices remain unknown rather than zero. `container-apps` remains recommended when the Static Web Apps total is higher or live acceptance is false. `static-web-apps` can be recommended only when its measured total is no greater and live acceptance is true. The report does not deploy resources or change the default; record and review the evidence separately.

## Sources to recheck before deployment

- [Azure SQL free tier (Microsoft's free-offer documentation)](https://learn.microsoft.com/azure/azure-sql/database/free-offer)
- [Container Apps billing](https://learn.microsoft.com/azure/container-apps/billing)
- [Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)
- [Container Registry pricing](https://azure.microsoft.com/pricing/details/container-registry/)
- [Custom-network managed infrastructure](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks#managed-resources)
- [Cost Management budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
