# Costs and growth

## Start locally

Running SQL Apps on your computer does not create an Azure usage bill. You still need the required tools, downloads and SQL private-preview access. Docker Desktop and your chosen AI provider have their own licensing, account and pricing conditions.

You do not need to deploy to Azure to build, test or keep using a local app.

When adding capabilities, consider their future costs without choosing cloud infrastructure yet. Files need storage, background work needs compute, and AI calls can add usage charges. Do the detailed pricing review when you decide to share, not before you have a useful local app.

## Understand free tier before sharing

**Free tier means recurring monthly allowances, not a time-bound trial.** Allowances have limits and eligibility requirements; they are not unlimited hosting.

Azure SQL and Container Apps have free allowances, but the current demo templates also use a paid container registry and managed networking. Scaling the app to zero does not remove those charges. The authenticated deployment uses additional paid services.

The Static Web Apps candidate does not remove that stack. Static Web Apps Standard serves the static website, while one linked Container App still runs the Node API and internal DAB. ACR, networking, SQL and Container Apps can still charge, and Standard adds its own plan. It is therefore likely not cheaper and must not be presented as a cost-saving default without current, same-basis evidence.

## Do not confuse the deployment profiles

The profiles have very different idle cost floors. None is a general-purpose
"cheap Azure" profile:

| Profile | Intended use | Main idle cost drivers |
| --- | --- | --- |
| Local | Build and single-machine evaluation | No Azure resources |
| Public demo | Small disposable browser demo | ACR Basic and custom-network Container Apps infrastructure remain paid even when app replicas scale to zero; SQL can use the eligible free-paused offer |
| Role-based data (default cloud profile) | Small private SQL/DAB POC without files or Functions | Eligible free-limit serverless SQL, two scale-to-zero Container Apps, capped Log Analytics, ACR Basic, and one SQL private endpoint |
| Foundation (explicit opt-in) | Full production-like validation | Paid S0 SQL, always-on Container Apps, an always-billed Functions EP1 plan, Storage, Key Vault, six private endpoints, Application Insights, and their data/telemetry usage |

The full foundation profile is deliberately secure and capability-complete,
but it is an expensive way to run a demo. In East US on 2026-10-13, the
public Azure Retail Prices API listed Premium Functions compute at
USD 0.173/vCPU-hour plus USD 0.0123/GiB-hour, S0 SQL at USD 0.48/day, and
ACR Basic at USD 0.1666/day before storage and build usage. Microsoft
documents that every Functions Premium plan keeps at least one billed
instance; EP1 allocates 1 vCPU and 3.5 GB. At those dated public retail rates,
one always-billed EP1 instance is about USD 158 for a 730-hour month, S0 SQL
is about USD 14.60 for a 30.4-day month, and ACR Basic is about USD 5.06 for
the same month. That is roughly **USD 177/month before** Container Apps
allocation, private endpoints, logs, storage, backup, builds, or data
transfer. This is an illustrative public-retail floor, not an account quote
or actual-cost result. Treat foundation as a production-validation profile,
not a starter cost profile.

The offline `demo-cost` command prices the public-demo contract, and
`role-based-cost` describes the reduced role-based-data contract. There is
currently no offline command that quotes or approves the full foundation
profile. Before provisioning foundation, inventory the generated resources
and obtain a current account/region estimate for EP1, S0, both minimum
Container Apps replicas, six private endpoints, ACR, Log Analytics,
Application Insights, Storage, Key Vault, backup, and transfer. A cost
acknowledgement for a smaller profile does not approve foundation.

## Lowest-cost POC path

The lowest-cost path is not "pick any free tier and deploy". For this repo, a zero-dollars or near-zero-dollars proof-of-concept should stay local unless a reviewed design is explicit about which services are in scope, what is still paid, and which grants are being consumed.

A simplified App Service or Static Web Apps candidate may be cheaper than the current Container Apps default for specific workloads, but it does not remove the need to review:

- free-tier eligibility and monthly activation limits for Azure SQL,
- App Service plan choice and whether the chosen plan supports the application boundary,
- storage, networking, container registry and observability costs that still exist even when the app is idle,
- and whether a DB-free or local-first approach is the correct boundary for a true zero-cost proof-of-concept.

This repo defaults cloud initialization and the main Bicep template to the
role-based-data POC profile. It uses the Azure SQL free limit with
`AutoPause`, scales both Container Apps to zero, and caps Log Analytics
ingestion at 0.1 GB/day. It retains one SQL private endpoint because schema
publication and runtime SQL access must remain private. The paid foundation
stack is never inferred: it
requires an explicit `--profile foundation` choice and a separate cost review.
Security boundaries remain intact; the cheaper default removes capabilities
instead of weakening identity, SQL authorization, TLS, or network access.

If zero Azure spending is a requirement, stay local until you have reviewed a hosting design that meets it. SQL Apps does not currently provide a guaranteed zero-cost deployment.

Before creating resources, select the approved capability/access profile, then review the target region, subscription eligibility, fixed charges, expected usage and cleanup plan. The [offline demo cost command](../reference/demo-cost.md) identifies known demo charges without contacting Azure; it is demo-only, not an authenticated app cost model, price quote or spending cap. Role-authorized data-only apps use the matching [role-based-cost review](../reference/role-based-data.md#profile-specific-azure-preparation); do not price an older stack or substitute the full foundation as though it were the agreed app.

For the hosting candidate, populate `azure-demo-hosting-comparison.json` with dated regional/account pricing and measured usage, then run `npm run azure -- hosting-compare azure-demo-hosting-comparison.json`. Use the same region, currency, request count, transfer and active-backend hours for both choices. Container Apps remains recommended if Static Web Apps costs more or live acceptance has not passed; no command changes the default automatically.

## What happens when an allowance runs out?

The free-tier SQL configuration pauses at its monthly limit rather than automatically switching to paid usage. That can make the app unavailable until the next calendar month. Idle pause and resume can also introduce delays.

Other Azure resources may charge for usage beyond their allowances. Budget alerts notify you; they do not stop spending. Review actual subscription-wide usage, not just visitor counts.

## Grow when the app needs it

Start with visibility, not an upgrade. After sharing an app on Azure SQL, you can use **Database Hub in Microsoft Fabric (preview)** to monitor it in place. The experience is available with a Fabric Free license; no Fabric capacity or separate Database Hub license is required to get started, and enabling its SQL performance monitoring has no extra cost. Your Azure resources still have their normal charges.

Follow [Monitor usage and decide when to grow](../reference/monitor-growth.md) to connect your database, check free-tier headroom, and investigate resource pressure with read-only SQL queries.

1. **Observe:** check remaining SQL free allowance, performance during a real app action, and subscription-wide costs.
2. **Improve:** investigate expensive queries, repeated polling or background work before adding capacity.
3. **Decide:** consider paid capacity when measured limits, unacceptable delays or availability/recovery needs justify it.
4. **Verify:** repeat the same app action after an approved change and compare performance and cost.

Popularity is a reason to review usage, not a user-count threshold for upgrading. Public visitor-session creation has no app-level admission throttle or active-session cap; existing per-session data and mutation limits still apply. Automated traffic consumes resources too.

You choose whether and when to pay for more capacity. SQL Apps does not change billing or upgrade automatically. Monitoring is a separate opt-in setup using Database Hub or the Azure portal, not something the SQL Apps commands configure for you.

For current allowance figures, template settings and monitoring steps, use the [cost reference](../reference/demo-cost.md). For deployment choices, read [Sharing your app](sharing.md).
