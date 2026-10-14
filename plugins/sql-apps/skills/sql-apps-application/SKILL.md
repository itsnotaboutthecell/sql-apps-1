---
name: sql-apps-application
description: "Use when defining or implementing a domain-specific SQL Apps screen, user-facing app or UI change, client operation, API procedure, schema change, access rule, or first useful application change. Route every new user-facing app and meaningful UI change through sql-apps-design."
---

# Build the application

Resolve `../../scripts/sql-apps.mjs` from this installed skill and run its
absolute path with `home`. Confirm the intended application project before
edits. If `home` resolves to the SQL Apps foundation and the user is creating a
new app, run `projects create "<name>"`, then work only in the generated
project. Projects default to `%USERPROFILE%\SqlAppsProjects`; never implement a
domain app inside or beside the foundation/plugin checkout. `SQL_APPS_HOME`
selects runtime code; it does not change the loaded skill.

This skill owns domain behavior. Use `sql-apps-local` for setup and startup, `sql-apps-validation` for acceptance, `sql-apps-design` for every new user-facing app and meaningful UI change, and `sql-apps-cloud-preview` for requested sharing.

## Agree on one useful slice

Read the saved brief with `guide`, then the current request. Treat the requested change as the useful slice. Ask only about missing decisions, one question at a time:

- users and access;
- records and required fields;
- actions and validation;
- the requested outcome.

Read `docs/guides/build-your-app.md` only when the scope is not settled. Read the relevant part of `docs/maintainers/application-boundary.md` before implementing its contract. Summarize new decisions and explicit exclusions before editing; do not repeat settled discovery.

Keep `application.json` named for the app with `selectedExamples: []`. Do not copy an example, scaffold another runtime or add capabilities outside the agreed scope.

SQL Apps has one profile, `role-based-data` (SQL, DAB and the browser gateway); the saved brief's capabilities are exactly `["data"]`. If the app needs file storage or background jobs, say so and route that part to the maintained Azure skills (for example `azure-storage`, `azure-prepare`, `azure-deploy`) instead of adding it to SQL Apps.

Before implementing a new user-facing app or meaningful UI change, use `sql-apps-design`. Record a short design intent covering audience, primary task, hierarchy, typography, palette, layout and responsive behavior. Reuse established styles and known preferences, choose sensible defaults for the rest, and ask only about unresolved preferences or branding that would consequentially change the result. Keep database and access decisions separate from visual choices.

## Implement the slice

Use the existing runtime, client, DAB and SQL project. Apply **Domain contracts and live acceptance** from `docs/maintainers/application-boundary.md`; it is the source of truth for text limits, exact values, SQL mutation ordering, readiness and positive controls.

For role-authorized data:

- define the configured role and allowed member types;
- expose only the required procedures;
- let the gateway choose the DAB role from validated claims;
- reject caller-supplied role escalation;
- preserve owner isolation where the agreed app requires it.

Product screens show account and access states, never persona selectors. Local test identities stay on the developer page. Preview simulation does not prove Entra assignment or cloud token behavior.

Deliver a basic shell and one real interaction before expanding the application. A basic shell is an implementation milestone, not final design acceptance: it means small scope, not unfinished visual quality. Label mock or synthetic-only behavior. Use the composition and rendered-review gate in `sql-apps-design`; visual approval is not permission for schema or startup changes.

## Check the application boundary

Use `sql-apps-validation` to select the smallest checks covering the change. Against an approved running app, also use the API and database checks documented in `docs/maintainers/application-boundary.md`. Remove inherited example tests rather than restoring excluded example code. Existing databases may retain old sample objects under non-destructive publishing; report them and request a separate reviewed cleanup instead of deleting data.

Verify the agreed browser action, SQL save/reload, invalid input and relevant ownership behavior. Repeat the changed and original workflows.

Complete the **Rendered browser review** in `sql-apps-validation` for every new user-facing app and meaningful UI change. This review is distinct from API/SQL and browser workflow acceptance: verify the intended origin, use semantic browser inspection and real interactions, and inspect rendered output at desktop and narrow widths when the host supports them. Opening a tab or reviewing source is not visual review.

Report exact commands and results. Hand startup or resume work to `sql-apps-local`. Offer cloud preparation only when the user asks to share.
