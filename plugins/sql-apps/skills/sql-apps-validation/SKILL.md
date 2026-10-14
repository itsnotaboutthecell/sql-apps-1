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

Record exact commands and results. The final report has four separate lines:

- **Implemented/built:** source and build evidence.
- **Running:** intended origin and readiness evidence.
- **Functional acceptance:** accepted, partial or blocked, with browser/API/SQL checks.
- **Design acceptance:** accepted, `partial: N cells` or blocked, citing `docs/design-review.md`.

Historical checkpoints and local simulation do not prove current cloud identity, private networking or production authorization.

## Rendered browser review

Keep three evidence lanes distinct: API/SQL acceptance proves data and access contracts; real browser workflow acceptance proves interaction and persistence; rendered visual review proves the interface's presentation. Screenshots do not prove persistence or access, and compile/API results do not prove visuals.

For every new user-facing app and meaningful UI change:

1. Verify the intended origin before review.
2. Use semantic browser inspection and real interactions. Never invent page handles or confuse instance handles with browser page handles.
3. Inspect screenshots or rendered output at desktop and narrow viewport widths. If the preferred tool cannot resize, use another available browser/computer-use capability; otherwise record the narrow cells as blocked with the exact reason.
4. Review the primary state and reachable signed-out, authorized, no-access, loading, empty, error, saving, success and disabled states.
5. Check hierarchy, spacing, wrapping, overflow, focus visibility, and useful empty/error guidance.
6. Fix observed defects, then re-review the affected viewport and state.

If a preferred browser or screenshot path fails, discover supported host alternatives rather than fabricating success. Opening a tab or source review is not visual review. If blocked, state the exact evidence not observed. Label feedback supplied by the user as user-reported; do not merge it with direct observations.

Visual evidence provenance records the intended origin, source/build reviewed, viewport, state, artifact when available, findings and re-review result in `docs/design-review.md`. Use the matrix contract in `docs/reference/design-acceptance.md`; run `sql-apps check` and report its unreviewed-cell count. Keep blocked and user-reported evidence separate from observed evidence.
