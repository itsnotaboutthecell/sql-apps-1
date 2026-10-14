# Local runtime reference

The local inner loop uses the Azure SQL Database container (Private Preview, **EngineEdition 5**), Microsoft.Build.Sql/SqlPackage, Data API builder 2.0.12 and a loopback browser gateway. It does not use a SQL Server substitute, cloud resources, or an upstream hosted runtime.

For the shortest startup path, use [Run locally](../guides/run-locally.md). This reference covers individual commands, workspace ownership, diagnostics and recovery. If you have a pre-rebrand checkout, read [migration notes](../maintainers/naming-transition.md).

## One local profile

SQL Apps runs one profile locally and in the cloud: [role-based-data](role-based-data.md). `app` (alias `role-based-app`) starts SQL, publishes the schema, starts Data API builder (DAB) and serves the browser gateway, then checks the configured authorized readiness procedure before listening. `serve` (alias `role-based-serve`) resumes the gateway against running SQL/DAB. Both read `role-based-data.json` and the authorized stored-procedure entities in `dab/dab-config.json`. Saved brief capabilities do not turn services on or off; the brief's capabilities are always `["data"]`.

SQL Apps does not run file storage, queues, background workers or tracing. Add those with the maintained Azure skills (for example `azure-storage`, `azure-prepare` and `azure-deploy`), outside SQL Apps.

Implement domain UI/schema/procedures, configure authorized DAB permissions and verify the real SQL procedure/browser save-reload flow. The selected reference path below is anonymous synthetic-only, not a substitute for your app. The [role-based-data Azure path](role-based-data.md#identity-artifacts-and-deployment) selects matching resources while preserving private SQL.

Follow [scoped consent and readiness](../guides/run-locally.md#approvals-and-readiness). A proposed origin or successful build is not a running app. Publish the intended origin only after response/readiness probes, then report workflow acceptance separately.

Local mutations enforce [remembered permissions](local-consent.md) before dispatch, including when invoked directly. Obtain them with the single `setup approval` bundle (or individual grants from the pre-build operation plan) before the commands below. Read-only checks remain ungated; restore/build grants and existing workspace selection are reused across sessions.

## Prerequisites

First time installing development tools? Use [guided setup](../guides/getting-started.md) rather than treating this list as instructions. Copilot can offer approved installations, explain access/license conditions, guide restarts and verify each step on Windows, macOS or Linux. `node scripts/setup-check.mjs` runs before npm restore/build and never installs or mutates resources.

- Node.js 22 or 24 LTS and npm.
- .NET SDK 8 or later. The CLI restores this repository's SqlPackage tool.
- Docker with Linux containers. The SQL preview image requires x64; `start-sql` requests `linux/amd64`, including on emulated hosts.
- Access to the current preview container image, or an already running current Azure SQL container. Obtain preview access using the [official announcement](https://devblogs.microsoft.com/azure-sql/azure-sql-database-container-prpr/) and its linked instructions. This project does not distribute registry credentials or circumvent preview access.
- A free selected workspace port block. Explicit legacy compatibility uses 18080 (gateway) and 15000 (DAB).
- Initial access to download the pinned DAB image, npm packages, .NET SQL build dependencies and SqlPackage.

No Azure CLI login, subscription, Entra registration, or billable resources are required for default local preview. The explicit [real Entra sign-in opt-in](authentication.md#real-entra-sign-in-locally) requires a development registration, not an Azure deployment. First use needs package/image downloads; cached dependencies and images can be used afterward.

## Start from this checkout

Run from the repository root:

```powershell
npm ci
npm run build
npm run local -- workspace-plan
```

### Select local workspace ownership

`workspace-plan` proposes a deterministic port block from the canonical checkout path and reports conflicts plus a free alternative, without writing state or changing Docker. Within the block, the gateway uses base+0, DAB base+1 and SQL base+5; these fixed offsets keep existing isolated workspaces on their SQL port. Approve `npm run local -- workspace-init <base-port>` using the proposed block for a new isolated stack. The selected descriptor persists in `.sql-apps/workspace.json`; resource names, SQL credentials and DAB configuration are derived from the workspace ID. A descriptor copied from another checkout fails closed. Free-port observations are not reservations: startup rechecks conflicts, and bind races remain explicit failures.

For an existing legacy stack, approve `npm run local -- workspace-init legacy` instead. This preserves its names, ports (gateway 18080, DAB 15000), credential paths and volumes. Do not select isolation expecting old data to move automatically. The legacy stack remains separately available; no automatic transfer or schema cleanup is performed. `workspace-check` reports the selected mode, ports and origins.

Workspace identity uses the native resolved checkout path, including expansion of Windows 8.3 short names. Short and long aliases of the same checkout therefore select the same workspace. Existing descriptors with a different recorded home or ID still fail closed; they are not rewritten automatically because that would change resource ownership.

Isolated mode also derives a database and least-privilege SQL login from the workspace ID. Explicitly reusing the same external SQL container from two workspaces therefore does not implicitly share their application database/login. Existing legacy databases are not renamed or copied.

Local mutating commands require this explicit selection. For existing fixed-port workflows, select `workspace-init legacy` and record the applicable consent grants; agents must still confirm ownership. An external SQL container can be explicitly selected for `verify`/`init`; an isolated workspace will not stop or take ownership of it.

After selection and startup approval:

```powershell
npm run local -- app
```

`app` runs four stages and names the stage that fails: **start-sql** (start/reuse the project-owned SQL container), **init** (publish the schema and grants and run the read-only SQL acceptance check), **data** (recreate only the project-labeled DAB container) and **serve** (start the browser gateway on a single loopback origin). It stays in the foreground. Ctrl+C stops the browser gateway; SQL and DAB keep running. In preview mode, open local preview again after restarting the browser server because its sessions are held only in server memory.

After the intended server responds and `/health/ready` passes, open the URL printed by startup (**http://127.0.0.1:18080** in legacy mode) and select **Sign in**. The product signs in the simulated **Test user** and the starter page calls the configured `readinessPath` (default `/api/AppReady`) with the required role. For authorization checks, open the reported developer page in the same tab: Development Alice has the required role and Development Bob does not. Switching revokes the previous session. Reloading preserves the session within the browser tab; SQL rows persist independently of browser sessions.

For individual SQL/data steps:

```powershell
npm ci
npm run build
npm run local -- start-sql
npm run local -- init
npm run local -- data
npm run local -- serve
```

Pass the same optional SQL container name to every command when using a non-default container.

### Initial readiness and later outages

Every local gateway checks the configured readiness procedure through DAB with the required role before listening. The probe does not create business records. DAB's anonymous aggregate `/health` result is not the SQL verdict: its anonymous REST check can be Forbidden while the authorized procedure works.

`serve` reuses existing SQL/DAB and credentials; it never starts or recreates dependencies. It makes at most three read-only readiness attempts, with a four-second shared deadline per attempt and one-second pauses between failures. After listening, a separate actual HTTP readiness confirmation has a five-second caller timeout. Initial failure closes the new gateway, names the failed dependency and publishes no ready URL. These checks are not service-repair loops.

An already-running gateway stays reachable during a later outage: `/health/live` remains HTTP 200 and `/health/ready` returns HTTP 503 with `status: not-ready` and the safe `data` dependency identifier. Operation failures remain explicit. The next successful readiness probe recovers in place without a gateway restart.

Read the named failure and inspect the affected dependency before separately approved recovery. Do not use full `app` startup as a read-only diagnostic: it recreates the owned DAB container. Setup also blocks a matching but unready gateway rather than replacing it or claiming a successful launch.

With the browser server running, use a second terminal:

```powershell
npm run local -- app-test
```

`app-test` obtains separate server-issued sessions for both development users, checks identity lookup, expects HTTP 200 from the readiness path for the user with the required role and HTTP 403 for the user without it, rejects anonymous access, and removes its sessions.

## Explicitly selected synthetic reference

The default commands above run your application. An opt-in selected application uses the same workspace/source checks but a separate application database/login/configuration and route composition. It requires isolated mode; do not overwrite a legacy descriptor or transfer legacy data implicitly.

After explicit reference selection and download/EULA/schema approval:

```powershell
npm run app:build -- todo local-simulation
npm run local -- selected-app "<artifact-directory>"
```

Use the exact artifact directory printed by the builder. Startup rechecks source/checksums and occupied gateway/DAB/SQL ports, verifies owned resources, uses existing .NET/SqlPackage publishing without dropping unrelated objects, and probes the actual execute-only SQL login and procedure. It starts only SQL, selected DAB and the browser/API; no cloud registration is required. The selected browser uses anonymous synthetic-data sessions, not the default development identities.

After Ctrl+C, `selected-serve "<artifact-directory>"` resumes with verified services and SQL-backed sessions. `selected-stop todo` removes only this selection's verified DAB container, preserving SQL data and protected credentials. To recreate that DAB service, use `selected-app` again. Configuration mismatch or existing SQL objects without credential state is an explicit review/repair boundary, never permission to reset credentials or data.

With separate synthetic-test approval, use `selected-test "<artifact-directory>"` against the already-running app. Its opt-in SQL/HTTP suite measures ownership, exact concurrent quotas/rate limits, title boundaries, expiry, bounded cleanup and permissions. It changes clocks only for its new synthetic sessions and removes those fixtures on success or failure. Run it without concurrent activity in an approved disposable workspace; it does not restart services or replace browser acceptance.

See [the reference guide](../../examples/todo/README.md). Local acceptance is not cloud-managed-identity or Azure deployment proof.

### Development identity boundary

The product uses **Sign in** and **Sign out**, not persona selectors, and labels the default fixed simulated identity as **Test user**. The server issues an unpredictable 43-character opaque bearer token. Authorization testing uses the separate local-only developer page, `/__dev/identity`, in the same tab. Its fixed Development Alice/Bob test identities are labeled as having or lacking the required role; switching invalidates the previous session. Sessions expire after eight hours, are limited to 1,000 active sessions and are revoked on switch or **Sign out**.

A signed-in user without the required role receives HTTP 403 from the gateway for `/api/*` and `/graphql`. `/auth/me` still returns the identity with `access: { allowed, requiredRole }`, so the app can show an access-denied state.

The browser never supplies object IDs to the data proxy. The gateway validates the issued preview session or, in explicit local Entra mode, a real delegated access token, strips incoming identity/role headers and creates the trusted local DAB principal server-side. Local DAB remains claim simulation even with real local Entra sign-in; that does not prove cloud DAB identity or Azure service permissions.

The local server binds only to `127.0.0.1`, requires the exact development Host, and requires the same Origin on mutations, including session creation. It refuses `NODE_ENV=production`. The developer page/script, `/local/users` and `/local/session` exist only in preview mode, not local Entra mode or production. Production requires verified Entra access tokens. Preview users are not real authenticated people, and local sessions are not a security boundary against other processes on your machine. Never expose the local stack remotely.

See [Authentication and application access](authentication.md) for `SQL_APPS_LOCAL_AUTH=entra`, the UUID tenant/client settings, the exact printed `/auth/redirect.html` callback and the separately approved development registration. Invalid Entra configuration or sign-in failure never falls back to simulation. Setup matches authentication mode, tenant and client in addition to ownership and source fingerprint; changing them requires stopping only the intended gateway and restarting with the reviewed configuration, not resetting data or replacing another process.

Do not deploy the local generated DAB configuration to Azure.

## SQL container and schema

`start-sql` creates `sql-apps-sql` using the current canonical `azure-sql/db-dev:latest` preview image. It generates a bootstrap password without printing it, publishes SQL only to a loopback port (the workspace SQL port in isolated mode, a randomly allocated port in legacy mode), and stores data in the `sql-apps-sql-data` named volume. Subsequent runs restart the same project-labeled container instead of replacing it. Docker may use its cached `latest` image; refreshing/upgrading is an explicit operator action, not an automatic destructive upgrade.

Readiness includes a fresh completion marker from the current preview image's control-plane initialization, not just an early `SELECT 1`. A measured preview recovery race (error 904 during control-plane reconciliation) receives at most three explicitly logged restart attempts; other failures are not silently reset. An exhausted reconcile failure is reported as preview control-plane recovery, not proof that registry access was revoked. The existing volume is preserved.

If a stopped **isolated, workspace-owned** SQL container repeatedly exits during reconciliation, review its bounded logs and obtain approval before `npm run local -- recover-sql`. This recreates only that stopped container, with the same image version, administrator credential, published port and labeled data volume/network. It refuses running, external, legacy or mismatched resources and a changed image tag. The normal `start-sql` command never does this implicitly.

Recovery records the original credential in an atomic, gitignored workspace recovery file before removing the stopped container. Treat local state as sensitive. Successful readiness removes that temporary record. If Docker creation or startup fails, the record remains; explicitly rerun `recover-sql` to resume rather than deleting state, resetting passwords or using ordinary startup to generate a replacement credential. The command does not publish schema or claim application readiness; resume `app` after SQL recovery to refresh the DAB connection.

Live two-workspace testing observed this failure on the already-current preview image and verified that explicit container recreation preserved SQL rows. A pull is not necessarily a fix: confirm the actual image changed, and do not compare a registry manifest's config digest with a different image-store identifier to infer a newer release. No image refresh or recreation of other running stacks is automatic.

`init` verifies the engine, creates the workspace database, builds/publishes the shared DACPAC, creates the mapped least-privilege application login/user, grants only `EXECUTE` and object-scoped `VIEW DEFINITION` on the authorized DAB procedures, and runs the read-only SQL acceptance check as that user (no `db_owner`, `CONTROL`, `db_datareader` or `db_datawriter`). SA is used only for provisioning, not the application. Publication blocks possible data loss and does not drop unspecified objects.

`data` reapplies the procedure grants, writes a separate development DAB configuration, and restarts only the project-labeled DAB container (**http://127.0.0.1:15000** in legacy mode). It does not rerun SQL acceptance; use `npm run local -- test` for that. SQL and DAB communicate on the SQL container's Docker network, not through a Docker Desktop-specific hostname. Restart `data` after restarting/recreating SQL, because its container IP may change.

After changing schema, DAB configuration, `role-based-data.json` or code:

```powershell
npm run build
npm run local -- init
npm run local -- data
npm run local -- serve
npm test
```

Repeated `init` preserves existing rows. Repeated `data` recreates only the project-labeled DAB container and reloads current configuration; it does not delete SQL data.

## Reuse an existing SQL container

```powershell
npm run local -- verify sqldbdev
npm run local -- init sqldbdev
npm run local -- data sqldbdev
npm run local -- serve sqldbdev
```

The existing container needs a published host SQL port, a Docker bridge network, the bundled `/opt/mssql-tools18/bin/sqlcmd`, and its bootstrap `MSSQL_SA_PASSWORD` environment setting. Initialization reads that credential in memory for schema publication; it does not print it or save it in project state. Run this only on a trusted developer machine, because privileged local processes can inspect Docker environment and SqlPackage arguments.

Do not run `start-sql sqldbdev` to take ownership of someone else's container: it deliberately refuses unowned names. This workflow does not stop/recreate your existing SQL container or alter its port bindings. If it is published on all interfaces, restrict it yourself before using it on an untrusted network.

Some older preview images report EngineEdition 5 but reject `CREATE USER ... FOR LOGIN`. The current canonical image supports this project's mapped app identity. Use a separate current container rather than granting the runtime SA permissions:

```powershell
npm run local -- start-sql sql-apps-sql-current
npm run local -- init sql-apps-sql-current
npm run local -- data sql-apps-sql-current
npm run local -- serve sql-apps-sql-current
```

Legacy mode supports only one DAB instance on port 15000. Separate isolated checkouts use their own port blocks and resources. Within one workspace, switching the selected SQL container still requires review of its downstream data/service resources; never stop another workspace to free a port.

## Interactive REST and GraphQL

Local DAB uses documented [EasyAuth claim simulation](https://learn.microsoft.com/en-us/azure/data-api-builder/concept/security/authenticate-easy-auth), not actual Entra authentication. The local gateway validates an issued opaque session in default preview mode or a verified delegated token in opt-in Entra mode; the production gateway requires verified Entra tokens. Both reject caller-supplied principal headers. Real browser sign-in locally does not replace the local DAB simulation or establish cloud backend permissions; see the [authentication boundaries](authentication.md#three-distinct-boundaries).

Example calling the readiness procedure on DAB directly with the local-only helper (replace `AppUser` and `/api/AppReady` with the values in `role-based-data.json`):

```powershell
@'
import { localPrincipal, localOrigin } from './dist/src/local.js';
const role = 'AppUser';
const headers = {
  'x-ms-client-principal': localPrincipal('11111111-1111-4111-8111-111111111111', 'access_as_user', role),
  'x-ms-api-role': role,
};
const rest = await fetch(`${localOrigin}/api/AppReady`, { headers });
if (!rest.ok) throw new Error(`REST failed: ${rest.status}`);
console.log(await rest.json());
'@ | node --input-type=module -
```

Change the role to exercise denial. Claims can be forged locally by design: never expose this endpoint remotely or deploy its generated configuration.

The Todo sample is not a default entity, browser feature or runtime dependency. See [application boundaries](../maintainers/application-boundary.md) for source/build/model, authenticated API and read-only database checks. `npm run local -- app-check` inspects legacy sample objects without dropping data. Existing sample data is retained deliberately by schema publication and causes the database check to fail until a reviewed cleanup is explicitly approved.

## Lifecycle and secrets

```powershell
npm run local -- stop
npm run local -- data
```

`stop` removes only the project-labeled DAB container; `data` recreates it. To stop project-created SQL separately, use Docker's standard `docker stop sql-apps-sql`. Restart with `start-sql`, then `data`. Stopping/removing containers does not delete named data volumes. Never remove volumes unless you intentionally want to discard data.

Gitignored `.sql-apps` holds per-container SQL credentials and generated local DAB configuration. Preserve credentials alongside their persistent volumes and protect them as secrets. Lost/mismatched credentials fail explicitly; the CLI does not silently reset an existing login. Bootstrap secrets remain in Docker configuration, not repository files. Do not check in state files or share Docker inspections.

Ownership labels prevent accidental replacement/removal of unrelated containers. Isolated lifecycle checks also verify workspace labels, expected image/provenance shape and loopback published ports before modifying containers; SQL volumes and networks have workspace ownership labels. An unlabeled or mismatched container occupying a project name produces an actionable error rather than being deleted.

## What is and is not verified

This is a usable **frontend/gateway/SQL/DAB learning workflow**, not a complete emulation of Azure. Role-authorized procedure access, least-privilege SQL grants and the readiness check are tested locally. First-time package/image/tool downloads need internet, as do changed dependencies that are not already cached.

Browser Entra sign-in can be tested through the explicit local opt-in, but cloud sign-in, managed identity, private endpoints and cloud recovery still require Azure acceptance. Local SQL login/EasyAuth secrets are intentionally separate from cloud Entra/managed-identity configuration. The SQL preview is not a production database or backup service; see the [current known limitations](https://microsoft.github.io/azure-sql-database-container/known-limitations.html).

No Azure free allowance is needed to start locally. The role-based-data cloud
deployment uses free-limit serverless SQL, scale-to-zero Container Apps and
capped logs, but ACR, one SQL private endpoint and managed network
infrastructure can still charge. Do not deploy expecting a guaranteed zero bill.
