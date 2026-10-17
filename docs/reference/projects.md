# Independent SQL Apps projects

SQL Apps application projects can run independently of the foundation checkout.
The reusable runtime and command implementations are distributed by the
`@microsoft/sql-apps` package; application repositories contain only their
project manifest, domain source, configuration, schema and package metadata.

This separation is a tooling contract, not permission to copy the foundation
repository into every application. Generated projects must not include the
foundation's plugins, examples, tests or runtime implementation source.

## Project manifest

Every project root contains `.sql-apps-project.json`. The manifest is strict and
has this shape:

```json
{
  "version": 1,
  "id": "b91d4857-9570-4d4b-a740-918471ca7e26",
  "name": "Equipment Checkout",
  "slug": "equipment-checkout",
  "starter": "data",
  "profile": "role-based-data",
  "scaffoldVersion": 1,
  "tooling": {
    "package": "@microsoft/sql-apps",
    "version": "0.2.3"
  }
}
```

`starter` must be `data` and `profile` must be `role-based-data`. The
`files-jobs` starter and its `foundation` profile were removed in 0.2.0;
manifests that still name them are rejected, so keep such a project on 0.1.x
tooling. New projects copy `.config`, `content`, `dab`, `docs`, `public` and
`sql`, write `role-based-data.json`, and start with only `src/web/app.ts` as
application source. The entry point imports the typed
`@microsoft/sql-apps/browser` facade for client, authentication and local creation
status behavior. They do not copy `scripts`, `infra`, runtime implementation
source or the foundation runtime contract.

The tooling version is an exact semantic version, not a range. Commands reject
missing, malformed, oversized or linked manifests and stop searching at the
filesystem root.

## Package scripts

Project scripts call the package executable rather than repository-relative
foundation files:

```json
{
  "scripts": {
    "build": "sql-apps build",
    "app:check": "sql-apps check",
    "app:check-api": "sql-apps check-api",
    "consent": "sql-apps consent",
    "guide": "sql-apps guide",
    "local": "sql-apps local",
    "setup": "sql-apps setup",
    "setup:check": "sql-apps setup-check",
    "workspace:check": "sql-apps workspace-check"
  }
}
```

The executable finds the nearest validated project manifest, changes to that
project root and then dispatches the requested command from the installed
tooling package. `SQL_APPS_PROJECT_HOME` is an internal dispatch boundary and
must be an absolute path to the same validated project.

Before the first restore, use the installed plugin launcher for `guide`,
`setup plan` and the approved restore. Its explicit foundation binding supplies
only the bootstrap commands. Bootstrap setup stops after restore: re-run setup
through the installed pinned package and review any changed approval scopes.
Build, runtime execution and subsequent provenance checks all use that package;
a missing or mismatched package is not permission to run foundation runtime code.
Build output can contain compiled package runtime for distribution, not editable
copies of its implementation.

Generation records the exact tooling package and its runtime dependency metadata
in `package-lock.json`, not only in the root dependency declaration. Dependencies
that were development-only in the foundation are promoted when the tooling needs
them at runtime, so `npm ci --omit=dev` does not remove required tooling
dependencies. Package downloads still use the configured npm registry; generation
does not vendor an artifact or substitute a different package version.

## Foundation and package boundaries

The foundation builds and validates the package with:

```powershell
npm run tooling:build
npm run tooling:check
npm run tooling:pack
```

The package contains compiled runtime commands and explicitly selected static
assets. Packaging rejects links, environment files, examples, tests, plugins,
dependency trees and unexpected top-level paths. A generated project owns its
Git history and `.sql-apps` state; it is not a worktree of the foundation.

Project scaffolding must write the manifest and package metadata atomically,
refuse an existing destination and clean up only the temporary directory it
created after a failure. The foundation exposes project creation through
`npm run projects -- create "<name>"`; generated projects use this package-based
contract and are independent of the foundation checkout.

For the guided browser-first route, review
`npm run projects -- create-plan "<name>"`, then approve
`npm run projects -- create "<name>" --approval <id>`. The dependency-free helper
opens before application restore and keeps the public origin through app startup.
See [progressive creation](progressive-creation.md) for separate setup approvals,
version-2 topology, diagnostics and current-evidence Ready gates.
