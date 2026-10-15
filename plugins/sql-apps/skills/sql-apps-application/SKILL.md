---
name: sql-apps-application
description: "Use when defining or changing a SQL Apps application, screen, client operation, API procedure, schema, or access rule."
---

# Build the application

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run its absolute path with `home`, and confirm the application project before edits. If creating a new app from the foundation, run `projects create "<name>"` and work only in that generated project. The default root is `%USERPROFILE%\SqlAppsProjects`; never build a domain app inside or beside the foundation/plugin checkout. `SQL_APPS_HOME` selects runtime code, not loaded skills.

## Agree on one useful slice

Read the saved brief with `guide`, then the current request. Treat the requested change as the useful slice. Ask only about missing users/access, records/fields, actions/validation or outcomes, one question at a time. Summarize new decisions and exclusions; do not repeat settled discovery.

Read `docs/guides/build-your-app.md` only for unresolved scope. Apply the relevant contract in `docs/maintainers/application-boundary.md` before changing it.

Keep `application.json` named for the app with `selectedExamples: []`. The only profile is `role-based-data`, with capabilities `["data"]`. Do not copy examples, scaffold another runtime or add unrequested capabilities. File storage and jobs belong outside SQL Apps, using maintained Azure skills.

Before implementing a new user-facing app or meaningful UI change, use `sql-apps-design`. Keep database and access decisions separate from visual choices. A basic shell is an implementation milestone, not final design acceptance: small scope, not unfinished visual quality.

## Implement the slice

Reuse the runtime, client, DAB and SQL project. Apply **Domain contracts and live acceptance** from the boundary reference for text limits, exact values, mutation ordering, readiness and positive controls.

- Define the configured role and allowed member types.
- Expose only required procedures; the gateway chooses the DAB role from validated claims.
- Reject caller-supplied role escalation; preserve agreed owner isolation.

Deliver one real interaction before expanding. Product screens show account/access states, never persona selectors. Test identities stay on the developer page; simulation does not prove Entra assignment or cloud tokens. Label mock or synthetic-only behavior.

## Check the application boundary

Use `sql-apps-validation` for checks, live workflow evidence and required rendered browser review. Follow its four-verdict report; repeat the changed and original workflows.

Remove tests importing excluded examples rather than restoring example code. Report legacy database objects retained by non-destructive publishing; cleanup needs a separate reviewed plan and approval.

Use `sql-apps-local` for startup/resume and `sql-apps-cloud-preview` only for requested sharing.
