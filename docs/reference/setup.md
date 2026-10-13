# Setup coordinator

One project-owned journey connects **check -> review -> install -> restore ->
build -> workspace -> launch -> verify**. No executable or additional desktop
UI is required. Your assistant can drive it through the existing plugin; direct
commands work without an assistant.

The coordinator requires Node 22 or 24 but no npm restore or compiled runtime.
If Node is missing, the assistant must first inspect the OS/CPU and obtain
approval for an official compatible Node installer. A Node script cannot
bootstrap its own missing runtime. Preserve existing version managers.

## Plan before changes

From the intended application checkout:

```powershell
node scripts\setup.mjs plan --json
```

Equivalent: `npm run setup -- plan --json`.
The installed launcher's equivalent is `setup plan --json`, using its absolute
script path and explicitly selected runtime checkout. `--profile role-based-data`
is optional: it is the default and the only local profile.

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
node scripts\setup.mjs install-plan dotnet
```

Tools are `node`, `npm`, `dotnet` and `docker`. These plans do not require
Azure/GitHub CLI, cloud login or an Azure subscription.

Review the returned host/CPU, source, exact command, effects and continuation.
Save the JSON outside tracked source. **Only after explicit human approval of
that installation**, execute its absolute plan path:

```powershell
node scripts\setup.mjs install "C:\path\to\reviewed-install-plan.json"
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

Local startup needs one reviewed approval per checkout and workspace. Show it,
then record it only after explicit human approval:

```powershell
node scripts\setup.mjs approval --profile role-based-data --workspace 30000
node scripts\setup.mjs approve --profile role-based-data --workspace 30000 --approval <id>
node scripts\setup.mjs run --profile role-based-data --workspace 30000 --json
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
node scripts\setup.mjs resume --json
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
