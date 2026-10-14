# Authenticated Azure deployment reference

Use this reference when deploying an authenticated application with the SQL Apps Azure infrastructure template. Start with [sharing your app](../guides/sharing.md) to choose the appropriate path. For an existing pre-rebrand deployment, review [migration notes](../maintainers/naming-transition.md) first.

> **Existing deployments:** This reference documents SQL Apps' retained Azure deployment for the role-based-data profile. For new projects, use maintained Azure Skills (`azure-app-onboard` when architecture is open, then `azure-prepare` -> `azure-validate` -> `azure-deploy`, with `azure-cost-optimization` and `azure-diagnostics`) and the Azure SQL skills (`build-app-on-azure-sql`, `dab-rest-and-graphql`, `deploy-app-to-azure`, `entra-id-auth`), and retain SQL Apps' application-specific identity, DAB, schema, and acceptance requirements. Do not mix `.azure` deployment state with the custom `npm run azure` state.

## Profile and deployment subject

The authenticated cloud path is the [role-based-data profile](role-based-data.md), the only SQL Apps profile: a private Azure SQL Database, Azure Container Registry images for the gateway and Data API builder (DAB), and two scale-to-zero Container Apps, with human application roles and free-limit SQL. There are no Functions, Storage or Key Vault resources. File storage or background jobs belong to maintained Azure skills, outside SQL Apps. Do not use an anonymous demo without an agreed scope change. Review actual regional/account prices with the Azure Cost plugin before approving paid steps.

Keep the confirmed new application checkout/configuration/artifacts as the deployment subject. With read-only Azure authorization, discovered older resources are potential collisions, not permission to reuse or modify them. Reuse requires an explicit request and a separate compatibility/migration/cost review; existing data remains untouched.

## Supported tools

The project uses Azure CLI/Bicep for infrastructure and Microsoft.Build.Sql/SqlPackage for schema publishing. No custom Azure control-plane client or SQL migration engine is implemented.

Run the validation commands in [Contributing](../../CONTRIBUTING.md) first. Sign into the correct tenant using `az login`; CI uses Azure Login federation. All resource commands specify the configured subscription instead of changing your global default subscription.

The runtime uses stateless bearer tokens. User tokens must be v2 access tokens for the configured API, with the `access_as_user` scope. No caller-supplied identity headers are trusted.

`DAB_URL` must be an exact HTTPS origin without embedded credentials, paths, queries or fragments. Runtime validation fails before startup rather than forwarding a bearer token to an insecure or ambiguous endpoint.

DAB returns relative REST continuation links so clients remain on the public gateway origin. The isolated Todo example tests pagination, preserving opaque tokens and rejecting unsafe links; it is not part of application delivery. Application-specific clients need equivalent pagination validation.

Develop and verify the SQL/data layer first using [local development](local-development.md), without provisioning cloud resources. Local claim simulation must never be deployed; cloud DAB continues to validate Entra bearer tokens.

The cloud DAB managed identity receives only `EXECUTE` and object-scoped `VIEW DEFINITION` on the authorized DAB stored procedures. Real applications must define domain-specific procedures/grants and acceptance; implement row or owner restrictions in SQL where required.

## Resource group and images

Use a dedicated resource group. Create it and an ACR using standard Azure CLI commands after reviewing your subscription and region:

```powershell
az group create --subscription <subscription-id> --name <resource-group> --location <region>
az acr create --subscription <subscription-id> --resource-group <resource-group> --name <registry-name> --sku Basic --admin-enabled false
```

Both image references (`gatewayImage` and `dabImage`) must use an explicit version tag or digest. After filling in the configuration, build from the repository root:

```powershell
npm run azure -- artifacts sql-apps.json
```

`artifacts` invokes ACR builds for the gateway and DAB images, resolves each result to its digest, and records `imageSource`, a fingerprint of the SQL/DAB source the images were built from. It atomically updates your configuration only after both builds succeed. If a build fails, an earlier image may exist in ACR but configuration remains unchanged. Already pinned images are rebuilt under a fresh timestamp tag, so release tags are never overwritten. This command publishes your source to your configured Azure registry, and requires ACR build/push/read permissions.

Alternatively use the underlying standard Azure CLI commands:

```powershell
az acr build --subscription <subscription-id> --registry <registry-name> --image sql-apps:0.2.1 --file Dockerfile .
az acr build --subscription <subscription-id> --registry <registry-name> --image sql-apps-dab:0.2.1 --file dab/Dockerfile .
```

Images built this way have no recorded `imageSource`, so `deploy` refuses them; use `artifacts` for SQL Apps deployments. ACR tasks require suitable Azure permissions and may have region/subscription restrictions. Images are not built by `deploy`. Use immutable digests for release, not tags that are overwritten. Publishing code to a registry is an explicit operator action. A legacy `functionsImage` setting is accepted only as an empty string.

## Shortest path

After `az login` as the person who will administer SQL, generate a configuration
read-only; tenant, subscription, SQL administrator and role settings are
derived, so only placement is asked for:

```powershell
npm run azure -- init sql-apps.json --location westus2 --resource-group rg-sql-apps-poc --registry <name>.azurecr.io
npm run azure -- deploy-all sql-apps.json
```

`init` writes a role-based-data configuration: free-limit serverless SQL,
scale-to-zero gateway and DAB containers and capped logs. It reads
`requiredRole` and `readinessPath` from `role-based-data.json`.

`deploy-all` without `--approve` only lists the pending paid steps (`identity`,
`artifacts`, `provision`, `deploy`, `status`), the exclusions and an id. Review
costs with the Azure Cost plugin and those steps, then, after explicit
approval, run `deploy-all sql-apps.json --approve <id>`. It runs the existing
commands below in order, skips completed ones and refuses a stale id. After
`provision`, it stops for the separately authorized Azure RBAC handoff described
below. Once an administrator completes that handoff, rerun `deploy-all`; it
verifies live assignments before publishing SQL or runtime resources. On a
failure, such as no private-network path to SQL before `deploy`, fix the cause
and rerun it to resume. Application-role assignment and smoke tests stay
separate.

Completed stages are skipped only when their saved fingerprint still matches
the configuration and the SQL/DAB source. A changed configuration or source
makes `artifacts` and `deploy` pending again, with a new approval id to review.
Do not delete saved state to force a resume or treat an old healthy gateway as
the changed release.

## Updating a deployment

To release a change to an existing deployment:

1. Edit the SQL project, `dab/dab-config.json` or the deployment configuration.
2. Run `npm run azure -- artifacts sql-apps.json`. It rebuilds both images, retags pinned digests and records the new `imageSource`.
3. Run `npm run azure -- deploy sql-apps.json`.

`deploy` refuses images built from different SQL/DAB source than the current checkout (DAB bakes `dab-config.json` into its image); run `artifacts` again, then `deploy`. When the configuration or SQL/DAB source changed, `deploy` rolls every stage forward (infrastructure, non-destructive schema publication, runtime and readiness); an unchanged configuration resumes from its saved stage. Verify with `status` and `role-based-smoke` afterward.

If a maintained deployment route (Azure skills or `azd`) applies the schema instead, run `npm run azure -- grants sql-apps.json`. It writes `dist/sql/role-based-grants.sql`, the exact DAB stored-procedure `EXECUTE` and `VIEW DEFINITION` grants SQL Apps applies, for that route to apply after it creates the DAB database user.

## Entra configuration

Copy [the example](../../sql-apps.example.json) to `sql-apps.json`, or use `init` above. Fill in the target tenant/subscription, SQL administrator, resource group/region, and images.

The starter uses `"name": "sqlapps"`. With environment `dev`, the gateway's Azure-generated hostname starts with `sqlapps-dev-gateway.`. Azure supplies the remaining domain/suffix, so use the actual deployment outputs rather than constructing a URL yourself. Image repository names can remain `sql-apps`; they do not determine the browser URL.

An existing configuration with a different `name` still selects resources using that prefix. Review it before deployment. Changing the name creates/selects a different resource set and does not rename or migrate an existing app, database or URL. Preserve existing data and review Entra redirects and dependent endpoints before a separate migration.

Create a dedicated app registration once:

```powershell
npm run azure -- identity sql-apps.json
```

This is an explicit create operation, not an idempotent lookup by display name. It creates one single-tenant SPA/API registration, a delegated `access_as_user` scope, the configured human application role such as `AppUser` (allowed member type `User`), and a service principal. When the configuration came from `init` (placeholder `apiClientId`), the printed ID is saved into it; otherwise replace `apiClientId` in your real configuration with the printed ID.

`role-based-assign` explicitly assigns approved users/groups. Verify API access-token role claims, trusted gateway-selected DAB role, procedure permissions and SQL grants end to end with `role-based-smoke` and browser acceptance. Local simulation and app-side role enforcement alone do not prove Entra/cloud authorization.

An account email address is not a tenant ID. Confirm the intended directory's tenant ID, or retrieve it with an authorized read-only account query, before tenant-specific sign-in. Do not change subscription defaults or repeat generic login instructions to resolve that mismatch.

The registration requests v2 access tokens. The same registration is used by the browser and API. Deployment adds the exact HTTPS `/auth/redirect.html` callback on the actual gateway origin without removing existing redirects. Real local sign-in uses a separately reviewed development registration and the printed loopback callback; see [Authentication and application access](authentication.md). An Entra administrator may need to grant consent under your tenant's policy.

Alternatively configure an existing dedicated registration with the same scope and application role:

- Delegated scope ID: `6bb296dd-f397-4dcc-a69b-d37dfce3c555`, value `access_as_user`.
- An enabled application role whose value matches `requiredRole`, allowed member type `User`.
- Identifier URI: `api://<apiClientId>`.
- Sign-in audience: `AzureADMyOrg`; requested access-token version: `2`.

The deployment operator needs directory rights to update redirects. Graph permissions and Azure resource RBAC are separate.

## SQL network deployment

SQL's public endpoint is disabled and a private endpoint is retained.
Run schema deployment on a machine/runner that can reach the VNet through
peering/VPN or another approved network path. The `networkId` deployment
output identifies it. The default network range is `10.42.0.0/16`; review
conflicts before deployment.

The configured `sqlAdminObjectId` must identify your migration principal or an Entra group containing it. SqlPackage signs in with `Authentication=Active Directory Default`, pinned to your Azure CLI sign-in (`AZURE_TOKEN_CREDENTIALS=AzureCliCredential`) and the configured tenant, so no access token is passed on the command line or saved. Sign in with `az login --tenant <tenant>` first. Check the selected SQL identity explicitly; Azure resource permissions do not automatically authorize database schema publishing.

No public SQL firewall exception is added to make migrations pass. Use
`provision` to create infrastructure and obtain its network ID before
connecting a private runner. If schema publishing fails, infrastructure stage
state is retained and deployment stops before gateway/data rollout.

## Privileged Azure RBAC handoff

The ordinary infrastructure template does not create Azure role assignments
and does not require `Microsoft.Authorization/roleAssignments/write`. After
`provision`, give an authorized administrator the unchanged configuration,
checkout, and generated deployment state. The administrator must preview and
apply only the dedicated RBAC template:

```powershell
npm run azure -- rbac-plan sql-apps.json
npm run azure -- rbac-deploy sql-apps.json
```

This grants only the gateway and DAB managed identities ACR pull.
`rbac-deploy` reads the resulting assignments back from their exact
resource scopes and fails if any principal, role, or scope does not match.
Broader inherited grants do not satisfy this least-privilege contract.

The ordinary operator then runs `deploy`. It performs the same live read-back
before schema publication, so copying state or merely claiming that the RBAC
deployment ran cannot bypass the gate. Neither command persists credentials or
records an RBAC-success stage.

## Deployment commands

```powershell
npm run azure -- validate sql-apps.json
npm run azure -- artifacts sql-apps.json
npm run azure -- plan sql-apps.json
npm run azure -- provision sql-apps.json
npm run azure -- rbac-plan sql-apps.json
npm run azure -- rbac-deploy sql-apps.json
npm run azure -- deploy sql-apps.json
npm run azure -- status sql-apps.json
npm run azure -- schema sql-apps.json
npm run azure -- grants sql-apps.json
npm run azure -- redirect sql-apps.json
npm run azure -- role-based-assign sql-apps.json <user-or-group-object-id>
npm run azure -- role-based-smoke sql-apps.json
```

Preflight checks cloud/tenant, Bicep/SqlPackage availability, registration shape, registry existence, availability of both images (and matching digests where specified), and required registered resource providers. It does not prove all resource/Graph permissions, SKU availability, network reachability, or quota. ARM/Graph/SqlPackage failures remain explicit.

`schema` republishes only the DACPAC and procedure grants against the deployed database; destructive changes remain blocked. `redirect` re-adds the exact SPA callback on the deployed gateway origin without removing existing redirects.

Deployment sequence:

1. Provision/update infrastructure and durable identities without starting new data/gateway apps.
2. Verify the ACR pull assignments, then publish the DACPAC with `BlockOnPossibleDataLoss=True` and `DropObjectsNotInSource=False`, granting the DAB identity only the authorized procedure permissions.
3. Deploy data and gateway apps.
4. Add the exact HTTPS SPA callback at `/auth/redirect.html` on the actual gateway origin, preserving existing redirect URIs.
5. Probe data-service readiness through the gateway.

Local state is keyed by subscription/group/app/environment under `.sql-apps`. A local exclusive lock prevents simultaneous commands from this checkout. CI must also use an environment concurrency group.

Readiness checks do not authenticate a user or exercise domain operations. Set `SQL_APPS_USER_TOKEN` to a delegated access token for a user with the required role and `SQL_APPS_SECOND_USER_TOKEN` to one for a user without it, then run `role-based-smoke`. It checks real authorized procedure execution, denial for the user without the role, anonymous denial and rejection of caller-forged role headers. It does not create domain records and never persists tokens. Obtain tokens through your approved sign-in tooling; do not put them in the configuration file or shell history.

## Live acceptance

Use two distinct Entra workforce users, one with the required role and one without:

1. Sign in as the authorized user and create/update an application-specific record; reload to confirm persistence. Test direct REST and GraphQL operations where the app exposes them. `role-based-smoke` is not a substitute for domain-specific database acceptance.
2. Sign in as the user without the role. `/auth/me` must report access not allowed, and domain requests must return HTTP 403. Where the app has owner rules, confirm one authorized user cannot read or change another's rows.
3. Reject missing, expired, wrong-audience, and wrong-tenant tokens. Confirm logout clears the browser account state.
4. Redeploy without changes; resource IDs and rows must remain. Test an additive schema change and a destructive change blocked by SqlPackage.
5. Test dependency outage/readiness, runtime replica replacement, and role propagation. Record exact commands/results, not just screenshots.
6. Run DAB's full configuration/database validation in the private environment. JSON schema validation alone is insufficient.

No live acceptance is implied by `npm test`; its Azure/DAB dependencies are controlled test doubles.

## Browser sign-in contract

Follow **Build -> Sign in -> Give access -> Publish** and the [canonical authentication reference](authentication.md). The dedicated MSAL v5 bridge is `/auth/redirect.html`, not the application root. Register the exact HTTPS callback on the actual deployed gateway origin, including its path, before accepting a new browser build with an existing registration. Preserve previously approved redirect URIs. The bridge runs only its redirect script, makes no application API calls and must not receive a `Cross-Origin-Opener-Policy` header.

Public browser configuration exposes only the minimal sign-in settings, never tokens or service secrets. The gateway verifies signature, issuer, audience, expiry, tenant, `oid` and the delegated `access_as_user` scope. Required human application roles come from verified token claims, not caller headers. Verify approved role assignments, DAB procedure permissions, SQL grants and any `oid`/`tid` owner restrictions end to end.

`/auth/me` reports HTTP 200 verified identity and access even for an account without the required role; its domain requests receive HTTP 403 before DAB. An access-denied account can still sign out. HTTP 401 clears owner-specific browser data and stops authenticated requests; HTTP 403 is an operation denial, not logout. A backend outage remains a separate retryable failure and keeps the authorized account signed in.

Container Apps is the current supported hosting implementation. This authentication change does not provision a Static Web App, migrate hosting or implement the preferred future App Service target. EasyAuth and Static Web Apps client-principal headers are not an adapter shortcut for this verified delegated-token contract, and their roles do not grant SQL access. Hosting alternatives require a separate integration, networking/identity/readiness/cost review, deployment and rollback plan, and approval.
