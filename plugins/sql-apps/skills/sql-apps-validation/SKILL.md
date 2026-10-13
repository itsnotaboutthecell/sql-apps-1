---
name: sql-apps-validation
description: "Use when testing SQL Apps changes or verifying application, plugin, SQL, API, browser, role-based access, ownership or deployment contracts."
---

# Validate SQL Apps

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home` and execute commands in that confirmed application checkout.

Choose the smallest checks that cover the change:

- Plugin packaging: `npm run plugin:check`.
- Unit and regression tests: `npm test`.
- TypeScript: `npm run typecheck`.
- Application boundary: `npm run app:check`.
- SQL project: `npm run sql:build`.
- DAB configuration: `npm run dab:validate`.
- Infrastructure syntax: `npm run infra:build`.

Use the exact commands in `docs/maintainers/application-boundary.md` for SQL model, live API and database absence checks. A targeted pass is not a full-suite pass.

For an approved running application, use the launcher checks: `app-check` for the clean application database acceptance, `test` for the read-only SQL acceptance and `app-test` for the two-user role check (Development Alice admitted, Development Bob 403). Run acceptance commands sequentially. Tests that stop or restart owned services, create fixtures or mutate data need their documented approval.

## Live workflow evidence

Verify the agreed browser action and actual SQL save/reload. Apply **Domain contracts and live acceptance** from `docs/maintainers/application-boundary.md`, including UTF-16 limits, exact values, readiness, mutation ordering and positive controls.

- Use synthetic, uniquely named fixtures and owned sessions.
- Snapshot preexisting records before writes and remove only this run's fixtures.
- Verify initial-load failure, failed-save retention and successful reload where relevant.
- Supply the expected Origin and valid authorization for mutation probes.
- Prove foreign or invalid writes fail and leave data unchanged.
- Treat a genuinely new browser document and refetched SQL state as reload evidence.

If browser input, a service or a host tool is unavailable, report the missing check. A forced DOM click, screenshot, source review, mock, health response or compilation result is not workflow acceptance.

Use the existing compiler and Node test runner when editor discovery fails. Do not install another runner or invent test paths.

Record exact commands and results. Separate implemented, built, running and workflow-verified states. Historical checkpoints and local simulation do not prove current cloud identity, private networking or production authorization.
