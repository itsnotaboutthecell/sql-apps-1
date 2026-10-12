# Authenticated Azure deployment reference

Use this reference when deploying an authenticated application with the full Azure infrastructure template. Start with [sharing your app](../guides/sharing.md) to choose the appropriate path. For an existing pre-rebrand deployment, review [migration notes](../maintainers/naming-transition.md) first.

## Profile and deployment subject

The default authenticated foundation path includes Functions, storage, Key Vault and private networking. The explicit [role-based-data profile](role-based-data.md) uses the same orchestration with two images, human application roles and private SQL, excluding file/job services. Do not add excluded services or use an anonymous demo without an agreed scope change. `demo-cost` remains demo-only; use `role-based-cost` for role-based-data and review actual regional/account prices separately.

Keep the confirmed new application checkout/configuration/artifacts as the deployment subject. With read-only Azure authorization, discovered older resources are potential collisions, not permission to reuse or modify them. Reuse requires an explicit request and a separate compatibility/migration/cost review; existing data remains untouched.

## Supported tools

The project uses Azure CLI/Bicep for infrastructure and Microsoft.Build.Sql/SqlPackage for schema publishing. No custom Azure control-plane client or SQL migration engine is implemented.

Run the validation commands in [Contributing](../../CONTRIBUTING.md) first. Sign into the correct tenant using `az login`; CI uses Azure Login federation. All resource commands specify the configured subscription instead of changing your global default subscription.

The runtime uses stateless bearer tokens. User tokens must be v2 access tokens for the configured API, with the `access_as_user` scope. Functions require an application token with `Function.Invoke` and the exact gateway managed-identity principal. No caller-supplied identity headers are trusted.

`DAB_URL`, `FUNCTIONS_URL` and `BLOB_ACCOUNT_URL` must be exact HTTPS origins without embedded credentials, paths, queries or fragments. Runtime validation fails before startup rather than forwarding a bearer token to an insecure or ambiguous endpoint.

DAB returns relative REST continuation links so clients remain on the public gateway origin. The isolated Todo example tests pagination, preserving opaque tokens and rejecting unsafe links; it is not part of application delivery. Application-specific clients need equivalent pagination validation.

Develop and verify the SQL/data layer first using [local development](local-development.md), without provisioning cloud resources. Local claim simulation must never be deployed; cloud DAB continues to validate Entra bearer tokens.

The default cloud DAB identity gets table-scoped read and `VIEW DEFINITION` for owner-filtered FileJob reads, with private snapshot keys excluded. The local processor uses separately gated CRUD; shared SQL filter/block predicates enforce ownership independently of any Todo sample. Cloud job production remains future work. Real applications must define domain-specific entities/grants and acceptance; use update-only PATCH with `If-Match: *` where required rather than implicit upsert.

## Resource group and images

Use a dedicated resource group. Create it and an ACR using standard Azure CLI commands after reviewing your subscription and region:

```powershell
az group create --subscription <subscription-id> --name <resource-group> --location <region>
az acr create --subscription <subscription-id> --resource-group <resource-group> --name <registry-name> --sku Basic --admin-enabled false
```

All three image references must use an explicit version tag or digest. After filling in the configuration, build from the repository root:

```powershell
npm run azure -- artifacts sql-apps.json
```

`artifacts` invokes ACR builds for all three services using distinct configured version tags, resolves each result to its digest, then atomically updates your configuration only after every build succeeds. If a build fails, earlier images may exist in ACR but configuration remains unchanged. Use new version tags for each build; do not overwrite release tags. This command publishes your source to your configured Azure registry, and requires ACR build/push/read permissions.

Alternatively use the underlying standard Azure CLI commands:

```powershell
az acr build --subscription <subscription-id> --registry <registry-name> --image sql-apps:0.1.1 --file Dockerfile .
az acr build --subscription <subscription-id> --registry <registry-name> --image sql-apps-dab:0.1.1 --file dab/Dockerfile .
az acr build --subscription <subscription-id> --registry <registry-name> --image sql-apps-functions:0.1.1 --file functions/Dockerfile .
```

ACR tasks require suitable Azure permissions and may have region/subscription restrictions. Images are not built by `deploy`. Use immutable digests for release, not tags that are overwritten. Publishing code to a registry is an explicit operator action.

## Shortest path

After `az login` as the person who will administer SQL, generate a configuration
read-only; tenant, subscription, SQL administrator and (for `role-based-data`)
role settings are derived, so only placement is asked for:

```powershell
npm run azure -- init sql-apps.json --profile foundation --location eastus --resource-group rg-sql-apps-dev --registry <name>.azurecr.io
npm run azure -- deploy-all sql-apps.json
```

`deploy-all` without `--approve` only lists the pending paid steps (`identity`,
`artifacts`, `provision`, `deploy`, `status`), the exclusions and an id. Review
costs (`demo-cost`/`role-based-cost`) and those steps, then, after explicit
approval, run `deploy-all sql-apps.json --approve <id>`. It runs the existing
commands below in order, skips completed ones and refuses a stale id. On a
failure, such as no private-network path to SQL before `deploy`, fix the cause
and rerun it to resume. Role assignment and smoke tests stay separate.

Completed stages are skipped only when their saved fingerprint still matches
the configuration and, for `role-based-data`, the SQL/DAB source. Changed image
digests or role-based schema inputs stop `deploy-all` before any child command.
Review that release change separately; do not delete saved state to force a
resume or treat an old healthy gateway as the changed release.

## Entra configuration

Copy [the example](../../sql-apps.example.json) to `sql-apps.json`, or use `init` above. Fill in the target tenant/subscription, SQL administrator, resource group/region, and images.

The starter uses `"name": "sqlapps"`. With environment `dev`, the gateway's Azure-generated hostname starts with `sqlapps-dev-gateway.`; the Functions hostname starts with `sqlapps-dev-fn-`. Azure supplies the remaining domain/suffix, so use the actual deployment outputs rather than constructing a URL yourself. Image repository names can remain `sql-apps`; they do not determine the browser URL.

An existing configuration with a different `name` still selects resources using that prefix. Review it before deployment. Changing the name creates/selects a different resource set and does not rename or migrate an existing app, database or URL. Preserve existing data and review Entra redirects and dependent endpoints before a separate migration.

Create a dedicated app registration once:

```powershell
npm run azure -- identity sql-apps.json
```

This is an explicit create operation, not an idempotent lookup by display name. It creates one single-tenant SPA/API registration, a delegated `access_as_user` scope, a `Function.Invoke` application role, and a service principal. When the configuration came from `init` (placeholder `apiClientId`), the printed ID is saved into it; otherwise replace `apiClientId` in your real configuration with the printed ID.

For a `role-based-data` configuration, `identity` instead creates the configured human role such as `AppUser` with allowed member type `User`; `role-based-assign` explicitly assigns approved users/groups. Verify API access-token role claims, trusted gateway-selected DAB role, entity/procedure permissions and SQL grants end to end with `role-based-smoke` and browser acceptance. Local simulation and app-side role enforcement alone do not prove Entra/cloud authorization.

An account email address is not a tenant ID. Confirm the intended directory's tenant ID, or retrieve it with an authorized read-only account query, before tenant-specific sign-in. Do not change subscription defaults or repeat generic login instructions to resolve that mismatch.

The registration requests v2 access tokens. The same registration is used by the browser and API. Deployment adds the exact HTTPS `/auth/redirect.html` callback on the actual gateway origin without removing existing redirects. Real local sign-in uses a separately reviewed development registration and the printed loopback callback; see [Authentication and application access](authentication.md). An Entra administrator may need to grant consent under your tenant's policy.

Alternatively configure an existing dedicated registration with the same scope and application role:

- Delegated scope ID: `6bb296dd-f397-4dcc-a69b-d37dfce3c555`, value `access_as_user`.
- Application role ID: `15d91b1c-83c7-4cb6-b349-d7b8fd4b1425`, value `Function.Invoke`, allowed member type `Application`.
- Identifier URI: `api://<apiClientId>`.
- Sign-in audience: `AzureADMyOrg`; requested access-token version: `2`.

The deployment operator needs directory rights to update redirects and grant that application role to the gateway managed identity. Graph permissions and Azure resource RBAC are separate.

## Private-network SQL deployment

The Bicep template disables SQL's public endpoint and provisions a private endpoint. Run full deployment on a machine/runner that can reach the new VNet through peering/VPN or another approved network path. The `networkId` deployment output identifies it. The default network range is `10.42.0.0/16`; review conflicts before deployment.

The configured `sqlAdminObjectId` must identify your migration principal or an Entra group containing it. The CLI obtains a SQL access token using Azure CLI for the configured subscription and passes it to SqlPackage without saving it. Check the selected SQL identity explicitly; Azure resource permissions do not automatically authorize database schema publishing. Error output is redacted for this token. As with SqlPackage's standard access-token interface, the deployment host must be trusted because privileged local processes can inspect process arguments.

No public SQL firewall exception is added to make migrations pass. Use `provision` to create the infrastructure and obtain its network ID before connecting a runner. If full deployment's SQL publishing fails, infrastructure stage state is retained, and deployment stops before gateway/data rollout. Restore private connectivity and retry.

## Deployment commands

```powershell
npm run azure -- validate sql-apps.json
npm run azure -- artifacts sql-apps.json
npm run azure -- plan sql-apps.json
npm run azure -- provision sql-apps.json
npm run azure -- deploy sql-apps.json
npm run azure -- status sql-apps.json
npm run azure -- schema sql-apps.json
npm run azure -- smoke sql-apps.json
npm run azure -- gateway sql-apps.json
npm run azure -- functions sql-apps.json
npm run azure -- static sql-apps.json
npm run azure -- secret-set sql-apps.json example-secret
```

Preflight checks cloud/tenant, Bicep/SqlPackage availability, registration shape, registry existence, availability of all three images (and matching digests where specified), and required registered resource providers. Static-only builds skip the prebuilt-image check because their output does not exist yet. It does not prove all resource/Graph permissions, SKU availability, network reachability, or quota. ARM/Graph/SqlPackage failures remain explicit.

`gateway` and `functions` update only the selected service to its configured prebuilt image; they do not build images or publish SQL. Verify readiness and authenticated smoke afterward.

`static` requires the currently deployed gateway image to be an immutable ACR digest and `gatewayImage` in configuration to specify a new version tag. It builds frontend assets with esbuild, layers only `public/` onto that existing runtime digest using an ACR build, resolves the result to a digest, and updates the gateway with that digest. It then atomically updates the configuration's gateway image. It does not rebuild backend code or publish SQL.

`secret-set` reads `SQL_APPS_SECRET_VALUE` from the trusted deployment process. Never place a secret value in the configuration or command history. See [operations and release checks](../maintainers/operations.md) for the operator's Key Vault permissions and the server-side secret helper.

Deployment sequence:

1. Provision/update infrastructure and durable identities without starting new data/gateway apps.
2. Publish the DACPAC with `BlockOnPossibleDataLoss=True` and `DropObjectsNotInSource=False`.
3. Grant the gateway's function invocation role if absent.
4. Deploy data and gateway apps.
5. Add the exact HTTPS SPA callback at `/auth/redirect.html` on the actual gateway origin, preserving existing redirect URIs.
6. Probe data-service readiness through the gateway.

Local state is keyed by subscription/group/app/environment under `.sql-apps`. A local exclusive lock prevents simultaneous commands from this checkout. CI must also use an environment concurrency group.

Readiness checks do not authenticate a user or exercise data/files/functions. Set `SQL_APPS_USER_TOKEN` and `SQL_APPS_SECOND_USER_TOKEN` to short-lived delegated access tokens for two distinct users, then run `smoke`. For both users it reads the `FileJob` entity over REST and GraphQL through the gateway, so the gateway -> DAB -> SQL path, the database policy and the excluded `blob_key` field are all proven on the deployed environment. It then checks file roundtrip, cross-user file denial, function invocation, anonymous rejection of `/auth/me`, `/api/FileJob` and `/graphql`, and cleanup. It never persists tokens. Obtain tokens through your approved sign-in tooling; do not put them in the configuration file or shell history.

The smoke reads data but does not write it: DAB grants the foundation entity read-only, so cross-user *row* isolation under writes remains a live acceptance step below. The smoke creates uniquely named files and cleans them up on success/failure. Cleanup failures are reported, not ignored. It also checks direct private Function endpoint rejection, so run it from a trusted network-connected machine. It does not replace the other live acceptance steps below.

## Live acceptance

Use two distinct Entra workforce users:

1. Sign in as A and create/update an application-specific record. Sign in as B in another browser profile; A's row must be absent. Test direct REST and GraphQL operations as both users. The foundation's file/function smoke is not a substitute for domain-specific database acceptance.
2. Try setting/changing `owner_oid`; DAB must reject excluded fields. Test insert/update block predicates through an authorized SQL test session with `oid` and `scp` session context.
3. Upload a file as A. B requesting/deleting the same filename must not access A's file. Test overwrite and the 4 MiB limit.
4. Invoke `/functions/echo` with a user token. Call the private Function endpoint directly with that token from a network-connected test host; it must reject it. A missing/wrong application role must also fail.
5. Reject missing, expired, wrong-audience, and wrong-tenant tokens. Confirm logout clears the browser account state.
6. Redeploy without changes; resource IDs, rows, and files must remain. Test an additive schema change and a destructive change blocked by SqlPackage.
7. Test dependency outage/readiness, runtime replica replacement, and role propagation. Record exact commands/results, not just screenshots.
8. Run DAB's full configuration/database validation in the private environment. JSON schema validation alone is insufficient.

No live acceptance is implied by `npm test`; its Azure/Blob/DAB dependencies are controlled test doubles.

## Browser sign-in contract

Follow **Build -> Sign in -> Give access -> Publish** and the [canonical authentication reference](authentication.md). The dedicated MSAL v5 bridge is `/auth/redirect.html`, not the application root. Register the exact HTTPS callback on the actual deployed gateway origin, including its path, before accepting a new browser build with an existing registration. Preserve previously approved redirect URIs. The bridge runs only its redirect script, makes no application API calls and must not receive a `Cross-Origin-Opener-Policy` header.

Public browser configuration exposes only the minimal sign-in settings, never tokens, storage credentials or service secrets. The gateway verifies signature, issuer, audience, expiry, tenant, `oid` and the delegated `access_as_user` scope. Required human application roles come from verified token claims, not caller headers. Verify approved role assignments, DAB entity/procedure permissions, SQL grants and any `oid`/`tid` owner restrictions end to end.

`/auth/me` reports HTTP 200 verified identity and access even for an account without the required role; its domain requests receive HTTP 403 before DAB. An access-denied account can still sign out. HTTP 401 clears owner-specific browser data and stops authenticated requests; HTTP 403 is an operation denial, not logout. A backend outage remains a separate retryable failure and keeps the authorized account signed in.

Container Apps is the current supported hosting implementation. This authentication change does not provision a Static Web App, migrate hosting or implement the preferred future App Service target. EasyAuth and Static Web Apps client-principal headers are not an adapter shortcut for this verified delegated-token contract, and their roles do not grant SQL access. Hosting alternatives require a separate integration, networking/identity/readiness/cost review, deployment and rollback plan, and approval.
