---
name: sql-apps-diagnostics
description: "Use when an existing SQL Apps workflow fails, including local startup, readiness, SQL/DAB, authorization, API, or persistence."
---

# Diagnose SQL Apps

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home`, and confirm the intended application checkout with `workspace-check`. Keep diagnosis scoped to the failing SQL Apps contract and use bounded, project-owned evidence.

## Diagnose the selected app

Use `sql-apps-local` for workspace/readiness and the next safe lifecycle action. Reproduce the failing action with bounded logs and project state; pair negative authorization/input probes with a positive control. Use `sql-apps-validation` to verify the fix.

Never print tokens, credentials, environment variables or private files. Liveness is not workflow acceptance. Preserve data; recovery/destructive maintenance needs explicit approval.

## Escalate the isolated issue

Load a specialist only when evidence identifies its boundary:

- SQL Apps publishing/cost-guard failures: `sql-apps-cloud-preview`.
- Azure resource incidents: `azure-diagnostics`; platform cost optimization: `azure-cost-optimization`.
- Cloud SQL connections: `diagnose-connection-errors`; local preview engine issues: `azuresql-db-faq`.
- DAB configuration/exposure: `dab-rest-and-graphql` or `azuresql-db-dab`, matching the target.
