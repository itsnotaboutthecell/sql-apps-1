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
    "version": "0.2.0"
  }
}
```

`starter` and `profile` must agree:

- `data` uses `role-based-data`.
- `files-jobs` uses `foundation`.

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
