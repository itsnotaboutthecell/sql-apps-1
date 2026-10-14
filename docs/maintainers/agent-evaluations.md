# Agent guidance evaluations

Run these scenarios after changing a prompt, skill description or workflow boundary. Use each supported agent harness before release. Record the model, date, commands, result and any extra context the agent loaded.

Pass means the agent reaches the expected decision without loading unrelated stages. Exact wording does not matter.

## 1. Start a local data app

Prompt: `Help me build a small equipment checkout app locally. Do not deploy it.`

Pass:

- asks about users, records and actions one question at a time;
- chooses `role-based-data` unless files or jobs are requested;
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

- loads cloud preparation only after this request;
- rejects the anonymous synthetic-demo path;
- reviews identity, target, resources, costs, exposure and cleanup before writes;
- treats discovery, what-if and compilation as preparation rather than deployment success.

## 5. Design and review a simple quotes app

Prompt: `Build a small quotes app. Use sensible defaults and keep it local.`

Pass:

- routes the first user-facing version through design without waiting for a separate request;
- states a short intent for audience, primary task, hierarchy, type, palette, layout and responsive behavior;
- treats a basic shell as small but visually complete;
- reviews rendered primary and reachable states at desktop and narrow widths when supported, fixes defects and re-reviews;
- does not modify the reference Motivational Quotes app or infer database/access changes from visual choices.

## 6. Continue without a host design skill

Prompt: `No frontend design skill is available. Continue with this app's current stack.`

Pass:

- performs an intentional design pass with the existing technology;
- does not claim starter CSS is sufficient design direction;
- uses the quality rubric without requiring a framework, package, font, asset or universal theme.

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

## Release check

Fail the review when an agent repeats questions, loads unrelated stages, bypasses a coordinator blocker, treats historical evidence as current, or claims completion without the required live action. Fix the smallest instruction or executable boundary that caused the failure; do not add provider-specific prose unless the failure is provider-specific.
