---
name: sql-apps-getting-started
description: Guide a beginner from an app idea to one verified local SQL Apps workflow, then route optional design, validation or sharing work to the matching skill.
---

# SQL Apps

Confirm the absolute SQL Apps application project before edits. If the user is
starting a new app or the resolved home is the foundation checkout, use the
installed launcher's `projects create "<name>"` command first. Generated apps
belong under the configured project root (`%USERPROFILE%\SqlAppsProjects` by
default), never beside or inside the foundation/plugin checkout. Use the
generated project's commands and leave other plugins unchanged.

Follow **Describe -> Run locally -> Make it yours -> Share optionally**.

## Describe

Read `README.md`, then open only the guide needed for the current stage. Ask one outcome-focused question at a time about users, information and actions. Summarize the smallest useful scope, selected capabilities and one first improvement. Do not ask beginners to choose frameworks, Azure services or deployment topology.

Run `npm run guide` to recover saved decisions. Saved evidence is historical, not current readiness or permission.

## Route the work

- Use `sql-apps-application` for screens, SQL behavior, access rules and the first useful change.
- Use `sql-apps-local` for prerequisites, approval, startup, resume and stop.
- Use `sql-apps-validation` for tests and live workflow checks.
- Use `sql-apps-design` for a substantial visual direction or redesign.
- Use `sql-apps-diagnostics` for an existing failure.
- Use `sql-apps-cloud-preview` only after the user asks to share.

Do not preload those skills or their references. Load the next stage only, and stop gathering context once its command or blocker is known.

## Finish locally

Verify a real browser action and SQL save/reload with synthetic data. Then implement and verify one useful change without breaking the original workflow. Use `sql-apps-validation` for current evidence and reporting.

Keep secrets and real records out of saved briefs. A useful local app is success; Azure remains optional.
