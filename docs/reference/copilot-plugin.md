# Install and use the Copilot plugin

The SQL Apps plugin adds project-specific skills to GitHub Copilot. It does not require publication, a Git push, an Azure subscription, or another platform plugin. Copilot itself still requires its normal account/access and network connectivity; the local application does not call cloud APIs after prerequisite downloads.

## Install from your checkout

Prerequisites: Node 22/24 and the GitHub Copilot CLI on PATH, using the same Copilot profile as your App. Start with [first-time setup](../guides/getting-started.md) if tools are missing. Plugin installation does not require npm dependency restore or runtime compilation; its launcher can diagnose setup before the application is built.

```powershell
Set-Location "C:\git\sql-apps"
npm run plugin:check
npm run plugin:install
```

The installer:

1. Validates the dedicated plugin bundle and marketplace paths.
2. Registers this checkout as the local `sql-apps-skills` marketplace.
3. Installs/enables `sql-apps@sql-apps-skills` and verifies actual discovery of all six skills.
4. Binds the runtime to this checkout in `~/.copilot/sql-apps-local.json` (or `COPILOT_HOME` if set). The binding stores only a version and absolute directory, no secrets.

Rerunning the installer is safe for the same checkout/profile. It refuses to replace a conflicting marketplace, differently sourced plugin, or runtime binding. Unrelated existing plugins are not disabled or modified.

Only [plugins/sql-apps](../../plugins/sql-apps) is the installed package: manifest, six focused skills, an MIT license and a Node launcher. Runtime code, `.sql-apps` credentials, dependencies and SQL volumes stay outside the package. **Use this local marketplace, not a direct repository-root installation**, which is the older compatibility package.

## Install companion plugins for cloud work

The SQL Apps plugin is enough for local setup, application work and validation. It does not install or update other plugins. Before planning or operating a cloud deployment, install the maintained plugins that own the workflows referenced by SQL Apps:

| Plugin | Why SQL Apps uses it |
| --- | --- |
| `microsoft-sql@microsoft-sql` | Azure SQL provisioning, identity, schema, Data API builder, connection and database diagnostics skills such as `build-app-on-azure-sql`, `entra-id-auth` and `dab-rest-and-graphql`. |
| `azure@azure-skills` | Azure onboarding, preparation, validation, deployment and production diagnostics. |
| `azure-cost@azure-skills` | Account-aware estimates, actual cost analysis, optimization and governance. |

Run these slash commands in GitHub Copilot CLI or the Copilot App:

```text
/plugin marketplace add microsoft/microsoft-sql
/plugin install microsoft-sql@microsoft-sql
/plugin marketplace add microsoft/azure-skills
/plugin install azure@azure-skills
/plugin install azure-cost@azure-skills
```

Marketplace registration is safe to repeat when it already points to the same source. Restart the App or begin a fresh session after installation, then use `/plugin list` to verify that all four plugins, including `sql-apps@sql-apps-skills`, are enabled. See the current [Azure plugin catalog](https://learn.microsoft.com/azure/developer/azure-skills/plugins/) because specialized Azure plugins can change independently.

These companion plugins are not prerequisites for local-only development. Install them when you choose to share, estimate, deploy or diagnose the app in Azure.

## Use the GitHub Copilot App

Restart the App or create a **fresh session** after installation. In **Customize -> Plugins**, look for **sql-apps**, marketplace **sql-apps-skills**, version **0.2.2**, enabled. Its skills should appear under **Skills**:

| Skill | Example prompt |
| --- | --- |
| `sql-apps-local` | Start SQL Apps locally; reuse it if it is already running. |
| `sql-apps-diagnostics` | Check SQL Apps local service status without changing anything. |
| `sql-apps-validation` | Run SQL Apps unit tests and typecheck; do not restart services. |
| `sql-apps-cloud-preview` | Assess whether personal-free fits; hand separately planned architectures to maintained Azure skills and explain their cost, access and interruption trade-offs. |
| `sql-apps-application` | Build a domain-specific application without copying the Todo example; verify source, build, API and database boundaries. |
| `sql-apps-design` | Apply intentional visual direction to every new user-facing app and meaningful UI change, then review its rendered desktop and narrow-width experience. |

The `sql-apps-design` skill owns design direction and rendered review in the app's
existing stack; no companion skill is required. It compares two compositions and
retains SQL Apps requirements for real account/access states and truthful loading,
empty, error, saving, success, and disabled states. SQL, identity, and runtime
decisions remain in `sql-apps-application`.

`sql-apps-local` owns lifecycle and approval. `sql-apps-validation` selects checks
from the actual target package, distinguishing generated apps from foundation
maintenance, and owns evidence collection and the four-verdict report.
Application and cloud skills hand off to that contract rather than duplicating it.

Invoke a skill explicitly from the App's skill picker/slash completion if natural-language discovery picks another plugin instead. Ask for **SQL Apps** and confirm the **sql-apps-skills** marketplace. The plugin does not embed the browser UI; use the startup-reported origin (`http://127.0.0.1:18080/` in fixed-port mode) for the actual application.

### Keep SQL Apps work scoped to its project

SQL Apps is a standalone project with its own runtime and workflow. Other plugins can remain installed and enabled.

For SQL Apps work, explicitly select `sql-apps-application` or the matching `sql-apps-*` skill and confirm the intended application directory. Use project-owned commands and do not choose a directory from another plugin or old conversation. An unrelated project is not an invitation to convert it into SQL Apps.

Plugin availability is shared within the Copilot profile; these instructions clarify routing, but do not provide host-enforced skill isolation. If a conversation mixes unrelated workflows, start a fresh SQL Apps session with a prompt such as: **"Use sql-apps-application to build a standalone SQL Apps app in my confirmed project folder. Keep unrelated projects and plugins unchanged."** Existing conversations can retain old instructions and names even after a plugin changes.

For beginners: **"Guide me through SQL Apps setup one step at a time. Ask before installing tools, downloading dependencies or changing my system. Do not deploy to Azure."** The local skill reads the OS-specific guide, runs setup checks, offers native approved installs and pauses for human-only license/restart/credential steps. No blanket installation or license approval is implied by enabling the plugin.

For building an app: **"Help me describe, run and change a useful SQL Apps app locally. Ask about its users, information and actions, not cloud architecture. Sharing is optional."** Follow the [build walkthrough](../guides/build-your-app.md). Use `guide` to recover saved decisions and `guide-save <absolute-brief-path>` to save an agreed brief. Historical evidence never replaces live acceptance or authorizes installations/cloud writes.

For repeated local use, see [remembered permissions](local-consent.md). `setup approval --profile role-based-data --workspace <base-port>` shows the single local approval (restore, build, workspace, startup, SQL terms) and `setup approve ... --approval <id>` records it after explicit human approval. The launcher's pre-build `consent-plan|consent-status <operation> [selection]`, `consent-grant|consent-grant-once <absolute-plan.json>`, `consent-terms <absolute-reviewed-document>`, `consent-revoke [scope|terms]` and `consent-run <operation> [selection]` remain for individual scopes and target the selected application checkout. Consult matching grants before asking again.

The local marketplace loads from disk (`source: live` in CLI output). Edit the bundled skills or launcher, run `npm run plugin:check`, then start a fresh session/restart to load changes. No Git push or plugin update is needed for this directory-backed source. After TypeScript runtime changes, separately build/restart the application as documented.

Keep three paths distinct: **loaded skill source** (the actual marketplace/skill location), **installed launcher** (resolved relative to that skill), and **application checkout** (selected by `home`/`SQL_APPS_HOME`). Exported skill copies in another application are not automatically active. Editing them does not change the installed plugin; confirm the loader source with discovery output before editing and reload a fresh session afterward. Changing the runtime home does not change loaded instructions.

If the App does not show the plugin, check the profile used to launch it. `COPILOT_HOME` can select a different configuration directory. Register the local checkout through the App's marketplace controls if available, or launch the App from the same configured CLI/profile (`copilot app`). Do not copy or overwrite the App's settings. Verify discovery with:

```powershell
copilot plugin list --json
copilot skill list --json
copilot plugin marketplace browse sql-apps-skills
```

The installer verifies the CLI loader when you run it. Check the visible App session/skill picker in your actual profile too; an already-open session may retain old capabilities.

## Runtime binding and direct checks

For a connected first-run or return journey, the same launcher exposes
`setup plan|status|run|resume` before dependency restore or build. For example:

```powershell
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" setup plan --json
```

`role-based-data` is the only profile, so `--profile role-based-data` is
optional. See [Setup coordinator](setup.md) for
workspace selection, approvals, installation plans and continuation. `setup`
forwards arguments literally to the bound checkout's coordinator and retains
source/binding checks. It does not change loaded skills, grant permissions,
install another assistant, generate domain screens or deploy.

The launcher resolves the application runtime in this order:

1. Explicit `SQL_APPS_HOME` environment variable.
2. Current directory or an ancestor that is a validated SQL Apps project.
3. Active project in `~/.sql-apps/projects.json`.
4. Installer-created foundation binding under `COPILOT_HOME` / `~/.copilot`
   for compatibility and project creation.

Invalid explicit paths/bindings fail; they never silently fall back. The
installer binding identifies the trusted foundation that supplies the project
factory. It does not require applications to live beside that checkout.

Create and switch projects through the plugin:

```powershell
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" projects root
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" projects create "Equipment Checkout"
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" projects list
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" projects open "C:\path\to\project"
```

`projects create` writes under `%USERPROFILE%\SqlAppsProjects` by default,
creates an independent Git repository, excludes plugin/example implementation
files and refuses an existing destination. See [Manage projects](projects.md).

```powershell
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" home
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" workspace-check
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" guide
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" status
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" setup-check
```

`workspace-check` is dependency-free and read-only. It reports the active checkout, effective binding and selection source, runtime contract, selected application, source-content fingerprint, Git evidence when available, and build provenance. Equal package versions or Git commits do not prove that two worktrees contain the same uncommitted source. ZIP downloads work without Git; the report explicitly marks Git evidence unavailable.

`guide` is also dependency-free and available before the runtime is built. It returns JSON with the four stages, saved brief, suggested next action and explicitly historical progress; it does not probe live services. `guide-save "<absolute-brief.json>"` validates and saves the agreed brief in `.sql-apps/guide.json` in the bound checkout. Both enforce the same runtime-home mismatch checks. Source changes flag saved progress for local re-verification. See [the brief contract](guide.md); do not include credentials or actual data.

The guide also introduces cost awareness progressively; optional saved `costPreference` is not spending approval. The cloud-preview skill confirms the `role-based-data` application first. Azure estimates and spend analysis route to the Azure Cost plugin. The launcher exposes the [role-based-data](role-based-data.md) `app`/`serve` commands and their `role-based-app`/`role-based-serve` aliases. Budgets are alerts, not spending caps. See [costs and paid growth](../guides/costs.md).

If the active checkout differs from the installed binding, runtime execution is refused until you explicitly select the intended home. This also applies when the active worktree lacks the uncommitted foundation. Review the report, then select one checkout for this terminal/session:

```powershell
$env:SQL_APPS_HOME = "C:\git\your-intended-checkout"
node "C:\git\sql-apps\plugins\sql-apps\scripts\sql-apps.mjs" workspace-check
```

This does not change the global binding, transfer source, or authorize copying files between worktrees. `home` and `workspace-check` remain available to diagnose mismatches. Runtime commands also require matching build provenance: `npm run build` records the source and compiled-artifact fingerprints and refuses to certify a build if source changes during compilation. Missing, stale, copied or tampered artifacts require a rebuild in the selected checkout. Source/build provenance is not live service ownership or cloud acceptance.

`status` probes only loopback gateway liveness/data readiness and DAB HTTP health, with bounded timeouts and a nonzero exit on failure. It is read-only and does not create a development session or expose credentials. It does not certify SQL authorization or the application's required role. The launcher delegates local commands directly to the existing compiled CLI with the checkout as cwd, without shell interpolation; it never installs a second runtime.

`setup-check` instead runs the dependency-free diagnostic in the bound checkout and prints JSON before runtime compilation. An optional second argument selects an existing SQL container; it does not initialize it. Action-needed reports exit nonzero, including a healthy gateway whose ownership must still be confirmed. Do not mistake that for permission to restart it.
It reports selected workspace mode/ports/origins and requires matching workspace labels for isolated occupied Docker ports. For a new checkout, use `workspace-plan` after building, review its proposal, and approve `workspace-init <base-port>`; use explicit `workspace-init legacy` to preserve an existing stack. The plugin passes omitted SQL arguments through to the workspace's derived default, not the global legacy container.

When needed:

```powershell
Set-Location "C:\git\sql-apps"
npm run build
node plugins\sql-apps\scripts\sql-apps.mjs app
```

The `app` command remains running until stopped. If healthy services are already running, reuse the browser instead of launching another gateway. Alternate SQL containers can be supplied as the second argument to applicable local commands.

`recover-sql` is an explicitly approved isolated-SQL repair, not an automatic startup fallback. It preserves the stopped container's image version, credentials and scoped data; it rejects running/external/legacy or mismatched resources. If interrupted, resume it rather than deleting its sensitive recovery state. See [local-development.md](local-development.md) before use.

## Safety and boundaries

- This plugin adds skills, not MCP tools, custom UI, or another authentication layer.
- No automatic startup hooks or cloud deployment commands are added.
- Agents still use normal host approval/task controls; installing a plugin does not grant blanket tool permissions.
- Writing records through the app or running SQL acceptance against shared data mutates or reads that data; confirm the target workspace first.
- `app-test` starts its own approved stack and checks that Development Alice is admitted and Development Bob receives 403. Do not run it against a workspace another user is relying on.
- Preserve owner checks, production authentication and unrelated/user-owned containers.
- Cloud preparation requires separate authorization for mutations. The existing Azure template contains billed resources.

## Uninstall

```powershell
copilot plugin uninstall sql-apps@sql-apps-skills
copilot plugin marketplace remove sql-apps-skills
```

These operations remove only this plugin/marketplace registration, not the application checkout or SQL data. The small `sql-apps-local.json` runtime binding remains for future reinstalls; remove that exact file manually if no longer wanted. Do not remove the Copilot profile directory or unrelated plugins.

## Replace a pre-rebrand installation

Review [migration notes](../maintainers/naming-transition.md). Inspect `copilot plugin list --json` and `copilot plugin marketplace list --json`, then disable/uninstall only the old development plugin and remove its marketplace registration. Install using the current steps above and explicitly select the new `sql-apps-local.json` binding; old bindings are not migrated.

Do not remove other plugins, the Copilot profile, old credentials or persistent data.
