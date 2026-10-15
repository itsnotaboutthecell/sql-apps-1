---
name: sql-apps-local
description: "Use when checking prerequisites, starting, resuming or stopping a SQL Apps application locally, or selecting its local SQL container and workspace."
---

# Run SQL Apps locally

Resolve `../../scripts/sql-apps.mjs` from this installed skill and use its absolute path. Run `home`, then confirm the intended application checkout. Never run from a plugin cache or silently rebind another checkout.

Own local prerequisites and lifecycle, not domain code or acceptance. Do not load cloud cost or deployment guidance during local startup.

## Plan the next action

Run `guide`, then `setup plan --json` through the launcher. The coordinator owns prerequisite probes, restore/build, workspace, SQL terms, startup and resume state. `role-based-data` (SQL, DAB, browser gateway) is the only profile.

Show the plan. After explicit approval, use its printed `setup approve` command, then `setup run`; use `setup resume` after a stop or corrected blocker. Never manufacture a grant, bypass a blocker, repeat completed work or treat a nonzero result as success. If approval controls are unavailable, wait for explicit scoped approval in chat; autonomy is not consent.

Read `docs/guides/getting-started.md` or `docs/reference/local-development.md` only for the current blocker. Use the standalone prerequisite diagnostic only when the plan directs it. Stop gathering context once the next action is known.

## Missing tools

Use `setup install-plan <tool>`. Explain source, command, downloads, disk/privilege effects and continuation; execute the unchanged absolute plan only after explicit approval.

Do not replace compatible tools, bootstrap a package manager, overwrite version managers, auto-accept licenses, elevate, reboot, change Docker permissions or disable security controls. Human installer, credential, license and restart steps remain pauses. Credentials are entered in their own terminal, never chat or repository files.

The SQL preview needs approved registry access unless a usable image/container exists. Never substitute another SQL engine.

## Start or reuse

Run `workspace-check` before lifecycle commands. Source, binding, workspace or provenance mismatches need explicit application selection, not copied source or overwritten state.

Reuse a responding service only when `/local/workspace` and `/health/ready` identify the intended checkout, source, workspace, profile, authentication and SQL container. A proposed URL or HTTP liveness alone is not a usable app.

- `app`: start SQL, DAB and the gateway.
- `serve`: resume the gateway against running SQL/DAB.
- `stop`: remove only DAB; SQL keeps running.

Keep commands attached. Preserve SQL data on stop. Never reset volumes, regenerate credentials, stop unrelated processes or adopt a mismatched container. Recovery and destructive cleanup require their own reviewed plan and approval.

Examples require explicit selection; keep `selectedExamples: []` otherwise.

## Verify completion

Publish a launch URL only after the intended server and readiness probe respond. Hand functional evidence and, for new apps or meaningful UI changes, required rendered browser review to `sql-apps-validation`.

Give the verified URL, user flow, Ctrl+C behavior and `serve`/`stop` commands. Follow the development identity boundary in `docs/reference/local-development.md`; simulated accounts are not real cloud authorization.

A useful local app is success. No Azure subscription or cloud deployment is required.
