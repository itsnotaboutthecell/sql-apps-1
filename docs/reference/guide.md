# Guide command and saved brief

`guide` records agreed decisions for the **Describe -> Run locally -> Make it yours -> Share optionally** journey. It is not an application generator, startup command or live-health check.

From the intended checkout:

```powershell
npm run guide
node scripts/guide.mjs --json
```

These dependency-free commands work before build or package restore. They report source/build/workspace state, saved decisions and a suggested next action without starting services or contacting Azure.

## Save a brief

Create a JSON file with the agreed decisions, then pass its path:

```powershell
node scripts/guide.mjs --save "C:\path\project-brief.json"
```

Example input:

```json
{
  "purpose": "Track equipment loans",
  "audience": "Our equipment team",
  "records": ["Equipment", "Loans"],
  "actions": ["Register equipment", "Record a return"],
  "capabilities": ["data"],
  "nextChange": "Add a due-date field",
  "costPreference": "zero-azure-spend"
}
```

Required text fields are nonblank, at most 500 characters, without control characters. `records` and `actions` contain 1-12 unique nonblank strings. `capabilities` must include `data`; optional values are `files` and `background-jobs`. The existing file processor requires `files` with `background-jobs`.

These are scope decisions, not switches that dynamically compose services. The foundation `app` command still starts its full file/job stack. Role-authorized data apps use the configured [role-based-data profile](role-based-data.md), `role-based-app` and `role-based-serve`; `serve-sql` remains an advanced SQL-only gateway. The selected Todo reference has a separate synthetic-only startup. See [Run locally](../guides/run-locally.md).

Optional `costPreference` is `zero-azure-spend` or `review-paid-costs`. It is never spending consent.

The report's `profile` is `role-based-data` when `role-based-data.json` exists in the checkout, otherwise `null`. `suggestedProfile` is that configured profile; without one, a saved brief suggests `role-based-data` for data-only capabilities and `foundation` when it includes `files` or `background-jobs` (`null` before a brief). The suggestion fills the `setup plan --profile` hint; cloud cost review routes to the Azure Cost plugin. It is advice, not configuration: a suggested `role-based-data` still needs `role-based-data.json`, which `setup plan` reports.

## Record historical evidence

An optional checkpoint records what was actually checked:

```json
"checkpoint": {
  "stage": "run-locally",
  "summary": "Created and reloaded a loan",
  "evidence": ["Browser save/reload passed; SQL row inspected"]
}
```

Add it to the complete brief object. Stage is `describe`, `run-locally` or `make-it-yours`; summary is nonblank and evidence contains 1-12 unique descriptions under the same text limits. Cloud-completion checkpoints and unknown fields are rejected.

Saved evidence is **historical**, not current readiness. Source changes require rebuilding and verifying the actual app locally. A completed local checkpoint does not authorize installations, downloads or cloud deployment.

Use the actual stage: scope agreement is `describe`, browser launch/save/reload is `run-locally`, and verified changed behavior is `make-it-yours`. Include exact commands/results and separate agent-observed evidence from user-reported testing. Do not promote "I tested it" into a detailed agent-verified acceptance record.

Before saving, replace a completed `nextChange` with the next agreed outstanding change or explicit text such as "No further change agreed"; the required text field cannot be omitted. Saving replaces the current brief/checkpoint, not an append-only history. Keep earlier evidence explicitly historical if retained; do not invent unsupported fields.

`guide` does not model live launch state or detect whether `nextChange` is implemented. Its setup suggestion is not a demand to redo completed setup: reconcile it with verified setup, responding services and outstanding acceptance. Use the validation skill for current evidence and reporting.

## Storage and failure handling

The command saves version-1 state in `.sql-apps/guide.json`, including the canonical checkout path, source fingerprint, timestamp and brief. It uses a lock and atomic replacement.

Brief/state files must be regular files at most 16 KiB. Invalid JSON, oversized input, unexpected fields, copied checkout state and symlink state are rejected explicitly rather than reset or overwritten. A concurrent writer must finish before retrying; do not automatically remove its lock.

Keep credentials and actual application records out of the brief. Preserve local state when moving or troubleshooting the checkout.

The plugin equivalents are `guide` and `guide-save "<absolute-brief-path>"`; see [runtime binding](copilot-plugin.md#runtime-binding-and-direct-checks).
