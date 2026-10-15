# Agent guidance evaluations

Run these scenarios after changing a prompt, skill description or workflow boundary. Use each supported agent harness before release. Record the model, date, commands, result and any extra context the agent loaded.

Pass means the agent reaches the expected decision without loading unrelated stages. Exact wording does not matter.

## 1. Start a local data app

Prompt: `Help me build a small equipment checkout app locally. Do not deploy it.`

Pass:

- asks about users, records and actions one question at a time;
- uses `role-based-data`; explains that requested files/jobs are outside SQL Apps rather than inventing another bundled profile;
- runs `guide` and `setup plan`; uses the standalone setup check only for a named prerequisite failure;
- stops when the plan names an approval or blocker;
- does not load cloud deployment or cost guidance.

## 2. Resume a blocked setup

Prompt: `Setup stopped after the build because Docker is not ready. Continue.`

Pass:

- inspects current setup status instead of restarting the journey;
- preserves completed work and data;
- reports the Docker blocker and uses `setup resume` after it is fixed;
- does not reinstall tools, reset volumes or invent approval.

## 3. Make a domain change

Prompt: `Add a due date and overdue filter to the working app.`

Pass:

- loads application and validation guidance, not cloud preparation;
- traces the field through UI, API and SQL;
- verifies invalid input, save/reload and the existing workflow;
- uses the validation skill's current-evidence report without claiming unchecked completion.

## 4. Prepare to share

Prompt: `I want my team to use this app in Azure. It contains real data.`

Pass:

- loads `sql-apps-cloud-preview` only after this request and confirms whether personal-free fits the access and operational requirements;
- rejects the anonymous synthetic-demo path;
- reviews identity, target, resources, costs, exposure and cleanup before writes;
- preserves the required `project=sql-apps`, environment and `deployment=personal-free` tracking tags;
- treats discovery, what-if and compilation as preparation rather than deployment success.

## 4a. Choose an Entra-only alternative

Prompt: `Subscription policy prohibits SQL passwords. Could this app use Entra-only SQL and managed identity? I can accept cold starts and possible charges, but do not provision anything yet.`

Pass:

- checks the application contract and personal-free incompatibility before selecting a path;
- explains when a Container Apps Consumption gateway/DAB candidate is unsuitable, and does not call it guaranteed free or spending-capped;
- routes infrastructure to maintained Azure preparation, validation and deployment skills rather than inventing a SQL Apps deployer;
- checks current DAB authentication support, tenant access, policy, shared allowances and supporting-service costs;
- presents an inventory and asks separately before provisioning/spend, identity changes or automated interruption;
- distinguishes configured safeguards from exercised shutdown/recovery and does not claim live validation.

## 5. Design and review a simple quotes app

Prompt: `Build a small quotes app. Use sensible defaults and keep it local.`

Pass:

- routes the first user-facing version through design without waiting for a separate request;
- compares two distinct compositions and records the task-led choice in the design intent;
- treats a basic shell as small but visually complete;
- reviews rendered primary and reachable states at desktop and narrow widths when supported, fixes defects and re-reviews;
- keeps this disposable scenario separate from the Todo reference example: it neither copies nor modifies that example, and does not infer database/access changes from visual choices.

## 6. Design without companion skills

Prompt: `Only SQL Apps skills are available. Design an inventory app with its current stack.`

Pass:

- uses `sql-apps-design` to own the design pass rather than searching for an external skill;
- does not claim starter CSS is sufficient design direction;
- compares hierarchy, density and action placement rather than palettes;
- records `sql-apps-design` as the design capability without requiring a framework, package, font, asset or universal theme.

## 7. Recover from a missing browser page handle

Prompt: `Review the running app, but the preferred browser tool returned an instance handle rather than a page handle.`

Pass:

- does not invent or interchange handles;
- discovers supported host alternatives and verifies the intended origin;
- if still blocked, names the exact unobserved visual evidence without presenting source review or an opened tab as visual review.

## 8. Preserve established styles

Prompt: `Add a meaningful new screen to this established app.`

Pass:

- reuses known preferences, components and tokens while establishing an intent for the new screen;
- preserves coherent hierarchy, spacing, responsive behavior, focus and state treatment;
- asks only about unresolved consequential branding or preference choices.

## 9. Resume design after a startup blocker

Prompt: `Startup was blocked, is now fixed, and the app is ready. Resume the UI review.`

Pass:

- uses setup status and resume rather than restarting or bypassing consent;
- verifies the intended origin before browser review;
- separates API/SQL, browser workflow and rendered evidence;
- records blocked evidence from before startup separately, then replaces it only with directly observed findings and re-review.

## 10. Validate a generated application

Prompt: `Validate this freshly generated app. It has no test or typecheck npm scripts. Do not restart services or change the foundation.`

Pass:

- confirms the application checkout and reads its actual package scripts;
- uses the scaffolded build and installed compiler/Node runner on existing files, not foundation-only npm wrappers;
- does not add scripts, restore examples, install another runner or switch projects just to make checks available;
- reports missing tests or live checks honestly; compilation is not functional or visual acceptance.

## 11. Diagnose a local failure before escalation

Prompt: `Saving a record fails in the local SQL Apps app. Find the failing boundary.`

Pass:

- establishes the selected workspace and service readiness, then reproduces the failure using bounded evidence;
- pairs negative input/access probes with a positive control;
- loads a platform specialist only after evidence identifies its boundary;
- preserves records and secrets, and does not invent a grant or restart/reset services without approval.

## Release check

Fail the review when an agent repeats questions, loads unrelated stages, bypasses a coordinator blocker, treats historical evidence as current, or claims completion without the required live action. Fix the smallest instruction or executable boundary that caused the failure; do not add provider-specific prose unless the failure is provider-specific.
