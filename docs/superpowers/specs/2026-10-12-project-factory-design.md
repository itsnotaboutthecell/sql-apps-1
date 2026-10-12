# SQL Apps Project Factory Design

## Summary

SQL Apps will create and manage independent application repositories outside the
SQL Apps foundation and plugin source. The default project root is:

```text
%USERPROFILE%\SqlAppsProjects
```

Users may persist a different absolute root. New applications are always created
as direct children of that root. Existing applications may be registered from
other locations.

The installed plugin is the dependency-free project factory. Generated projects
contain only application source and configuration and pin a separately versioned
SQL Apps tooling package for build, setup, local runtime, validation, and
deployment commands.

## Goals

- Keep user applications separate from SQL Apps plugin and foundation source.
- Support many independent projects without Git worktree coupling.
- Make project creation safe, deterministic, offline-capable, and atomic.
- Give every generated project independent Git history and tooling versioning.
- Let users discover and reopen projects across sessions.
- Preserve current-directory authority for project operations.
- Reuse the existing `role-based-data` and `foundation` capability profiles.

## Non-goals

- Installing dependencies during project creation.
- Starting SQL, containers, services, or browser processes during creation.
- Deploying to Azure during creation.
- Moving or deleting existing worktrees automatically.
- Providing rename, archive, or delete project operations in the first release.
- Copying the foundation repository or its Git history into generated projects.
- Using the global project registry to select an implicit active project.

## Architecture

### Project factory

The installed SQL Apps plugin exposes dependency-free project commands:

```text
sql-apps projects create <display-name> [--starter data|files-jobs]
sql-apps projects list [--json]
sql-apps projects open <name-or-path> [--json]
sql-apps projects root [--json]
sql-apps projects root set <absolute-path>
```

The plugin remains bound to the SQL Apps tool installation. It is not rebound to
an application checkout when a project is created or opened.

The factory consists of three isolated units:

1. **Project store**: reads and atomically updates user-level root and registry
   state.
2. **Project scaffolder**: validates names and paths, expands a bundled starter
   into a staging directory, validates the result, and atomically publishes it.
3. **Starter catalog**: exposes immutable bundled starter metadata and files
   through a strict manifest.

These units do not import the application runtime, container orchestration, or
cloud deployment modules.

### Generated project

Each generated project is an independent repository:

```text
%USERPROFILE%\SqlAppsProjects\
  equipment-checkout\
    .git\
    .gitignore
    .sql-apps-project.json
    application.json
    package.json
    package-lock.json
    public\
    src\
    sql\
    dab\
    tests\
```

The exact domain files differ by starter, but every project contains:

- a versioned project manifest;
- a package manifest and lockfile pinning SQL Apps tooling;
- project-local application source and configuration;
- tests for its starter contract;
- a `.gitignore` entry for `.sql-apps/`, build output, dependencies, secrets,
  and other generated state.

It does not contain the plugin, foundation-only services, examples, unrelated
tests, the foundation Git history, dependency folders, build output, credentials,
or runtime state.

Project commands resolve the application from the current directory or one of
its ancestors. The global registry is for discovery only and never overrides the
current directory.

### Tooling package

The existing setup, build, local runtime, validation, and deployment entry points
move behind the separately versioned `@microsoft/sql-apps` tooling package. A generated
project pins an exact compatible version in its package manifest and lockfile.
The project invokes package-local commands through npm scripts.

The plugin factory and project tooling package may ship from the same repository,
but they have separate contracts:

- the factory creates and discovers projects without project dependencies;
- the tooling package operates only inside a validated generated project;
- changing or upgrading one project's tooling does not modify the plugin or
  another project.

## User-level state

### Location

Project-factory state is stored outside Copilot and application state:

- Windows: `%LOCALAPPDATA%\Microsoft\SqlApps\projects.json`
- macOS: `~/Library/Application Support/Microsoft/SqlApps/projects.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/microsoft/sql-apps/projects.json`

It is not stored inside the foundation checkout or any application. The state
contains no credentials or application records.

### Schema

The versioned state contains:

- configured project root, if different from the default;
- registered projects with stable project ID, canonical path, display name,
  slug, starter, and last-observed manifest version;
- state version.

The default root is computed from the current user profile and is not persisted
until the user sets an override.

State files must be bounded regular files. Reads reject malformed or unknown
fields. Writes use the existing process-lock and atomic-replacement patterns.

There is no global active-project property.

## Root management

`projects root` reports:

- effective absolute root;
- whether it comes from the default or a persisted override;
- whether the directory currently exists.

`projects root set <absolute-path>`:

1. requires an absolute path;
2. canonicalizes the existing nearest parent without creating project content;
3. rejects a filesystem root, the SQL Apps foundation/plugin source, a project
   directory, a symlink, or a reparse-point root;
4. creates the root only after validation and explicit command execution;
5. persists the canonical root atomically.

Changing the root does not move, unregister, or rewrite existing projects.

## Project naming

Creation accepts a human-readable display name and derives a slug:

- Unicode letters and numbers are normalized for a stable filesystem name;
- uppercase becomes lowercase;
- runs of separators become one hyphen;
- leading and trailing separators are removed;
- the result must be non-empty and no longer than the documented limit;
- Windows reserved device names are rejected;
- path separators, control characters, trailing dots, and trailing spaces are
  rejected before slugging.

The final path is `<project-root>\<slug>`. The factory refuses creation if that
path already exists, even when it is an empty directory. It never merges into or
overwrites an existing destination.

## Starter catalog

The first release includes two bundled starters:

| Starter | Existing profile | Purpose |
| --- | --- | --- |
| `data` | `role-based-data` | Browser, DAB, and SQL application with role-authorized domain procedures. |
| `files-jobs` | `foundation` | Application that also needs files, queues, Functions, or background jobs. |

Each starter has a strict manifest containing:

- starter ID and scaffold version;
- compatible tooling package version;
- source file list and SHA-256 digest for every file;
- required output paths;
- text files eligible for token replacement;
- allowed tokens;
- profile and capability metadata.

Templates are packaged with the plugin so creation works without network access.
Only manifest-declared UTF-8 text files receive token replacement. Binary files,
unknown tokens, undeclared files, links, and paths escaping the template root
fail validation.

The Todo reference is not a starter.

## Creation flow

For `projects create "Equipment Checkout" --starter data`:

1. Load and validate user-level project state.
2. Resolve and validate the configured root.
3. Validate the display name and derive `equipment-checkout`.
4. Reject an existing final destination.
5. Load and verify the selected bundled starter and checksums.
6. Create a uniquely named staging directory as a direct child of the same
   project root.
7. Copy declared files without following links.
8. Replace declared tokens, including display name, slug, stable project UUID,
   starter, profile, scaffold version, and tooling package version.
9. Validate the generated project manifest and all required paths.
10. Initialize Git in the staging directory. If `git init` fails or Git is not
    installed, fail before publication and clean the owned staging directory.
11. If Git user name and email are available, add all files and create an
    initial commit. If identity is missing or the commit fails, retain the
    initialized repository and record an actionable warning.
12. Atomically rename the staging directory to the final destination.
13. Register the canonical project path idempotently in user-level state.
14. Return the absolute path, project metadata, Git result, and explicit next
    setup command.

Creation performs no package restore, build, container action, SQL change,
service startup, browser launch, cloud operation, or editor launch.

### Atomicity and cleanup

Staging and final directories are on the same filesystem so publication can use
an atomic rename. The final directory does not become visible until project
validation succeeds.

On failure before publication, the factory removes only the exact staging
directory created by that operation. Cleanup rejects an unexpected canonical
path and never recursively removes the project root, an existing project, or a
path containing unresolved variables or wildcards.

If registration fails after publication, the project is retained and the result
states that registration remains incomplete. Git initialization cannot fail
after publication because it is a pre-publication requirement. A missing Git
identity or failed initial commit publishes an initialized but uncommitted
repository with a warning. The factory never deletes a successfully published
project to make metadata look transactional.

Concurrent creation of the same slug results in at most one published project.
The losing operation reports a collision and cleans only its own staging
directory.

## List and open behavior

### List

`projects list` combines:

- registered project records;
- valid direct-child projects discovered under the effective root.

It does not recursively scan the user profile or arbitrary drives. Each result
reports one of:

- `ready`: path and manifest agree;
- `unregistered`: valid direct child not yet in the registry;
- `missing`: registered path no longer exists;
- `invalid`: marker or manifest is malformed;
- `conflict`: duplicate project ID or incompatible metadata.

Listing is read-only. It does not silently repair, remove, or rewrite entries.

### Open/register

`projects open <name-or-path>` resolves either a unique registered name/slug or
an explicit path. It:

1. canonicalizes the project directory;
2. rejects links and malformed, oversized, or unknown-version manifests;
3. verifies required project markers and package/tooling declarations;
4. rejects project-ID conflicts and conflicting metadata;
5. registers the path idempotently;
6. returns project metadata and a suggested `code <path>` command.

It does not launch VS Code automatically. Existing projects outside the
configured root may be registered. New projects are always created under the
configured root.

## Project manifest

`.sql-apps-project.json` is a committed, strict, versioned marker. Version 1
contains:

```json
{
  "version": 1,
  "id": "uuid",
  "name": "Equipment Checkout",
  "slug": "equipment-checkout",
  "starter": "data",
  "profile": "role-based-data",
  "scaffoldVersion": 1,
  "tooling": {
    "package": "@microsoft/sql-apps",
    "version": "exact-version"
  }
}
```

Generated manifests and package files must agree on the `@microsoft/sql-apps`
package name and exact version. Implementations define both once in the starter
catalog rather than duplicate string constants.

The project ID remains stable if a user moves the repository. The workspace ID
for local resources continues to derive from the current canonical path so two
copies cannot silently share local services.

## Existing project migration

Existing experimental worktrees are not moved automatically because they may
contain uncommitted work, shared Git metadata, active services, or user data.

Migration is explicit:

1. stop or inspect owned running services;
2. commit or otherwise preserve application work;
3. clone or copy the application into the desired independent directory;
4. remove worktree-only coupling as a reviewed operation;
5. add or validate the project manifest and pinned tooling;
6. run `projects open <path>`;
7. run setup and workflow validation from the independent project.

The release documentation will include a bounded guide for migrating the current
Todo and bakery experiments without deleting their source worktrees.

The checkout-bound commands remain available temporarily for SQL Apps foundation
development. When they detect attempted end-user application work in the
foundation checkout, they report the project-factory path rather than silently
modifying plugin source.

## Errors and diagnostics

Commands expose stable error codes and actionable messages for:

- invalid display name or slug;
- unsupported starter;
- invalid or unsafe root;
- destination collision;
- template integrity failure;
- staging or atomic-publish failure;
- malformed project or registry state;
- project ID or metadata conflict;
- Git unavailable, Git initialization failure, Git identity missing, or initial
  commit failure;
- unsupported project or scaffold version.

Human output distinguishes:

- project created;
- project created with a Git warning;
- project registered;
- project discovered but unregistered;
- operation failed before publication.

JSON output uses a versioned schema and never returns a success-shaped result for
partial creation.

## Security and filesystem safety

- Canonicalize and validate paths before writes.
- Reject symlink or reparse-point roots, templates, staging directories,
  destinations, and project markers.
- Never follow template links.
- Never interpolate tokens into paths unless the manifest explicitly declares
  that path and the resulting relative path passes containment checks.
- Refuse filesystem roots and foundation/plugin source as project roots.
- Bound names, manifests, registry files, template counts, and individual file
  sizes.
- Use exclusive creation, process locks, atomic state replacement, and
  same-filesystem atomic publication.
- Never store credentials, connection strings, application records, or SQL
  passwords in user-level project registry state.
- Never remove an existing destination as collision recovery.

## Testing strategy

### Unit tests

- Windows-safe and Unicode-aware slug generation.
- Reserved names, separators, trailing dot/space, empty slug, and length limits.
- Default and persisted project-root resolution.
- Strict registry and project-manifest parsing.
- Atomic state updates and lock contention.
- Starter manifest and checksum validation.
- Token allow-listing and deterministic expansion.
- Path containment and link/reparse rejection.
- Git success, Git unavailable, initialization failure, missing identity, and
  commit failure results.

### Integration tests

- Create both starters in temporary user profiles.
- Create the default root on first use.
- Refuse existing empty and non-empty destinations.
- Run concurrent creates for the same and different slugs.
- Inject failures before publication and verify exact staging cleanup.
- Inject registration failures after publication and verify the project is
  retained with an explicit incomplete post-create result.
- List registered, discovered, missing, invalid, and conflicting projects.
- Open/register projects inside and outside the configured root.
- Move a project and re-register it by stable ID.
- Verify generated projects contain no foundation Git metadata, examples,
  credentials, runtime state, dependencies, or build output.
- Verify plugin packages include both starter manifests and matching files.

### End-to-end tests

Where package dependencies are available:

- restore and build each generated starter from its own directory;
- run its application-boundary checks;
- run setup planning without referring to the foundation checkout;
- initialize two projects and prove distinct workspace identities, ports,
  containers, databases, and `.sql-apps` state;
- verify changing one project's pinned tooling version does not modify the
  plugin or another project.

Tests use temporary directories and profiles. They do not create projects in the
real `%USERPROFILE%\SqlAppsProjects` directory.

## Documentation changes

- Replace “open your intended project folder” as the primary new-user path with
  the project-creation command.
- Document the default root and persisted override.
- Explain create, list, open/register, and current-directory authority.
- Show the two starter choices and their capability profiles.
- Explain that creation does not restore dependencies or launch services.
- Document Git warning behavior.
- Add an explicit existing-worktree migration guide.
- Keep foundation contributor instructions separate from application-builder
  instructions.

## Acceptance criteria

The feature is complete when:

1. A first-time user can create `data` and `files-jobs` projects under
   `%USERPROFILE%\SqlAppsProjects` without network access after plugin
   installation.
2. Every generated project is an independent Git repository and contains no
   SQL Apps foundation or plugin source.
3. Creation never installs dependencies, starts services, changes SQL, opens an
   editor, or performs cloud operations.
4. A configured root persists across sessions and does not move existing
   projects.
5. List and open/register work across sessions while current directory remains
   authoritative for project commands.
6. Collisions, malformed state, unsafe paths, and partial failures are explicit
   and do not overwrite user content.
7. Two generated projects can be set up independently with isolated runtime
   identities and state.
8. Each project can upgrade its pinned SQL Apps tooling without modifying the
   plugin or neighboring projects.
