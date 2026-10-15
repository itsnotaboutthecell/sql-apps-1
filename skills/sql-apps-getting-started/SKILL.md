---
name: sql-apps-getting-started
description: "Use when a beginner is starting a SQL Apps project, shaping an app idea, or choosing the next local-first step."
---

# SQL Apps

Confirm the absolute application project before edits. For a new app, use the installed launcher's `projects create "<name>"`, then the generated project's commands. Never build inside or beside the foundation/plugin checkout; leave other plugins unchanged.

Follow **Describe -> Run locally -> Make it yours -> Share optionally**.

## Describe

Run `npm run guide` for saved decisions; they are historical, not current readiness or permission. Open only the current stage's guide. Ask one outcome-focused question at a time about missing users, information and actions. Summarize scope and exclusions; do not ask beginners to choose frameworks, Azure services or topology.

## Route the work

- Route every new user-facing app and meaningful UI change through `sql-apps-design`.
  It owns the design pass; no companion skill is required.
- `sql-apps-application`: domain scope, code and access rules.
- `sql-apps-local`: prerequisites, approval and lifecycle.
- `sql-apps-validation`: checks and evidence.
- `sql-apps-diagnostics`: an existing failure.
- `sql-apps-cloud-preview`: requested publishing, pricing or cloud readiness; owns the bundled publisher.

Load only the needed stage, not all skills/references. Stop gathering context once its command or blocker is known.

## Finish locally

After authorized startup, use `sql-apps-validation` to verify a real browser action and SQL save/reload, including required rendered browser review for new apps or meaningful UI changes. Follow its evidence/reporting contract; never claim unobserved checks passed.

Keep secrets and real records out of saved briefs. A useful local app is success; Azure remains optional.
