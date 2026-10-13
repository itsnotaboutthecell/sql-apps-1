---
name: sql-apps-cloud-preview
description: "Use when a user wants to share a SQL Apps project or asks about cloud readiness; hand generic Azure planning, cost, validation, deployment, and diagnostics to maintained Azure skills."
---

# Share a SQL Apps project

Sharing is optional. Confirm the application checkout and preserve the SQL Apps contract: Azure SQL Database is the data store, DAB is the application API, and the user must explicitly request Azure work.

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home`, and confirm the requested project with `workspace-check` before reading or testing that project.

## Route cloud lifecycle work

Use maintained skills for generic Azure work rather than extending SQL Apps' custom Azure CLI/Bicep orchestration:

- Use `build-app-on-azure-sql` to sequence Azure SQL identity, schema, API, and deployment decisions.
- Use `azure-app-onboard` when the target architecture or service choice is open.
- Use `azure-prepare` to create the Azure deployment plan and infrastructure.
- Use `azure-validate` before any deployment.
- Use `azure-deploy` to deploy the reviewed plan.
- Use the `azure-cost` plugin for forecasts, estimates, actual cost analysis, optimization, and governance.
- Use `azure-diagnostics` for Azure production incidents.
- Use `github-actions-for-sql` for SQL-aware CI pipelines.

If the Azure Skills plugin or a specialized skill is unavailable, explain the prerequisite and use the project's documented legacy route only when the user explicitly requests that route. Do not implement a parallel generic Azure service, cost, deployment, or diagnostics workflow in SQL Apps.

## Preserve SQL Apps-specific requirements

Before handing off, record the agreed application profile, SQL/DAB configuration, identity and application-role contract, private-network requirements, database grants, and acceptance criteria. Treat deployment output and infrastructure validation as necessary, not as proof that the SQL/DAB application works.

After deployment, use `sql-apps-validation` for the application-specific acceptance: live sign-in, expected DAB role forwarding, least-privilege procedure access, two-user isolation where required, and a browser write followed by SQL persistence and reload. Report preparation, deployment, and application acceptance as separate results.

## Existing SQL Apps deployment commands

`npm run azure` commands and their Bicep templates remain a compatibility path for existing projects while migration proceeds. Do not recommend that custom orchestration for new projects by default. If an existing deployment must use it, read its exact profile and deployment reference, preserve its approval gates, and do not mix its state files with an Azure Skills/`azd` deployment.
