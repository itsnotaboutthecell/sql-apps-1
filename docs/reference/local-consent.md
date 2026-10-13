# Remember local permissions

SQL Apps can remember explicitly approved local operations across sessions.
This avoids approving the same restore, build or startup effects repeatedly.
It does not turn "continue autonomously" into permission.

The [setup coordinator](setup.md) plans these same operations and uses their
existing guarded execution. It never grants scopes automatically. System
installation plans are separate: explicitly reviewed `setup install` consumes
one named host/tool installation plan before dispatch, even if it fails.
Installation receipts under `.sql-apps/install-<plan-id>.json` are replay
protection, not persistent permission or proof that a tool is ready. They
contain no credentials. Re-probe tools after installation/restart.

## First run and return visits

1. Confirm the canonical application checkout and inspect setup read-only.
2. Install missing tools only, each with its own reviewed plan.
3. Run `setup approval --profile role-based-data --workspace <base-port>`. It
   lists restore, build, workspace selection, image downloads, SQL startup,
   schema, services, the read-only SQL acceptance check and the SQL terms line
   together, plus what is excluded. Present it once.
4. After explicit approval, run the printed `setup approve ... --approval <id>`.
   It records every listed grant and the inline terms acknowledgement under one
   lock and refuses a stale id. Then `setup run`.
5. On return, matching grants are reused. Editing application SQL, DAB
   configuration or `role-based-data.json` does not ask again; changed launcher
   code, ports, profile or terms do. A failed approval control captures nothing.

Individual `plan`/`grant` commands below remain for scripted or partial use.
`grant --plan-from <operation> [selection]` records a freshly computed plan
without a temporary file.

Deliver an approved useful slice early and label synthetic or mock-only
behavior. Use the validation skill for current workflow evidence; saved grants
and checkpoints are not acceptance.

## Commands available before build

Run from the intended checkout. These commands need Node, but not npm packages
or compiled runtime:

```powershell
node scripts/local-consent.mjs plan build
node scripts/local-consent.mjs status build
node scripts/local-consent.mjs revoke build
node scripts/local-consent.mjs revoke terms
```

The equivalent npm command is `npm run consent -- <command>`. Plans and status
return JSON including requirements, effects, matching/missing scopes, terms
status and `allowed`. A missing grant is normal planning output, not a successful
execution. `run` fails explicitly when permission or acknowledgement is missing.

### Record the scopes you approve

Save the plan as UTF-8 JSON in an untracked location. For example, in PowerShell:

```powershell
node scripts/local-consent.mjs plan build |
  Set-Content -Encoding utf8 "$env:TEMP\sql-apps-build-plan.json"
```

Review the checkout and effects in that file. **Only after explicitly approving
those effects**, record it and execute:

```powershell
node scripts/local-consent.mjs grant "$env:TEMP\sql-apps-build-plan.json"
node scripts/local-consent.mjs run build
```

`grant` recomputes the requirements and rejects a stale or copied plan. The
assistant must not call it automatically to repair a denial. `run restore`
executes `npm ci` and `dotnet tool restore`; it downloads dependencies and writes
local files, not system installations. Restore only when dependencies are missing.
`run build` executes the project's existing runtime/browser build.

Workspace creation is separate:

```powershell
node scripts/local-consent.mjs plan workspace-init 30000
```

Replace `30000` with the reviewed free port block from `workspace-plan`. Grant
the reviewed workspace plan and execute `npm run local -- workspace-init 30000`.
For an existing fixed-port stack, explicitly choose `legacy` instead. This only
records a descriptor; it does not authorize startup, migrate data or delete it.
Creating the descriptor preserves checkout-level restore/build grants.

Once selected, plan the startup operation `app` (`role-based-app` is an alias).
The plan lists all of its scopes before any startup side effect. Record that
reviewed plan once rather than repeating prompts after each completed stage.

### Terms acknowledgement

The setup approval includes the terms as an explicit line: startup passes
`ACCEPT_EULA=Y` for the
[Azure SQL Database container](https://aka.ms/azuresqldb-container) and accepts
no other license. Approving the bundle records that statement's URL and digest;
a changed statement requires review again.

Alternatively, acknowledge a reviewed local copy of the actual applicable terms
supplied with preview registry access.
Review a local regular-file copy; do not invent a terms version or use an image
tag as its identity. Do not put private terms or credentials in chat or source.
With explicit approval to record the acknowledgement:

```powershell
node scripts/local-consent.mjs terms "C:\path\to\reviewed-preview-terms.txt"
```

SQL Apps records the canonical document path and SHA-256 content digest, not the
full document. The same document can remain acknowledged across sessions.
Startup separately requires a matching `sql-start` grant; it passes
`ACCEPT_EULA=Y`, without another chat dialog. Acknowledgement does not establish
legal entitlement, registry access or acceptance of any other license.

An edited or missing reviewed document requires renewed acknowledgement.
**Remote terms changes cannot be detected from an unchanged local copy.** When
preview access supplies revised terms, review/update that document before reuse.
The system does not guess whether remote terms or the preview offer changed.

### Revocation and one-operation approval

`revoke <scope>` removes that scope's grants, `revoke terms` removes the
acknowledgement, and `revoke` removes all grants and acknowledgement. Malformed
or copied state fails explicitly; revocation does not silently repair corrupt
state or remove resources.

Consent writes share the dependency-free process/host lock used by deployment.
A killed owner is recovered on the next write without losing grants or terms.
Old empty consent locks are recoverable after 30 seconds; a fresh empty lock,
a live owner or a different host is not taken over. Concurrent recovery removes
only the old owner's unique record, never a replacement owner's record.
On Windows, concurrent removal can report `EPERM` after the old directory has
already disappeared; recovery proceeds only after confirming that absence.
Permission errors for a still-existing lock remain explicit failures.

`recover-sql` needs `grant-once <absolute-plan.json>`, not a persistent grant.
After explicit approval, the direct runtime CLI consumes the grant **before**
dispatch; even a failed operation needs renewed approval. Recovery still refuses
running/external/legacy SQL and preserves image, credentials and volume.

## Scope and invalidation

| Scope | Effects and boundaries |
| --- | --- |
| `restore` | npm/NuGet tool restore, downloads and local disk writes; dependency-manifest changes require review. |
| `build` | Runtime/browser/SQL build effects; ordinary app source edits do not revoke the build permission, but changed build scripts/targets do. |
| `workspace` | Descriptor creation for the explicit checkout and selected port block or legacy mode. |
| `sql-start` | Start/create owned SQL resources and download its image, with matching reviewed terms. |
| `schema` | Non-destructive schema/grant publication to the declared local database; changes to the schema launcher or role-based profile code require review, application SQL edits do not. |
| `services` | Start/reuse the role-based-data loopback DAB container and browser gateway with their image/configuration effects. Changed launcher code requires review; DAB configuration and `role-based-data.json` edits do not. |
| `synthetic` | The exact acceptance suite, fixtures and cleanup. `app` and bare `init` also run the built-in read-only SQL acceptance check on the least-privilege app user. |
| `stop` | Stop/remove verified owned services, preserving SQL volumes and credentials. |

Records live in ignored `.sql-apps/consent.json` and `.sql-apps/terms.json`.
They contain no credentials or actual application records. Requirements bind
the canonical checkout, selected workspace, targets, profile and relevant
operation contracts/configuration. They do not expire solely because a session
ends. Changed targets, effects or applicable terms require review.

Selected-app grants bind relevant SQL/grants, server/DAB content and application
contracts, not a generated build-directory name, browser styling or provenance
timestamps. Browser-only rebuilds therefore do not renew database/service
permissions. Full source and artifact-integrity validation still runs before
selected runtime execution; permission reuse never makes a stale build usable.

Read-only `help`, `workspace-plan`, `verify` and `app-check` do not require a
grant; ownership and runtime readiness checks still apply. Local mutations
require explicit workspace selection, including `workspace-init legacy` for an
existing fixed-port stack.

`app-test` takes no container selection: it tests the selected workspace gateway.
It rejects a container argument rather than recording permission for a target
that the gateway acceptance command would not use.

## Direct CLI and installed plugin

`npm run local -- <operation> [selection]` checks the same policy as guarded
`run` commands before any mutation, including composite startup. No duplicate
grant consumption occurs when `run` dispatches that CLI.

The installed launcher exposes pre-build `consent-plan`, `consent-status`,
`consent-grant`, `consent-grant-once`, `consent-terms`, `consent-revoke` and
`consent-run`, with corresponding arguments. It selects the validated
application home, not the plugin cache. Existing source/build checks still apply
to runtime execution.

This is a reviewable **local command policy**, not a security boundary against
someone who controls the checkout. Bare `npm ci`, `npm run build`, contributor
tests and raw tools are not intercepted. Agents must use the guarded paths and
may not use raw tools to bypass missing approval. Tool installations, destructive
resets, unrelated resources, production and cloud spending are never authorized
by these saved grants.
