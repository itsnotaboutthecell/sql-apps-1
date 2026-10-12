# Manage SQL Apps projects

SQL Apps keeps its foundation/plugin source separate from applications. Each
application is an independent folder and Git repository under a configurable
user-level project root.

## Default location

The default root is:

```text
Windows: %USERPROFILE%\SqlAppsProjects
macOS/Linux: ~/SqlAppsProjects
```

Project registration is stored in `~/.sql-apps/projects.json`. The registry
contains paths and display metadata only—no credentials or application data.
Project-specific setup, consent and workspace state remains in each project's
`.sql-apps` directory.

## Create and switch projects

From the SQL Apps foundation checkout:

```powershell
npm run projects -- create "Equipment Checkout"
npm run projects -- list
npm run projects -- open "C:\path\to\existing-project"
```

The installed plugin exposes the same operations:

```powershell
node "<installed-sql-apps-plugin>\scripts\sql-apps.mjs" projects create "Equipment Checkout"
node "<installed-sql-apps-plugin>\scripts\sql-apps.mjs" projects list
node "<installed-sql-apps-plugin>\scripts\sql-apps.mjs" projects open "C:\path\to\existing-project"
```

`create` derives a lowercase hyphenated folder name, creates the configured
root when necessary, and refuses to write when the destination already exists.
It copies only application runtime inputs, removes plugin/example implementation
files, writes project-specific manifests, initializes Git and creates the
initial commit. A failed scaffold is removed before registration.

`open` validates an existing SQL Apps project, registers its canonical absolute
path and makes it active. Running a plugin command from inside another
registered project uses the current directory first. `SQL_APPS_HOME` remains an
explicit per-process override.

## Change the root

Set an absolute root before creating new projects:

```powershell
npm run projects -- root "D:\SqlAppsProjects"
```

Changing the root does not move or delete existing projects. Registered
projects remain available until their folders are deliberately moved or
removed; use `open` on the new absolute path after a manual move. The project
root cannot be the foundation checkout or one of its descendants, because a
scaffold cannot safely copy itself into its own source tree.

## Boundaries

- The foundation binding identifies the trusted scaffold/tool source.
- Generated projects are not Git worktrees of the foundation.
- Project creation does not restore dependencies, start services, accept terms
  or deploy to Azure.
- Each project owns its `.git`, `.sql-apps`, source, schema and runtime state.
- Folder collisions and invalid project registries fail explicitly; SQL Apps
  never merges a scaffold into an existing directory.
