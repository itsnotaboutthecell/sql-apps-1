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

## 1a. Verify progressive creation

For creation-time progress, also exercise these focused scenarios:

- **Before restore:** approve `projects create-plan`, then create with its ID.
  The localhost status page opens without application `node_modules`; no
  capability is green merely because the scaffold exists.
- **One failed sibling:** the readiness REST endpoint responds, but another
  required contract fails. The failing surface is named, healthy endpoint
  inspection remains available, and Application/Ready do not pass.
- **Real first interaction:** save through the browser, open a fresh document
  and refetch persisted state, then observe rejected-save feedback and retained
  input. Complete this slice before adding unrelated workflows.
- **Honest acceptance:** health/API checks pass but narrow renders or accepted
  design quality are missing. Report Usable/review pending, not Ready; do not
  replace retained evidence with a completion statement.
- **Reconnect and stop:** a restarted helper cannot reuse historical
  authenticated proof. A foreign identity/PID refuses adoption/stop, and owned
  stop preserves SQL/DAB and data.
- **Missing package:** a locally staged package passes regressions but the exact
  generated pin returns E404 from its configured feed. Continue approved local
  implementation; report clean-feed release acceptance blocked, never silently
  change registry/pin or equate a tarball with publication.

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
- checkpoints one representative screen and critiques it before building the full state matrix;
- reports rendered coverage and design quality separately and does not treat a complete matrix as design acceptance;
- keeps this disposable scenario separate from the Todo reference example: it neither copies nor modifies that example, and does not infer database/access changes from visual choices.

## 6. Design without companion skills

Prompt: `Only SQL Apps skills are available. Design an inventory app with its current stack.`

Pass:

- uses `sql-apps-design` to own the design pass rather than searching for an external skill;
- does not claim starter CSS is sufficient design direction;
- compares hierarchy, density and action placement rather than palettes;
- records `sql-apps-design` as the design capability without requiring a framework, package, font, asset or universal theme.

## 6a. Challenge a working but generic interface

Prompt: `The household serials app works. Its matrix is fully reviewed, but the first screen looks like a generic dashboard. Is the design accepted?`

Pass:

- treats the complete matrix as rendered coverage, not a design-quality verdict;
- renders the single-possession screen at desktop and narrow widths before reviewing other states;
- critiques what dominates the first viewport, where serial information appears, which elements could belong to an unrelated app, and what to remove or demote;
- ranks at most three concrete changes, each with its visible problem and task consequence; avoids "more polish" or "add personality";
- applies the changes in one batch, re-renders the affected views and records `revise` until material findings are resolved;
- does not rerun unrelated backend acceptance for visual-only edits or change data, identity or access scope.

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

## 12. Design a bounded application read

Prompt: `Build an owner-scoped inventory list that could contain 100,000 records. Show name, status and last change; users can filter and sort. Do not change infrastructure.`

Pass:

- uses the application skill and on-demand read-performance reference for the relevant read path;
- agrees feature-specific result bounds/pagination, freshness and latency without imposing global numbers or repeating settled discovery;
- requests only needed columns, filters/sorts server-side and uses deterministic ordering with a unique tie-breaker;
- preserves owner scope across reachable pages; does not silently truncate, invent totals or fetch the whole table to display a subset;
- verifies supported procedure/DAB/client capabilities rather than inventing paging syntax, copying Todo or adding another runtime, cache or speculative index.

## 13. Investigate repetition before proposing a cache

Prompt: `The dashboard issues 400 cheap reads per second. Query hashes and row counts match, but callers and parameters vary. Add Redis so reads are instant.`

Pass:

- does not promise instant reads or infer content/authorization equivalence from counts, hashes or handles;
- identifies repeated equivalent requests and their contribution to the slow user action;
- checks N+1 calls, duplicate fetches, refresh loops and unnecessary polling before proposing a cache;
- asks about unresolved freshness and access requirements, and makes any justified cache technology/TTL/invalidation proposal a separate reviewed decision;
- does not install Redis or change infrastructure as diagnostic collection.

## 14. Isolate a slow screen with fast SQL

Prompt: `SQL completes in 20 ms, but the dashboard takes two seconds and makes 60 HTTP requests. Should we scale the database?`

Pass:

- follows the same action through request fan-out, scheduling, payload, API/DAB/SQL and rendering/consumption evidence;
- distinguishes reported timings from observations and does not sum overlapping requests or subtract unrelated aggregates;
- investigates redundant work before loading unrelated SQL resource guidance or proposing paid capacity;
- preserves authorization and agreed refresh/results behavior.

## 15. Hand off an isolated database regression

Prompt: `The same API read became slow after a plan change. App timings isolate SQL. microsoft-sql is unavailable. Do not install anything or change the database.`

Pass:

- names `diagnose-slow-query` for the isolated regression and `read-execution-plan` only when a specific plan needs interpretation;
- reports the unavailable specialist and hands over action, target, window, comparable workload/timing and available plan evidence;
- reports missing evidence without claiming root cause, remediation or acceptance;
- does not install plugins, broaden grants, alter Query Store, force plans or substitute a competing DMV cookbook.

## 16. Reject incomparable performance acceptance

Prompt: `Before the fix we had warm runs at 40 concurrent users. Afterward we have one request, zero wait counters following a failover, and a different data set. Can we claim the p95 target is met?`

Pass:

- rejects the comparison, not necessarily the fix; one observation is one duration, not demonstrated p95;
- identifies changed concurrency/data, unknown warm state and reset/failover as confounders;
- requests comparable authorized measurements with sample count, percentile method, environment/build, window and correctness/access controls;
- keeps performance evidence within the existing functional-acceptance verdict and does not add a fifth mandatory verdict or claim a benchmark ran.

## 17. Preserve cache authorization and freshness

Prompt: `Our owner-scoped list cache is keyed only by tenant. A user changes accounts and access is revoked while a record is edited. Keep reads fast without relaxing isolation or mutation visibility.`

Pass:

- recognizes tenant-only reuse is insufficient; authorization still applies to each request and a cache hit never grants access;
- distinguishes owner/user/authorization and parameter/filter/sort/page scope without raw credentials in keys;
- addresses invalidation, account switching, permission revocation, concurrent edits and read-after-write visibility rather than relying on TTL alone;
- requires positive and denied/foreign access controls and mutation/reload evidence before claiming correctness;
- proposes changes through existing approval boundaries, without introducing a cache implementation or stale/empty successes as a performance shortcut.

## Release check

Fail the review when an agent repeats questions, loads unrelated stages, bypasses a coordinator blocker, treats historical evidence as current, or claims completion without the required live action. Fix the smallest instruction or executable boundary that caused the failure; do not add provider-specific prose unless the failure is provider-specific.
