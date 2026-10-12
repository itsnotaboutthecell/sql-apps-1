# Public-demo publishing candidate

Use this reference to verify a selected local reference app, review its Azure target and understand the candidate publishing journey. This path is only for an anonymous public demo with synthetic data. Authenticated role-based-data and full-foundation applications keep their existing private guidance and deployment references.

## What the candidate deploys

The visitor sees one app at **one public URL**. Azure Static Web Apps Standard serves only the selected static website and forwards same-origin `/api/*` requests to one linked Azure Container App. The Container App runs the protected Node API and a self-hosted DAB sidecar. DAB is internal, has no public ingress and connects to Azure SQL using managed identity.

This is not an App Service website. It does not use the retired Static Web Apps Database Connections feature or `/data-api`. Static Web Apps links only the Node API; the browser never calls DAB or the Container App hostname directly.

Static Web Apps Standard can charge, as can ACR, networking, SQL and Container Apps. Adding Standard is likely not cheaper than the current Container Apps design. Container Apps therefore remains the default until `hosting-compare` has current, same-basis cost evidence and every live acceptance gate below passes.

## Candidate command journey

The proposed end-to-end command sequence is:

```powershell
npm run app:build -- todo public-demo
npm run azure -- demo-cost azure-demo-cost.json
npm run azure -- demo-preflight azure-demo-target.json
npm run azure -- demo-publish azure-demo-publication.json
npm run azure -- demo-publish azure-demo-publication.json --approve <reviewed-id>
npm run azure -- demo-status azure-demo-publication.json
npm run azure -- hosting-compare azure-demo-hosting-comparison.json
```

Treat this as a candidate interface until its implementation and live gates are complete. `demo-publish` without `--approve` is review mode: it must be read-only and print the exact pending writes, known charges, exclusions, source/image publication, cleanup plan and approval ID. The ID binds approval to that exact pending work. Do not approve if the target, configuration or inventory changes.

The publication configuration keeps the Container Apps `location` separate from `staticWebAppLocation`, because Static Web Apps has a smaller region set. It requires `cost.intent: review-paid-costs` and `cost.acknowledgeFixedCharges: true`; the fixed-charge acknowledgement and SQL choices are part of the approval hash. This does not replace the dated regional/account pricing review or authorize a default-hosting change.

The configuration also requires the reviewed public IPv4 address of the schema runner. The schema stage creates a firewall rule for only that address, publishes with Microsoft Entra authentication, and removes the rule before continuing. A cleanup failure stops publication; it never substitutes a broad Azure-services rule.

Static upload obtains the deployment token from the explicitly reviewed subscription, resource group and Static Web App, keeps it only in the child process environment, clears inherited Azure service-principal variables, and redacts the token from errors. The workflow verifies the deployed `app.js` hash before saving the static stage, so a misleading zero exit from the SWA CLI cannot make resume skip an upload that did not happen.

After explicit approval, the approved form performs only the reviewed stages. A failed stage must stop, preserve deployment state and print the exact resume command; resuming must not delete data or repeat completed work. `demo-status` reconciles owned resources and stage state without claiming that a reachable URL passed acceptance. Neither status nor cost review authorizes additional writes.

`hosting-compare` uses dated pricing and measured usage on the same region, currency and workload basis. It can recommend the Static Web Apps candidate only when its measured monthly total is no greater and live acceptance is true. It never changes the default automatically.

## Choose the profile first

- **Local simulation:** subscription-free, loopback-only anonymous synthetic sessions for this selected reference. This is separate from the default foundation's local preview account journey, which keeps identity testing on a separate developer-only page.
- **Public synthetic-data demo:** intended anonymous HTTPS browser/API, internal DAB and Azure SQL. It must require synthetic-data acknowledgement and omit visitor sign-in, app-registration creation and Graph prerequisites. Cloud resources are separately authorized and can incur charges.
- **Authenticated application:** use the existing [full-foundation deployment](deployment.md), with its explicit Entra and service requirements. It is not the minimal public-demo path.

Never infer an authenticated production profile from the word "deploy."

## Free-tier-first cost review

Start with [costs and paid growth](../guides/costs.md), then run `npm run azure -- demo-cost azure-demo-cost.example.json` after building. This is offline and makes no Azure requests. The zero-spend example exits 2 with `blocked-by-fixed-charges`: SQL/compute free allowances do not remove ACR Basic or custom-network managed infrastructure charges. See [the cost command reference](demo-cost.md) for configuration and output details.

The review reports known charge sources, SQL policy, shared grants, theoretical compute headroom and usage-monitoring next actions; it does not invent prices, query actual usage or configure budgets. A paid-cost review requires an explicit fixed-charge acknowledgement, but never authorizes deployment. Do not silently change hosting/network security or use paid resources when a free-only intent is blocked.

Public visitor-session creation is not admission-throttled or rate-limited, but the application's SQL enforces a global cap of 1000 live sessions; beyond it the gateway returns HTTP 429 until sessions expire after 60 minutes. Unthrottled creation therefore makes a denial of new visitors reachable with about a thousand rapid requests. Follow the [usage and paid-growth policy](demo-cost.md#visibility-before-growth): popularity prompts owner-approved capacity review, not automatic billing changes. Per-session limits and SQL free-tier exhaustion pause still apply.

## Verify the actual selected app locally

Follow [the reference guide](../../examples/todo/README.md) and [local development](local-development.md). Select the runtime home/workspace explicitly, build the selected artifact, run `selected-app`, open its reported browser origin, and approve `selected-test` separately. The default application remains sample-free.

Local SQL/DAB/browser acceptance does not verify Azure managed-identity authentication, Azure policy, quotas, public HTTPS ingress or deployment readiness.

## Read-only tenant-scoped Azure diagnostics

This step requires an Azure subscription and a CLI user or service-principal sign-in. It is unnecessary for local development. Confirm the exact target and approve these read-only Azure requests first; do not log in, refresh caches or change global subscription selection automatically.

Copy [the diagnostic target example](../../azure-demo-target.example.json) to a local configuration and replace every placeholder with the chosen tenant, subscription, resource group, backend region and Static Web Apps region. This is a separate strict diagnostic contract, not the full-foundation configuration. No app-registration IDs, service images or secrets belong in it.

```powershell
npm run build
npm run azure -- demo-preflight "<target-configuration.json>"
```

The command distinguishes:

1. **CLI subscription cache:** missing, stale or unavailable discovery is reported independently. A default-tenant discovery/Graph error is not proof of revoked ARM access.
2. **Tenant token:** the existing CLI acquires an ARM token for the explicitly chosen tenant. The supported sign-in methods for `--tenant` are user/service principal, not Cloud Shell or managed-identity accounts. The command uses UTC `expires_on` metadata (CLI 2.54.0 or later) instead of ambiguous local-time expiration.
3. **Actual ARM access:** in-memory, bounded HTTPS reads target the selected subscription/group using that token. Nothing changes the CLI's global defaults. Tokens are never printed or persisted; pagination cannot leave the exact ARM endpoint/scope.
4. **Providers and region:** required minimal-service providers must already be registered and advertise the chosen region. Registration, alternate-region selection and resource-group creation are not automatic repairs.
5. **Candidate write authorization:** effective permission pages are inspected, including action exclusions. Missing grants, policy/deny responses, forbidden ARM access and transient failures have distinct diagnostic codes.
6. **Policy/quotas:** an eligible diagnostic result still explicitly reports policy as not yet evaluated. Approved target-specific what-if/deployment must evaluate conditional access, deny assignments, policy, quotas and the chosen SQL configuration. Read access is not deployment proof.

This command makes no Graph requests, registrations, image publication, schema changes, resource writes or firewall changes. A missing resource group is reported as requiring separately approved creation, not silently created. Provider registration failures need deliberate target review rather than a generic login reset.

The existing full-foundation commands remain separate. Before future demo provisioning, review all selected billable dependencies, explicit SQL settings, network changes, source publication and a precise teardown path. No cloud write is authorized by saving this diagnostic configuration.

## Minimal template preparation

The foundation's default deployment prefix is `sqlapps`. The runtime requires an explicit `applicationName`, which determines the browser hostname prefix; use a reviewed `sqlapps`-prefixed name for the starter. Existing resource names and URLs are not changed automatically.

The separate [foundation template](../../infra/demo.bicep) prepares a Container Apps Consumption environment, one runtime managed identity, Basic Azure Container Registry, a selected VNet/subnet with a SQL service endpoint, Azure SQL server/database and narrow subnet rule. The [runtime template](../../infra/demo-runtime.bicep) subsequently deploys only the selected gateway and internal DAB sidecar. This split allows infrastructure, source publication and SQL preparation to remain separately approved stages.

- **SQL billing is explicit:** require `sqlBillingMode` with `free-paused` or `paid-reviewed`. Free-paused enrolls a new serverless database in the free tier with `AutoPause`, fixed 2-vCore maximum/0.5 minimum, 32 GiB size, local backup redundancy and 60-minute idle auto-pause. Paid-reviewed uses the required reviewed SKU/size/backup parameters. Both retain those parameter fields; use the matching cost report fragment. No paid continuation, existing-database conversion or paid fallback is authorized. Verify free eligibility/region/slots; unsupported configurations must fail rather than change tiers.
- **Networking is restricted, not private:** SQL's public endpoint is enabled but accepts the chosen subnet rule; no broad Azure-services exception or runner firewall rule is created by these templates. Any temporary runner rule belongs to the separately approved SQL setup workflow.
- **Runtime is bounded:** HTTPS gateway ingress only, one active revision, zero-to-one replicas and loopback-only DAB. Scale-to-zero is not a claim that SQL, registry, networking or other platform charges disappear.
- **Anonymous work is bounded:** SQL allows at most 1,000 active visitor sessions and 300 mutation attempts per minute across the demo, in addition to each session's 50-item and 30-mutation limits. Reaching a global limit returns HTTP 429.
- **Usage visibility is separate:** review actual subscription-wide compute grants, SQL remaining free amount, and app/managed-group costs after approved deployment. Budgets are alerts, not hard spending caps; these preparation commands configure none.
- **Logging is deliberately minimal:** a capped Log Analytics workspace (0.1 GB/day, 30 day retention) receives Container Apps console logs so failures are diagnosable, and nothing else is provisioned. No Application Insights, storage, Functions, Key Vault, private endpoints or NAT gateway. This small demo profile is not an operational production baseline.
- **Images remain selected:** build outputs contain separate gateway and pinned-base DAB Dockerfiles, OCI source/selection/route labels and an allowlist Docker build context. SQL setup files, the local-path manifest, unrelated examples and tests are not included in that context. Published images still require immutable digests and separate source-publication approval.

With Azure CLI/Bicep already installed, the following compiles both templates into temporary files, checks the generated resource/SQL/network/ingress contracts and removes the temporary output. It does not require a subscription sign-in or provision resources:

```powershell
npm run build
npm run infra:test-demo
```

These are preparation components, not a supported manual substitute for the candidate command journey. SQL identity/procedure probing, image publication, ownership/resume reconciliation and live HTTPS acceptance must be completed before reporting a successful demo deployment.

## Required live acceptance

Run this checklist against the deployed Static Web Apps hostname after separately approved publication. Record evidence for every item. A failed security or isolation check blocks release, keeps Container Apps as the default and leaves Static Web Apps in candidate status.

- [ ] `GET /` returns the selected static application from the Static Web Apps hostname.
- [ ] `POST /api/session` sets `__Host-sql_apps_session` with `Secure`, `HttpOnly`, `SameSite=Strict` and `Path=/`.
- [ ] `GET`, `POST`, `PATCH` and `DELETE /api/todos` preserve the current status and response contracts.
- [ ] A second browser session cannot read the first session's rows.
- [ ] Expired and deleted sessions cannot read their rows.
- [ ] `/api/application/config` reports the selected public-demo limits.
- [ ] `/api/health/ready` succeeds through Static Web Apps after a cold start.
- [ ] Direct backend calls are denied: the Container App hostname rejects `/api/session` and `/api/todos`.
- [ ] A mutation with a foreign `Origin` is rejected.
- [ ] Requests that submit `X-MS-CLIENT-PRINCIPAL` or `X-MS-API-ROLE` are rejected.
- [ ] DAB has no public ingress, and `/graphql` and `/mcp` remain disabled.
- [ ] SQL has no broad Azure-services firewall rule.
- [ ] Actual costs appear only in the explicitly owned resource groups and match the hosting-comparison inventory.

References: [CLI token acquisition](https://learn.microsoft.com/cli/azure/account#az-account-get-access-token), [CLI authentication and UTC expiration](https://learn.microsoft.com/cli/azure/authenticate-azure-cli), and [effective resource-group permissions](https://learn.microsoft.com/rest/api/authorization/permissions/list-for-resource-group).
