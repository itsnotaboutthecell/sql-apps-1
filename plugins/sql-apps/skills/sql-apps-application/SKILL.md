---
name: sql-apps-application
description: "Use when defining or implementing a domain-specific SQL Apps screen, client operation, API procedure, schema change, access rule, or first useful application change."
---

# Build the application

Resolve `../../scripts/sql-apps.mjs` from this installed skill and run its
absolute path with `home`. Confirm the intended application project before
edits. If `home` resolves to the SQL Apps foundation and the user is creating a
new app, run `projects create "<name>"`, then work only in the generated
project. Projects default to `%USERPROFILE%\SqlAppsProjects`; never implement a
domain app inside or beside the foundation/plugin checkout. `SQL_APPS_HOME`
selects runtime code; it does not change the loaded skill.

This skill owns domain behavior. Use `sql-apps-local` for setup and startup, `sql-apps-validation` for acceptance, `sql-apps-design` for substantial visual work and `sql-apps-cloud-preview` for requested sharing.

## Agree on one useful slice

Read the saved brief with `guide`, then the current request. Treat the requested change as the useful slice. Ask only about missing decisions, one question at a time:

- users and access;
- records and required fields;
- actions and validation;
- needed capabilities;
- the requested outcome.

Read `docs/guides/build-your-app.md` only when the scope is not settled. Read the relevant part of `docs/maintainers/application-boundary.md` before implementing its contract. Summarize new decisions and explicit exclusions before editing; do not repeat settled discovery.

Keep `application.json` named for the app with `selectedExamples: []`. Do not copy an example, scaffold another runtime or add capabilities outside the agreed scope.

Choose `role-based-data` for SQL/DAB/browser-only apps and `foundation` only when files or background jobs are required. State any unsupported local or cloud combination instead of silently substituting a profile.

## Implement the slice

Use the existing runtime, client, DAB and SQL project. Apply **Domain contracts and live acceptance** from `docs/maintainers/application-boundary.md`; it is the source of truth for text limits, exact values, SQL mutation ordering, readiness and positive controls.

For role-authorized data:

- define the configured role and allowed member types;
- expose only the required procedures;
- let the gateway choose the DAB role from validated claims;
- reject caller-supplied role escalation;
- preserve owner isolation where the agreed app requires it.

Product screens show account and access states, never persona selectors. Local test identities stay on the developer page. Preview simulation does not prove Entra assignment or cloud token behavior.

Deliver a basic shell and one real interaction before expanding the application. Label mock or synthetic-only behavior. For substantial visual work, agree on a direction through `sql-apps-design`; visual approval is not permission for schema or startup changes.

## Check the application boundary

Use `sql-apps-validation` to select the smallest checks covering the change. Against an approved running app, also use the API and database checks documented in `docs/maintainers/application-boundary.md`. Remove inherited example tests rather than restoring excluded example code. Existing databases may retain old sample objects under non-destructive publishing; report them and request a separate reviewed cleanup instead of deleting data.

Verify the agreed browser action, SQL save/reload, invalid input and relevant ownership behavior. Repeat the changed and original workflows.

Report exact commands and results. Hand startup or resume work to `sql-apps-local`. Offer cloud preparation only when the user asks to share.
