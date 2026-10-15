---
name: sql-apps-validation
description: "Use when validating SQL Apps changes or collecting test, browser, SQL, access, ownership, or deployment evidence."
---

# Validate SQL Apps

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home`, and confirm the target checkout. Inspect `package.json`: `sqlApps.project` identifies generated apps. Choose the smallest covering check; full suite only when targeted evidence warrants it.

## Generated applications

Use `npm run build`. Run declared test scripts when present; otherwise use the existing Node runner on real test files. Typecheck with `npx --no-install tsc --noEmit`. Never invent scripts/paths, install another runner or switch projects to make a check available. Report missing checks.

## Foundation and plugin maintenance

Only in the foundation, select its declared scripts: `npm run plugin:check`, `npm run typecheck`, `npm run app:check`, `npm run sql:build`, `npm run dab:validate`, `npm run infra:build`, or `npm test`. Use focused compiler/Node tests first; a targeted pass is not a full-suite pass.

Use `docs/maintainers/application-boundary.md` for source, SQL model and live API/database absence checks in either target.

## Live workflow evidence

For approved running local apps, run launcher checks sequentially: `app-check` (clean database), `test` (read-only SQL), and `app-test` (Development Alice admitted, Bob 403). Fixture writes and service restarts need documented approval; startup belongs to `sql-apps-local`. Cloud probes follow the publisher contract.

Apply **Domain contracts and live acceptance** from the boundary reference:

- Use unique synthetic fixtures and owned sessions; snapshot preexisting records and remove only this run's fixtures.
- Supply the expected Origin and authorization. Pair invalid/foreign writes with a positive control; prove rejected writes leave data unchanged.
- Verify a real browser action, initial-load failure, failed-save retention and SQL save/reload. Reload means a new browser document and refetched SQL state.

Unavailable input/services/tools mean missing evidence, not acceptance. Forced DOM clicks, mocks, source review, health responses and compilation do not prove the workflow.

## Rendered browser review

Keep API/SQL acceptance, real browser workflow acceptance, and rendered visual review distinct. Screenshots do not prove persistence or access; compile/API results do not prove visuals.

For new user-facing apps and meaningful UI changes, run `sql-apps-design`'s render-critique-improve loop before broad coverage. Verify the intended origin; use semantic browser inspection and real interactions. Never invent page handles or confuse instance/page handles. Inspect desktop and narrow widths; if tooling fails, discover supported alternatives. Opening a tab or source review is not visual review. If blocked, state the exact evidence not observed, separate from user-reported feedback.

Record origin, source/build, viewport, state, artifact, findings and re-review in `docs/design-review.md` per `docs/reference/design-acceptance.md`, then run `sql-apps check`.

## Four-verdict report

Record exact commands/results and four independent lines:

- **Implemented/built:** source/build evidence.
- **Running:** intended origin/readiness.
- **Functional acceptance:** accepted, partial or blocked, with browser/API/SQL evidence.
- **Design acceptance:** accepted, partial or blocked, reporting rendered coverage and design quality separately; a complete matrix is not a quality verdict.

Historical checkpoints and local simulation do not prove current cloud identity, networking or authorization.
