---
name: sql-apps-diagnostics
description: "Use for a SQL Apps local SQL/DAB or application-contract failure; route Azure resource incidents to the maintained Azure diagnostics skill."
---

# Diagnose SQL Apps

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home`, and confirm the intended application checkout with `workspace-check`. Keep diagnosis scoped to the failing SQL Apps contract and use bounded, project-owned evidence.

## Route to the capability owner

- Azure resource health, Container Apps, Functions, Azure Monitor, Log Analytics, or production incidents: use `azure-diagnostics`.
- Azure cost, forecasts, or resource optimization: use the `azure-cost` plugin.
- Azure SQL connection or engine errors: use `diagnose-connection-errors` or the matching Azure SQL diagnostic skill.
- DAB configuration, permissions, or API exposure: use `dab-rest-and-graphql` and `azuresql-db-dab`.
- Local SQL Apps startup, readiness, or application-contract failures: continue below.

## Local application failures

Use `sql-apps-local` to inspect the selected profile, workspace, service readiness, and next safe lifecycle action. Use `sql-apps-validation` to reproduce and verify the domain workflow.

Reproduce the failing action and pair negative authorization/input probes with a positive control. Inspect only bounded logs and project state; never print tokens, environment variables, or private files. HTTP liveness does not prove SQL permissions, DAB behavior, persistence, or browser acceptance. Preserve application data, and obtain explicit approval before recovery or other destructive maintenance.
