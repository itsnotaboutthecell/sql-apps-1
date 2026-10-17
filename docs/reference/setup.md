# Setup coordinator

One project-owned journey connects **check -> review -> install -> restore ->
build -> workspace -> launch -> verify**. No executable or additional desktop
UI is required. Your assistant can drive it through the existing plugin; direct
commands work without an assistant.

The coordinator requires Node 22 or 24 but no application build. The installed
plugin can bootstrap an unrestored project through its explicit foundation binding.
If Node is missing, the assistant must first inspect the OS/CPU and obtain
approval for an official compatible Node installer. A Node script cannot
bootstrap its own missing runtime. Preserve existing version managers.

Generated-project prerequisite checks use the validated project context and
Node package resolution, including dependencies hoisted beside the installed
tooling package. A CLI dependency is checked through its declared executable;
subpath-only exports do not require a root library export. These checks do not
prove the pinned tooling version is available from the configured npm feed.
Release acceptance still requires a clean independent generated project to
install that exact version from its intended feed. A local tarball or vendored
binary is development evidence, not a substitute for that install check.

## Plan before changes

From the intended application checkout:

```powershell
npm run setup -- plan --json
```

This npm command requires the pinned tooling package to be restored.
Before restore, use the installed launcher's `setup plan --json`, using its absolute
script path and explicitly selected runtime checkout. `--profile role-based-data`
is optional: it is the default and the only local profile.

Only the foundation checkout contains `scripts/setup.mjs`. Generated projects
use package-backed commands, not copied coordinator scripts. Bootstrap `setup run`
stops after restoring dependencies. Re-enter `setup plan` through the installed
pinned tooling, review its current approval id, then continue. Foundation and
package implementation fingerprints differ, so bootstrap approval must not
silently authorize the newly installed implementation. With tooling already
installed, the normal single setup approval still covers unchanged local stages.

The `role-based-data` profile runs the configured domain SQL/DAB/browser
application. Implement its role-based procedures, readiness configuration and
screens first. `setup plan` reports `ROLE_BASED_CONFIG_MISSING`,
`ROLE_BASED_CONFIG_INVALID`, `ROLE_BASED_DAB_INVALID` (for example an older
`FileJob` entity is still in `dab/dab-config.json`) or
`ROLE_BASED_PROCEDURE_MISSING` (a DAB procedure has no `CREATE PROCEDURE` under
`sql/`) and blocks only the launch stage until `role-based-data.json` (copied
from `role-based-data.example.json`), the DAB procedure entities and their SQL
declarations are valid; restore and build can proceed meanwhile.

It does not generate an app. Explicitly selected examples retain their
documented separate workflow. A saved brief is not an automatic service
selector. File storage or background jobs are outside SQL Apps; add them with
the maintained Azure skills.

`plan` and `status` are read-only and re-probe current state. Their version-1
journey report is separate from the existing prerequisite diagnostic contract.
It separates:

- tool/access checks, with missing versus unsupported or failing installed tools;
- resolved locked npm packages, offline npm dependency-tree validation and actual SqlPackage version;
- source/artifact build provenance;
- explicit workspace selection and startup scopes/terms;
- intended gateway/profile identity and readiness of every included dependency;
- browser/SQL workflow acceptance, which is never inferred from HTTP health.

Human output prints `Done: <stage>` for completed stages and, for blocked or
next stages, the reason code, failing checks and the approval scopes that are
still needed. The workspace stage names the proposed isolated port block before
any build, so `workspace-plan` is not required first. A cold dependency probe
that times out twice reports `NPM_TREE_PROBE_TIMEOUT` or
`SQL_TOOL_PROBE_TIMEOUT` and blocks restore; rerun `setup plan` rather than
treating it as a missing dependency.

Before workspace initialization, prerequisite port checks use the explicit
`--workspace <base-port|legacy>` selection or the proposed isolated block.
An unrelated gateway on legacy ports does not block a free isolated workspace.
The raw diagnostic accepts the same `--workspace` flag for read-only checks;
neither command records a workspace selection or reserves those ports.

A proposed workspace origin is not a usable launch URL. `launchUrl` is returned
only after `/local/workspace` matches the checkout-derived workspace, origins,
selected profile, SQL container and running build's source fingerprint, and
`/health/ready` succeeds. Older gateways without this identity evidence require
inspection/restart, not silent adoption.

The additive `gatewayReachable` field means the complete intended identity was
verified, not that dependencies are healthy. A matching but unready gateway has
`gatewayReachable: true`, `running: false`, a `WORKSPACE_NOT_READY` launch blocker
and no `launchUrl`. Human output prints neither `Running:` nor `Done: launch`.
Only the known dependency name `data` is reported;
HTTP success with malformed or contradictory health JSON is not readiness.
Setup does not restore, build or automatically relaunch this responding gateway.
Inspect the named dependency and review its recovery permission separately.

## Install only missing tools

```powershell
npm run setup -- install-plan dotnet
```

Tools are `node`, `npm`, `dotnet`, `docker` and `sql-express`. Azure CLI is
conditional on the Azure SQL route, not a prerequisite for container or Express.
GitHub CLI and app publishing are not required.

## Choose a database without blocking the journey

The preference order is **Azure SQL Database container -> Azure SQL Database
directly -> SQL Server 2025 Express**. Missing Docker, preview access or emulation
offers an alternative; it never silently changes an existing database. Read
`sqlRoutes` in `setup plan --json`, discuss access/cost/data policy, and explicitly
select a target. Unknown probe failures need diagnosis, not automatic failover.
Independent app/scaffold/build work can continue while persistence is blocked.

Save a nonsecret target JSON outside tracked source. For Express on supported
Windows x64:

```json
{
  "version": 1,
  "provider": "express",
  "instance": "SQLEXPRESS",
  "server": "127.0.0.1",
  "port": 1433,
  "database": "my_app_development"
}
```

For an existing, explicitly selected Azure development database:

```json
{
  "version": 1,
  "provider": "azure",
  "server": "your-server.database.windows.net",
  "database": "my_app_development",
  "subscriptionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "tenantId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "resourceGroup": "your-development-group"
}
```

Use the same selection for planning and approval:

```powershell
npm run setup -- plan --sql-provider express --sql-target "C:\path\express-target.json" --json
npm run setup -- approval --sql-provider express --sql-target "C:\path\express-target.json"
# Only after approving the displayed effects, run its printed approve command.
npm run setup -- run --json
```

Only matching approval saves `.sql-apps/sql-target.json`. The selection is sticky
on resume, even if a preferred route later becomes available. A target change
requires a new review; it never moves data or resets credentials. Stop the
previous owned data service before changing targets. Never call a new empty
database the user's previous data.

Both endpoint routes run pinned **DAB 2.0.12 as a host process**, without Docker
or registry credentials. They require both `Microsoft.NETCore.App` 8.0 and
`Microsoft.AspNetCore.App` 8.0 in `dotnet --list-runtimes`; a newer SDK alone
does not supply these runtimes. Setup checks both and offers
`setup install-plan dotnet` for separately approved side-by-side SDK 8
installation, preserving newer SDKs. A failed or unrecognized runtime probe
requires diagnosis, not installation.
Approve the SQL target selection first so the installation planner checks
the saved endpoint route; target approval does not authorize installing SDKs.
The services grant covers restoring its local NuGet tool
if absent. Gateway/DAB remain loopback-only; endpoint workspaces do not reserve a
container SQL port. SQL runtime uses a separate contained app user, not SA or the
bootstrap administrator. Windows secrets use current-user DPAPI; other hosts use
restricted files. Cloud TLS validates the certificate; Express trusts its local
certificate. SQL Azure and SQL Server 2025 schemas build separately with their
correct target platforms and non-destructive publish protections.
Host DAB liveness uses its public root endpoint, not the role-protected
comprehensive `/health` report. Gateway readiness still executes the configured
application procedure; liveness alone is not database readiness.

### Last resort: install or configure Express

Read-only inspection distinguishes registry presence from SQL identity readiness.
Choose among existing instances explicitly. Older, broken or unverifiable
instances are diagnosed, never upgraded or overwritten.

`setup install-plan sql-express` reviews the pinned Microsoft SQL Server 2025
Express bootstrapper, SHA-256/signature verification, unattended arguments,
downloads, SQL license/privacy acceptance and administrator/disk/service effects.
After explicit acceptance, execute the unchanged saved plan with `setup install`.
No WinGet prerequisite, self-elevation, firewall exception or automatic reboot.
Exit 3010 means **restart required**, not ready. Failed/canceled/timed-out installs
require inspection and fresh review before retrying.

Existing-instance changes are **not** part of installation or app startup.
After selecting the target, review `consent plan configure-express`, approve it
with `grant --once`, then run `local configure-express`. This separately enables
contained authentication, selects loopback-only static TCP and restarts that
instance; it affects every database there. Use an already-approved administrator
terminal. Startup creates a new partially contained app database if missing,
but refuses to change an existing database's containment automatically.
Password-based contained users also require mixed-mode SQL authentication.
If inspection reports Windows-only or unknown authentication, separately review
`consent plan configure-express-auth`, approve with `grant --once`, then run
`local configure-express-auth` from an approved administrator terminal.
This enables mixed mode and restarts only that instance; it changes authentication
policy for every database there. It does not enable/reset SA, create a
server-level app login or change firewall rules. Ordinary startup and
`configure-express` never change authentication mode.
Database preflight failures retain these configuration recovery instructions;
credential-bearing SQL command output remains suppressed.
Administrative queries and schema publication use local shared memory with
Windows authentication, avoiding loopback TCP Kerberos/SPN dependencies.
Publication preserves the reviewed database options, including partial
containment. Only the contained runtime user connects over loopback TCP.

### Azure SQL without publishing the application

Use the [official Azure CLI installation instructions](https://learn.microsoft.com/cli/azure/install-azure-cli)
only after separate approval if the CLI is missing; sign in and select the
intended subscription/tenant explicitly in your own terminal. Planning never
starts login. Bootstrap needs schema/user-management permissions on the selected
development database. The local app does not use those administrative credentials.

For a new server/database, `setup azure-plan <absolute-request.json>` accepts:
`version: 1`, the Azure `target` above, `location`, `administratorObjectId`,
`administratorName`, exact IPv4 `clientIp`, `createResourceGroup` (boolean), and
`cost: "free-only"`. Review the returned plan before
`setup azure-provision <absolute-reviewed-plan.json>`. These commands require a
current build. Provisioning creates SQL-only resources, the named Entra
administrator and an exact-client-IP firewall rule. It requests the free offer
with `AutoPause`; eligibility/capacity are not guaranteed. Failure never becomes
paid provisioning or billable overage. There is no broad Azure-services rule,
app deployment or automatic cleanup. Protected stage receipts resume the same
deployment; existing servers without that receipt are not reconfigured.

For explicitly selected applications, the endpoint database is
`<selected-database>_<application-name-with-underscores>`. Express may create that
isolated database under schema approval. For Azure it must already exist, or be
provisioned through its own reviewed SQL-only plan. Selected startup never creates
an unreviewed cloud database.

### Endpoint lifecycle and verification limits

`app` initializes the selected database, starts owned host DAB and serves the
gateway. `serve` requires that same DAB process to be running. Ctrl+C stops the
host DAB child and gateway, preserving SQL data; use `app` to restart afterward.
Cancellation during startup also aborts its readiness probes and cleans up
the owned child.
`stop` verifies PID, creation identity, command, workspace, target and config
before stopping the owned process tree/group. It never stops Express or deletes
Azure resources. Stale same-target receipts resume only after the process has
exited and the port is free. Mismatched ownership is never repaired automatically.
Start and stop share the ownership lock. If another terminal owns it, inspect
that operation, let it finish and rerun; do not delete the lock or receipt.

Existing-instance Windows x64 acceptance has verified SQL Server 2025 Express
with host DAB 2.0.12 and no Docker: foundation-user authorization, selected Todo
limits/ownership/expiry/permissions, rendered browser create/update/save/reload,
SQL persistence after process loss, owned service reuse/stop and disposable
database cleanup. Instance changes required separate administrator approval.

Clean-machine Express installation and live Azure provisioning have not been
verified. Automated tests and schema/Bicep builds are not substitutes for those
separately approved disposable-resource checks. SQL Express is a compatibility
fallback, **not** the Azure SQL PaaS engine; cloud-only features may fail rather
than being removed or simulated.
Windows installer guard tests execute the helper's real installation function
with mocked privilege, inventory, download, signature, launch and SQL boundaries.
They cover rejected hashes/signatures, instance collisions, restart and failure
codes; no installer is downloaded or executed.

## Execute a reviewed tool installation

Review the returned host/CPU, source, exact command, effects and continuation.
Save the JSON outside tracked source. **Only after explicit human approval of
that installation**, execute its absolute plan path:

```powershell
npm run setup -- install "C:\path\to\reviewed-install-plan.json"
```

The command re-plans and rejects changed/copied plans, then consumes the plan ID
before executing. A failed/canceled attempt requires a new review; editing or
reusing the old file is not a retry authorization. Installation receipts are
ignored local replay protection, not saved global privileges or readiness.
An application-operation grant cannot approve a system installation.

Compatible tools are left alone. Unsupported versions, failing shims and SDK
selection errors require diagnosis rather than overwriting installations.
Missing package managers get official manual guidance, never implicit manager
installation. Installer output goes to stderr; JSON output remains separate.
Timeout/failure requires inspecting any still-active installer before retrying.

### Platform routes and honest limits

| Platform | Planned route | Human/manual boundaries |
| --- | --- | --- |
| Windows | Existing WinGet; .NET SDK 8 package or Docker Desktop | Package/source agreements are not auto-accepted. Administrator, WSL/virtualization, GUI/license and restart actions remain explicit. |
| macOS | Existing Homebrew casks `dotnet-sdk@8` or `docker-desktop` | Homebrew is not bootstrapped; no global links/version managers are overwritten. Complete administrator/license/GUI/PATH actions and re-probe. |
| Linux | Ubuntu 22.04/24.04 or Debian 12/13, with an existing trusted APT candidate for SDK 8 or Docker CE | Uses a versioned candidate from the already-configured official repository and matching release. Does not add feeds, remove conflicting engines, change socket/group permissions or start Docker automatically. `sudo -n` cannot obtain new administrator authorization. |

Node/npm bootstrap uses the official OS-specific guidance in
[Get started](../guides/getting-started.md), not a blind latest-version command.
Linux candidates must be attributable to the selected version's official
repository; missing or unrecognized candidates stay manual. Distribution
variants are not assumed compatible. Review Docker licensing, service and
networking effects before approval.

Planner/executor regression tests run across all three platforms in CI.
**Those tests do not certify real installation on clean machines.** Actual
Windows/macOS/Linux installer acceptance, GUI/privilege behavior and ARM SQL
emulation require separately recorded disposable-host evidence. Until that
evidence exists, these are guarded implementation routes, not a certified
unattended installer.

## Approve local operations and continue

With pinned tooling installed, local startup needs one reviewed approval per checkout and workspace. Show it,
then record it only after explicit human approval:

```powershell
npm run setup -- approval --profile role-based-data --workspace 30000
npm run setup -- approve --profile role-based-data --workspace 30000 --approval <id>
npm run setup -- run --profile role-based-data --workspace 30000 --json
```

`approval` proposes a free port block when none is selected and lists every
scope it covers for the startup operation `app`: restore, build, the workspace,
image downloads and SQL startup (`sql-start`), schema, services, `synthetic`
(the read-only SQL acceptance check on the least-privilege app user during
`init`), and a SQL terms line (startup passes `ACCEPT_EULA=Y` for the
[container terms](https://aka.ms/azuresqldb-container), no other license). It
also lists what stays separate: tool installs, stop/recovery and Azure.
`approve` re-plans and refuses a stale id, so a changed plan must be shown
again. `run` and `resume` themselves never record approvals. Existing matching
grants are reused; see [Remember local permissions](local-consent.md).
This approval can be reviewed and recorded before
`role-based-data.json`, DAB entities and procedures are complete. The coordinator
may then restore dependencies, build and initialize the workspace, but it keeps
the launch stage blocked with the specific configuration diagnostic until those
domain inputs are valid.

After a stop or a new session, resume without another approval:

```powershell
npm run setup -- resume --json
```

For agreed external SQL reuse, pass the same `--container <name>` to
`plan`, `run` and `resume`. Review and grant the individual
`consent-plan app <name>` target through
[local consent](local-consent.md); the setup approval bundle covers only
workspace-owned SQL. Gateway identity checks match the selected container,
not the workspace's default container.
Ownership and engine checks remain in the existing runtime. No automatic
volume deletion, credential reset, foreign-process termination or SQL recovery
is performed.

`run`/`resume` stop at the first unmet gate. They execute only existing guarded
operations, skip current npm/SQL restores and builds, and re-plan after each
stage. Failed commands preserve completed work and report a named blocker; they
are not blindly retried. Process output/progress is stderr and JSON results are
stdout. Nonzero exit means action is still required; a zero running status is
not workflow acceptance.

The browser server remains attached to the coordinator's terminal/session.
Press Ctrl+C to stop that server; owned container data remains preserved.
An already responding matching gateway is reused without launching another
process only when checkout, workspace, profile, selected SQL container, source
fingerprint and exact authentication settings match, and its readiness response
confirms `status: ready`. Authentication attestation includes the requested mode
and, for Entra, tenant ID and API client ID; see
[Authentication and application access](authentication.md). A mismatch is an
ownership/authentication blocker, never permission to silently adopt or replace
the gateway. An unready match remains a nonzero launch blocker; recovery is
recognized by the next probe without restarting the gateway.
`workflowVerified` still remains false.

New startup runs the stages start-sql -> init -> data -> serve and requires the
configured readiness procedure before listening; it publishes a launch URL only
after actual HTTP identity/readiness confirmation.
Gateway-only resume makes three read-only attempts with one-second pauses and a
four-second shared probe budget per attempt; it does not start or repair missing
services. A failed initial attempt sequence closes only the new gateway. A later
dependency outage keeps the established gateway live with HTTP 503 readiness and
HTTP 200 liveness.

Regression tests exercise real temporary child processes and loopback HTTP
readiness, early exits, identity conflicts and timeout cleanup. These fixtures
do not certify actual SQL/container startup.

## Finish with a useful verified result

Open the reported origin and test the agreed real browser action, SQL
save/reload, relevant authorization and one useful change. Save only agreed
decisions and exact safe evidence through `guide`; checkpoints are historical,
not live acceptance or permission.

The report deliberately keeps `workflowVerified: false`: setup does not know
your domain acceptance action. Local simulated identities are not production
Entra sign-in. Sharing remains a separately approved optional journey.
