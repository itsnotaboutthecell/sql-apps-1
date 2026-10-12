# SQL Apps Project Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free SQL Apps project factory that creates, lists, and registers independent application repositories under `%USERPROFILE%\SqlAppsProjects`, with each project pinning the `@microsoft/sql-apps` tooling package.

**Architecture:** Keep project discovery and scaffolding in the installed plugin, with no application dependencies. Move project execution behind a publishable tooling package that resolves the current project independently from the foundation checkout. Bundle two immutable starter catalogs with the plugin, publish projects atomically from a same-root staging directory, initialize Git before publication, and store discovery metadata in platform user configuration.

**Tech Stack:** Node.js 22/24 ESM, TypeScript 5.9, JavaScript `.mjs`, npm package/bin conventions, Zod 4, Node test runner, Git CLI, existing SQL Apps file-lock and setup/runtime modules.

---

## Scope and sequencing

This plan deliberately implements the tooling-package boundary before project
creation. A generated project must be usable without the foundation checkout;
creating repositories that still depend on `C:\git\sql-apps` would reproduce the
defect this feature is intended to remove.

Do not move the existing experimental worktrees as part of this plan. Do not
include the uncommitted setup/application-boundary fixes that predate this plan
in project-factory commits.

## File structure

### Project contract and packaged tooling

- Create `src/project-contract.mjs`: strict project-manifest parsing and
  current-directory project resolution.
- Create `packages/sql-apps/package.json`: publishable tooling package metadata,
  bin, exports, dependencies, and packed-file allow-list.
- Create `packages/sql-apps/bin/sql-apps.mjs`: package-local command dispatcher.
- Create `scripts/build-tooling-package.mjs`: assemble the package staging tree
  from built runtime modules and declared runtime assets.
- Create `scripts/check-tooling-package.mjs`: reject undeclared, missing, linked,
  or foundation-only package files.
- Create `tests/project-contract.test.mjs`: manifest and current-directory
  resolution tests.
- Create `tests/tooling-package.test.mjs`: packed package and checkout-independence
  tests.
- Modify `scripts/build-provenance.mjs`: copy the project-contract module and
  package-facing scripts into `dist`.
- Modify `scripts/workspace-check.mjs`: accept generated-project contracts rather
  than requiring the foundation package name and plugin files.
- Modify `scripts/setup.mjs`, `scripts/setup-check.mjs`, and
  `src/local-consent.mjs`: resolve runtime implementation assets from the tooling
  package while resolving application assets and state from the project home.
- Modify `package.json`: add tooling package build/check/pack scripts and include
  the new tests in the suite.

### Dependency-free plugin factory

- Create `plugins/sql-apps/scripts/projects/errors.mjs`: stable error type and
  versioned CLI result helpers.
- Create `plugins/sql-apps/scripts/projects/paths.mjs`: platform state paths,
  canonical path checks, safe project names, and slug generation.
- Create `plugins/sql-apps/scripts/projects/manifest.mjs`: strict parsing for
  `.sql-apps-project.json` and starter manifests.
- Create `plugins/sql-apps/scripts/projects/store.mjs`: bounded user-level state,
  process lock, atomic write, root management, registration, and reconciliation.
- Create `plugins/sql-apps/scripts/projects/git.mjs`: Git initialization and
  initial-commit result handling.
- Create `plugins/sql-apps/scripts/projects/catalog.mjs`: starter lookup and
  integrity verification.
- Create `plugins/sql-apps/scripts/projects/scaffold.mjs`: staged expansion,
  validation, atomic publication, cleanup, and registration.
- Create `plugins/sql-apps/scripts/projects/commands.mjs`: create/list/open/root
  command parsing and rendering.
- Modify `plugins/sql-apps/scripts/sql-apps.mjs`: dispatch `projects` before
  resolving a runtime checkout.
- Create `tests/project-paths.test.mjs`, `tests/project-store.test.mjs`,
  `tests/project-catalog.test.mjs`, `tests/project-scaffold.test.mjs`, and
  `tests/project-commands.test.mjs`.

### Bundled starters

- Create `plugins/sql-apps/starters/data/starter.json` and its declared project
  files.
- Create `plugins/sql-apps/starters/files-jobs/starter.json` and its declared
  project files.
- Create `plugins/sql-apps/starters/tooling-version.json`: single source for the
  generated package name and exact version.
- Modify `scripts/check-plugin.mjs`: verify starter manifests, checksums, and
  the expanded clean-plugin allow-list.
- Modify `tests/plugin.test.ts`: prove both starters are packaged and no runtime
  state or foundation examples leak into them.

### Documentation

- Modify `README.md`: make project creation the application-builder entry point.
- Modify `docs/guides/getting-started.md`: document the default root and factory.
- Modify `docs/guides/build-your-app.md`: begin from `projects create`.
- Modify `docs/guides/run-locally.md`: run setup from a generated project.
- Create `docs/guides/migrate-existing-project.md`: explicit worktree-to-project
  migration without automatic moves or deletion.
- Modify `docs/reference/copilot-plugin.md`: document project commands and
  distinguish plugin source, tooling package, and project directories.
- Modify `plugins/sql-apps/skills/sql-apps-application/SKILL.md`: require a
  generated or registered project before application edits.

## Task 1: Add the generated-project contract

**Files:**
- Create: `src/project-contract.mjs`
- Test: `tests/project-contract.test.mjs`
- Modify: `scripts/build-provenance.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing strict-manifest and project-resolution tests**

Add tests that use a temporary directory and this exact manifest shape:

```js
const manifest = {
  version: 1,
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Equipment Checkout',
  slug: 'equipment-checkout',
  starter: 'data',
  profile: 'role-based-data',
  scaffoldVersion: 1,
  tooling: { package: '@microsoft/sql-apps', version: '0.1.1' },
};
```

The tests must assert:

```js
assert.deepEqual(await readProjectManifest(root), manifest);
assert.equal(await findProjectHome(join(root, 'src', 'nested')), root);
await assert.rejects(readProjectManifest(rootWithUnknownField), /PROJECT_MANIFEST_INVALID/);
await assert.rejects(readProjectManifest(rootWithBadUuid), /PROJECT_MANIFEST_INVALID/);
await assert.rejects(findProjectHome(outside), /PROJECT_NOT_FOUND/);
```

Also create a symlink/junction fixture where supported and assert
`PROJECT_PATH_UNSAFE`. Skip only when the host explicitly denies link creation.

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run:

```powershell
node --test tests\project-contract.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/project-contract.mjs`.

- [ ] **Step 3: Implement strict parsing and ancestor resolution**

Export these exact functions from `src/project-contract.mjs`:

```js
export const PROJECT_MANIFEST = '.sql-apps-project.json';
export async function parseProjectManifest(value) {}
export async function readProjectManifest(root) {}
export async function findProjectHome(directory = process.cwd()) {}
```

`parseProjectManifest` must reject unknown keys, require the exact package name
`@microsoft/sql-apps`, require an exact SemVer value without ranges, and return a
new normalized object. `findProjectHome` must canonicalize the starting
directory, walk ancestors, reject a manifest that is a link, and stop at the
filesystem root.

Use stable error objects:

```js
throw Object.assign(new Error('Project manifest is invalid.'), {
  code: 'PROJECT_MANIFEST_INVALID',
});
```

- [ ] **Step 4: Copy the module into runtime build output**

In `scripts/build-provenance.mjs`, add:

```js
await copyFile(
  resolve(home, 'src', 'project-contract.mjs'),
  resolve(home, 'dist', 'src', 'project-contract.mjs'),
);
```

Add `tests/project-contract.test.mjs` to the root `npm test` command.

- [ ] **Step 5: Run tests**

Run:

```powershell
node --test tests\project-contract.test.mjs
npm run build
```

Expected: both commands PASS and `dist\src\project-contract.mjs` exists.

- [ ] **Step 6: Commit**

```powershell
git add src\project-contract.mjs tests\project-contract.test.mjs scripts\build-provenance.mjs package.json
git commit -m "feat: define SQL Apps project contract" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Create the publishable tooling-package boundary

**Files:**
- Create: `packages/sql-apps/package.json`
- Create: `packages/sql-apps/bin/sql-apps.mjs`
- Create: `scripts/build-tooling-package.mjs`
- Create: `scripts/check-tooling-package.mjs`
- Test: `tests/tooling-package.test.mjs`
- Modify: `package.json`
- Modify: `scripts/build-provenance.mjs`

- [ ] **Step 1: Write a failing package-contract test**

The test must build the package into `dist/tooling-package`, then assert:

```js
const pkg = JSON.parse(await readFile('dist/tooling-package/package.json', 'utf8'));
assert.equal(pkg.name, '@microsoft/sql-apps');
assert.equal(pkg.version, '0.1.1');
assert.equal(pkg.type, 'module');
assert.deepEqual(pkg.bin, { 'sql-apps': 'bin/sql-apps.mjs' });
assert.equal(pkg.private, undefined);
assert.deepEqual(pkg.files, ['bin', 'dist', 'assets']);
```

It must recursively inspect the staging directory and reject `.git`,
`.sql-apps`, `examples`, `tests`, `.env*`, `node_modules`, and plugin source.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test tests\tooling-package.test.mjs
```

Expected: FAIL because `scripts/build-tooling-package.mjs` and package metadata
do not exist.

- [ ] **Step 3: Add publishable package metadata**

Create `packages/sql-apps/package.json` with:

```json
{
  "name": "@microsoft/sql-apps",
  "version": "0.1.1",
  "type": "module",
  "license": "MIT",
  "bin": {
    "sql-apps": "bin/sql-apps.mjs"
  },
  "exports": {
    "./project-contract": "./dist/src/project-contract.mjs"
  },
  "files": ["bin", "dist", "assets"],
  "engines": {
    "node": ">=22 <23 || >=24 <25"
  },
  "dependencies": {
    "@azure/functions": "4.16.5",
    "@azure/identity": "4.13.3",
    "@azure/keyvault-secrets": "4.11.2",
    "@azure/msal-browser": "5.25.0",
    "@azure/storage-blob": "12.34.0",
    "@azure/storage-queue": "12.32.0",
    "@fastify/static": "10.1.5",
    "@opentelemetry/api": "1.9.0",
    "@opentelemetry/sdk-trace-base": "2.11.0",
    "esbuild": "0.28.2",
    "fastify": "5.12.5",
    "jose": "6.2.12",
    "typescript": "5.9.3",
    "zod": "4.6.5"
  }
}
```

Keep these versions synchronized with the root manifest through the tooling
package test. Do not add repository-test or plugin-scaffolding dependencies.

- [ ] **Step 4: Add a package-local command dispatcher**

`packages/sql-apps/bin/sql-apps.mjs` must:

```js
#!/usr/bin/env node
import { findProjectHome } from '../dist/src/project-contract.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const project = command === 'help' ? process.cwd() : await findProjectHome();
process.chdir(project);

const commands = new Map([
  ['build', '../dist/scripts/build-provenance.mjs'],
  ['setup', '../dist/scripts/setup.mjs'],
  ['setup-check', '../dist/scripts/setup-check.mjs'],
  ['guide', '../dist/scripts/guide.mjs'],
  ['workspace-check', '../dist/scripts/workspace-check.mjs'],
  ['consent', '../dist/scripts/local-consent.mjs'],
  ['local', '../dist/src/local-cli.js'],
  ['azure', '../dist/src/cli.js'],
  ['check', '../dist/scripts/check-application.mjs']
]);
```

Validate the command before dynamic import. Set
`process.env.SQL_APPS_PROJECT_HOME = project`, replace `process.argv` with the
selected command arguments, and import the mapped module relative to the bin.
`help` prints only this command set and performs no project lookup.

- [ ] **Step 5: Build a strict package staging directory**

`scripts/build-tooling-package.mjs` must:

1. require a successful root runtime build;
2. remove only `dist/tooling-package` after confirming it is beneath root
   `dist`;
3. copy `packages/sql-apps/package.json` and `bin`;
4. copy `dist/src` and `dist/scripts`;
5. copy a declared runtime asset allow-list into `assets`;
6. copy `LICENSE`;
7. reject every link encountered.

Start the runtime asset allow-list with:

```js
const assets = [
  '.config/dotnet-tools.json',
  'sql',
  'dab',
  'public/index.html',
  'public/style.css',
  'public/auth/redirect.html',
  'functions/Dockerfile',
  'functions/local.Dockerfile',
  'functions/package.json',
  'functions/local-package.json',
  'functions/host.json',
  'functions/local-host.json',
  'infra',
  'Dockerfile',
  'runtime-contract.json',
];
```

Keep this allow-list exact. If a focused package test proves an entry unused,
remove that entry and its test expectation in the same commit; never broaden the
list to the repository root.

- [ ] **Step 6: Add package verification**

`scripts/check-tooling-package.mjs` must validate the staged tree against package
`files`, reject links and excluded names, import the bin with `help`, and run:

```powershell
npm pack .\dist\tooling-package --dry-run --json
```

Parse the JSON and assert every packed path starts with `package/bin`,
`package/dist`, `package/assets`, or is one of `package/package.json`,
`package/LICENSE`, `package/README.md`.

- [ ] **Step 7: Wire package scripts**

Add:

```json
"tooling:build": "node scripts/build-tooling-package.mjs",
"tooling:check": "node scripts/check-tooling-package.mjs",
"tooling:pack": "npm run tooling:build && npm run tooling:check && npm pack ./dist/tooling-package"
```

Add `tests/tooling-package.test.mjs` to `npm test`.

- [ ] **Step 8: Run tests**

Run:

```powershell
npm run build
npm run tooling:build
npm run tooling:check
node --test tests\tooling-package.test.mjs
```

Expected: all commands PASS; the dry-run package list contains no foundation
examples, repository tests, plugin, Git, or private state.

- [ ] **Step 9: Commit**

```powershell
git add packages\sql-apps scripts\build-tooling-package.mjs scripts\check-tooling-package.mjs tests\tooling-package.test.mjs scripts\build-provenance.mjs package.json
git commit -m "feat: package SQL Apps project tooling" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Separate project home from tooling home

**Files:**
- Modify: `scripts/workspace-check.mjs`
- Modify: `scripts/setup.mjs`
- Modify: `scripts/setup-check.mjs`
- Modify: `scripts/guide.mjs`
- Modify: `scripts/local-consent.mjs`
- Modify: `scripts/build-provenance.mjs`
- Modify: `src/local-consent.mjs`
- Modify: `src/local-cli.ts`
- Modify: `src/local.ts`
- Modify: `src/local-services.ts`
- Modify: `src/role-based-profile.ts`
- Create: `src/tooling-context.mjs`
- Test: `tests/tooling-project-runtime.test.mjs`

- [ ] **Step 1: Write a failing checkout-independence test**

Create a minimal generated-project fixture with:

- `.sql-apps-project.json`;
- project `package.json`, `application.json`, `role-based-data.json`;
- project `src`, `public`, `sql`, and `dab`;
- a copied `dist/tooling-package` installed at
  `node_modules/@microsoft/sql-apps`.

Run the package bin from the project while the foundation checkout is renamed in
the fixture or made inaccessible through dependency injection:

```js
const result = await run(process.execPath, [
  join(project, 'node_modules', '@microsoft', 'sql-apps', 'bin', 'sql-apps.mjs'),
  'workspace-check',
], { env: { SQL_APPS_PROJECT_HOME: project } });
const report = JSON.parse(result);
assert.equal(report.project.home, project);
assert.doesNotMatch(result, new RegExp(escapeRegex(repositoryRoot)));
```

- [ ] **Step 2: Run the test and verify the foundation-checkout dependency**

Run:

```powershell
node --test tests\tooling-project-runtime.test.mjs
```

Expected: FAIL with `SOURCE_INVALID`, a missing plugin file, or a foundation
checkout path in the result.

- [ ] **Step 3: Add explicit tooling/project context**

Create `src/tooling-context.mjs`:

```js
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectHome } from './project-contract.mjs';

export function toolingHome(meta = import.meta.url) {
  return resolve(dirname(fileURLToPath(meta)), '..', '..');
}

export async function projectHome(env = process.env, cwd = process.cwd()) {
  return env.SQL_APPS_PROJECT_HOME
    ? findProjectHome(env.SQL_APPS_PROJECT_HOME)
    : findProjectHome(cwd);
}
```

Copy this `.mjs` module in `scripts/build-provenance.mjs`.

- [ ] **Step 4: Change source inspection to a project contract**

In `scripts/workspace-check.mjs`, replace the requirements for root package name
`sql-apps`, `src/local-cli.ts`, and `plugins/sql-apps/plugin.json` with:

- strict `.sql-apps-project.json`;
- application manifest;
- project package containing exact `@microsoft/sql-apps` version matching the
  project manifest;
- starter-required project paths;
- tooling contract/version passed from the installed package.

Keep fingerprinting project source, Git evidence, build provenance, and workspace
identity. Exclude `node_modules`, `.git`, `.sql-apps`, and generated browser
artifacts exactly as today.

- [ ] **Step 5: Route assets explicitly**

For every modified runtime module, introduce named `projectHome` and
`toolingHome` values and apply this rule:

- read `application.json`, `role-based-data.json`, `src`, `public`, `sql`, `dab`,
  project tests, and `.sql-apps` from project home;
- read generic Dockerfiles, generic Functions worker, infrastructure templates,
  packaged scripts, and immutable runtime assets from tooling home;
- write build artifacts and local state under project home;
- never infer tooling home from current directory.

Do not use `process.chdir()` as the only implementation. Pass absolute roots
into helpers that already accept `home`; add parameters to helpers that still
read relative files.

- [ ] **Step 6: Preserve consent contracts**

Update `src/local-consent.mjs` so requirement hashes combine:

```js
{
  projectInputs: hashes from projectHome,
  toolingInputs: hashes from toolingHome,
  toolingVersion: projectManifest.tooling.version
}
```

Application SQL and DAB edits retain the existing grant behavior. Tooling
package upgrades invalidate build/schema/services scopes whose implementation
changed.

- [ ] **Step 7: Run focused runtime tests**

Run:

```powershell
npm run build
npm run tooling:build
node --test tests\tooling-project-runtime.test.mjs tests\workspace.test.mjs tests\local-consent.test.mjs tests\setup-journey.test.mjs
```

Expected: all tests PASS and the fixture report contains only the generated
project as its project home.

- [ ] **Step 8: Commit**

```powershell
git add src\tooling-context.mjs src\local-consent.mjs src\local-cli.ts src\local.ts src\local-services.ts src\role-based-profile.ts scripts\workspace-check.mjs scripts\setup.mjs scripts\setup-check.mjs scripts\guide.mjs scripts\local-consent.mjs scripts\build-provenance.mjs tests\tooling-project-runtime.test.mjs
git commit -m "refactor: run tooling from independent projects" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Implement safe project paths and manifests in the plugin

**Files:**
- Create: `plugins/sql-apps/scripts/projects/errors.mjs`
- Create: `plugins/sql-apps/scripts/projects/paths.mjs`
- Create: `plugins/sql-apps/scripts/projects/manifest.mjs`
- Test: `tests/project-paths.test.mjs`

- [ ] **Step 1: Write failing path and manifest tests**

Test these exact outcomes:

```js
assert.equal(slugifyProjectName('Equipment Checkout'), 'equipment-checkout');
assert.equal(slugifyProjectName('  Café inventory  '), 'cafe-inventory');
for (const value of ['', 'CON', 'NUL.txt', 'bad/name', 'bad\\name', 'name.', 'name ']) {
  assert.throws(() => slugifyProjectName(value), error => error.code === 'PROJECT_NAME_INVALID');
}
assert.equal(defaultProjectsRoot({ USERPROFILE: 'C:\\Users\\Ada' }, 'win32'),
  'C:\\Users\\Ada\\SqlAppsProjects');
```

Test macOS and Linux state paths exactly as specified in the design. Test that
unknown manifest keys, version ranges, bad UUIDs, mismatched slug/name, and
unsupported starter/profile pairs fail.

- [ ] **Step 2: Run tests and verify missing modules**

Run:

```powershell
node --test tests\project-paths.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement stable project errors**

`errors.mjs` exports:

```js
export class ProjectError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.details = details;
  }
}
```

Do not put raw command output, credentials, or arbitrary file contents in
`details`.

- [ ] **Step 4: Implement platform paths and slugging**

`paths.mjs` exports:

```js
export function defaultProjectsRoot(env = process.env, platform = process.platform) {}
export function projectStatePath(env = process.env, platform = process.platform) {}
export function slugifyProjectName(name) {}
export async function canonicalSafeDirectory(path, options) {}
export function isContained(parent, child) {}
```

Use Unicode NFKD normalization, remove combining marks, retain ASCII letters and
digits, collapse other runs to `-`, trim, lowercase, cap at 64 characters, and
reject Windows device basenames case-insensitively. Reject links and Windows
reparse points using `lstat` plus `realpath`; on Windows, add a testable injected
reparse inspector rather than shelling out.

- [ ] **Step 5: Implement strict manifests**

`manifest.mjs` exports strict parsers for project and starter manifests. The
starter parser enforces:

```js
{
  version: 1,
  id: 'data',
  scaffoldVersion: 1,
  profile: 'role-based-data',
  tooling: { package: '@microsoft/sql-apps', version: '0.1.1' },
  files: [{ path: 'package.json', sha256: '0000000000000000000000000000000000000000000000000000000000000000', text: true }],
  requiredPaths: ['package.json', '.sql-apps-project.json'],
  tokens: ['PROJECT_ID', 'PROJECT_NAME', 'PROJECT_SLUG',
    'STARTER_ID', 'PROFILE', 'SCAFFOLD_VERSION', 'TOOLING_VERSION']
}
```

Reject absolute paths, `.`/`..`, empty components, colons, duplicate file paths,
duplicate tokens, undeclared required paths, and non-lowercase starter IDs.

- [ ] **Step 6: Run tests**

Run:

```powershell
node --test tests\project-paths.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add plugins\sql-apps\scripts\projects\errors.mjs plugins\sql-apps\scripts\projects\paths.mjs plugins\sql-apps\scripts\projects\manifest.mjs tests\project-paths.test.mjs
git commit -m "feat: validate SQL Apps project paths" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Implement the user-level project store

**Files:**
- Create: `plugins/sql-apps/scripts/projects/lock.mjs`
- Create: `plugins/sql-apps/scripts/projects/store.mjs`
- Test: `tests/project-store.test.mjs`

- [ ] **Step 1: Write failing store tests**

Use injected environment, platform, clock, and filesystem roots. Assert:

```js
assert.deepEqual(await store.read(), { version: 1, projects: [] });
assert.equal((await store.root()).source, 'default');
await store.setRoot('D:\\SqlApps');
assert.deepEqual(await store.root(), {
  path: canonicalRoot,
  source: 'configured',
  exists: true,
});
```

Add tests for:

- bounded regular JSON;
- unknown fields;
- a linked state file;
- atomic replacement;
- lock contention;
- root equal to filesystem root;
- root equal to foundation/plugin source;
- root equal to an existing project;
- idempotent registration;
- duplicate project ID at another path;
- conflicting metadata at one path.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test tests\project-store.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add a plugin-local dependency-free lock**

Port the behavior of `src/file-lock.mjs` into
`plugins/sql-apps/scripts/projects/lock.mjs` rather than importing foundation
source. Preserve unique-owner directories, stale-owner checks, bounded owner
files, host checks, and exact owned cleanup.

Export only:

```js
export async function withProjectStoreLock(lockPath, action) {}
```

- [ ] **Step 4: Implement versioned state**

`store.mjs` exports:

```js
export function createProjectStore(options = {}) {}
```

The returned object exposes:

```js
{
  read,
  root,
  setRoot,
  register,
  listRegistered
}
```

Persist:

```js
{
  version: 1,
  root: 'D:\\SqlApps',
  projects: [{
    id: 'uuid',
    path: 'D:\\SqlApps\\equipment-checkout',
    name: 'Equipment Checkout',
    slug: 'equipment-checkout',
    starter: 'data',
    manifestVersion: 1
  }]
}
```

Omit `root` when the default is active. Limit the file to 1 MiB and 10,000
projects. Write a uniquely named temporary file with mode `0o600`, then rename
under the store lock.

- [ ] **Step 5: Run tests**

Run:

```powershell
node --test tests\project-store.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add plugins\sql-apps\scripts\projects\lock.mjs plugins\sql-apps\scripts\projects\store.mjs tests\project-store.test.mjs
git commit -m "feat: persist SQL Apps project registry" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Add and verify bundled starters

**Files:**
- Create: `plugins/sql-apps/starters/tooling-version.json`
- Create: `plugins/sql-apps/starters/data/starter.json`
- Create: `plugins/sql-apps/starters/data/template/**`
- Create: `plugins/sql-apps/starters/files-jobs/starter.json`
- Create: `plugins/sql-apps/starters/files-jobs/template/**`
- Create: `plugins/sql-apps/scripts/projects/catalog.mjs`
- Create: `scripts/update-starter-manifests.mjs`
- Create: `scripts/update-starter-lockfiles.mjs`
- Test: `tests/project-catalog.test.mjs`

- [ ] **Step 1: Write failing catalog tests**

Assert:

```js
const catalog = await loadStarterCatalog(pluginRoot);
assert.deepEqual(catalog.map(item => item.id), ['data', 'files-jobs']);
assert.equal(catalog[0].profile, 'role-based-data');
assert.equal(catalog[1].profile, 'foundation');
assert.ok(catalog.every(item =>
  item.tooling.package === '@microsoft/sql-apps' &&
  item.tooling.version === toolingVersion.version));
```

Mutate one fixture file after copying a starter and assert
`STARTER_INTEGRITY_FAILED`. Add undeclared file, link, duplicate path, unknown
token, missing required path, and traversal fixtures.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test tests\project-catalog.test.mjs
```

Expected: FAIL because the catalog and starters do not exist.

- [ ] **Step 3: Add the single tooling-version source**

Create:

```json
{
  "package": "@microsoft/sql-apps",
  "version": "0.1.1"
}
```

Both starter manifests and generated package/project manifests must read these
values; do not duplicate them in generator code.

- [ ] **Step 4: Create the data starter**

The data starter must contain only:

```text
.gitignore
.sql-apps-project.json
README.md
application.json
package.json
package-lock.json
runtime-contract.json
role-based-data.json
dab/dab-config.json
public/index.html
public/style.css
src/client.ts
src/web/app.ts
sql/database.sqlproj
sql/schema.sql
sql/procedures.sql
sql/grants.sql
tests/application.test.ts
tsconfig.json
tsconfig.runtime.json
```

Use project tokens in JSON/string positions only. The package scripts are:

```json
{
  "build": "sql-apps build",
  "setup": "sql-apps setup",
  "local": "sql-apps local",
  "check": "sql-apps check",
  "test": "sql-apps build && node --test dist/tests/*.test.js"
}
```

The dependency is exact:

```json
"devDependencies": {
  "@microsoft/sql-apps": "%%TOOLING_VERSION%%"
}
```

The starter implements a neutral `Records` domain, not Todo, and its stored
procedures use the existing ownership, validation, and mutation-result rules.

- [ ] **Step 5: Create the files/jobs starter**

Start with the data starter files and add only:

```text
functions/src/index.ts
local-settings.example.json
sql/file-jobs.sql
```

Set profile `foundation`, include declared file/job capabilities in
`application.json`, and keep all generic worker/container implementation in the
tooling package assets.

- [ ] **Step 6: Add deterministic manifest generation**

`scripts/update-starter-manifests.mjs` computes sorted SHA-256 entries for every
regular file under each `template`, marks only UTF-8 token-bearing files as
`text: true`, and refuses links, undeclared tokens, files over 1 MiB, and paths
outside the starter.

It writes only the `files` array in `starter.json`; all other metadata is
preserved and strictly parsed before writing.

- [ ] **Step 7: Add deterministic starter lockfile generation**

`scripts/update-starter-lockfiles.mjs` accepts one absolute
`@microsoft/sql-apps` package tarball path. For each starter it:

1. copies `package.json` to a temporary directory;
2. replaces the exact tooling dependency with a `file:` value formed from the
   function's validated absolute tarball argument;
3. runs `npm install --package-lock-only --ignore-scripts`;
4. verifies the root dependency and package entry versions equal
   `tooling-version.json`;
5. rewrites only the tooling package's `resolved` field with:

   ```js
   `https://registry.npmjs.org/@microsoft/sql-apps/-/sql-apps-${version}.tgz`
   ```

6. preserves the tarball's SHA-512 integrity;
7. replaces the temporary root package name with the literal
   `%%PROJECT_SLUG%%` token in the root lockfile entries;
8. writes the resulting lockfile into the starter template.

The packed release artifact must be byte-identical to the artifact used here;
`check-tooling-package.mjs` compares its integrity before release. This lets
creation remain offline while the later user-requested install resolves the
published exact package.

- [ ] **Step 8: Implement catalog verification**

`catalog.mjs` exports:

```js
export async function loadStarterCatalog(pluginRoot) {}
export async function loadStarter(pluginRoot, id) {}
```

It verifies the tooling-version file, strict manifest, exact declared-vs-actual
file set, every digest, required paths, and token declarations before returning
file metadata.

- [ ] **Step 9: Generate lockfiles and manifests, then run tests**

Run:

```powershell
npm run build
npm run tooling:build
$pack = (npm pack .\dist\tooling-package --pack-destination $env:TEMP --json | ConvertFrom-Json)[0].filename
node scripts\update-starter-lockfiles.mjs (Join-Path $env:TEMP $pack)
node scripts\update-starter-manifests.mjs
node --test tests\project-catalog.test.mjs
```

Expected: PASS and a second manifest-generation run produces no Git diff.

- [ ] **Step 10: Commit**

```powershell
git add plugins\sql-apps\starters plugins\sql-apps\scripts\projects\catalog.mjs scripts\update-starter-manifests.mjs scripts\update-starter-lockfiles.mjs tests\project-catalog.test.mjs
git commit -m "feat: bundle SQL Apps project starters" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Implement atomic scaffolding and Git initialization

**Files:**
- Create: `plugins/sql-apps/scripts/projects/git.mjs`
- Create: `plugins/sql-apps/scripts/projects/scaffold.mjs`
- Test: `tests/project-scaffold.test.mjs`

- [ ] **Step 1: Write failing end-to-end scaffolder tests**

Use temporary roots and injected Git runner. Assert:

```js
const result = await createProject({
  name: 'Equipment Checkout',
  starter: 'data',
  root,
  pluginRoot,
  store,
  runGit,
});
assert.equal(result.status, 'created');
assert.equal(result.project.path, join(root, 'equipment-checkout'));
assert.equal((await lstat(join(result.project.path, '.git'))).isDirectory(), true);
assert.equal((await readProjectManifest(result.project.path)).name, 'Equipment Checkout');
```

Add tests for:

- existing empty and non-empty destinations;
- same-slug concurrent creates;
- different-slug concurrent creates;
- token expansion;
- undeclared token;
- Git unavailable;
- `git init` failure;
- missing identity warning;
- commit failure warning;
- copy/validation failure cleanup;
- atomic rename failure cleanup;
- registration failure after publication;
- exact staging cleanup with no root or neighboring deletion.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test tests\project-scaffold.test.mjs
```

Expected: FAIL because scaffolder modules do not exist.

- [ ] **Step 3: Implement Git initialization**

`git.mjs` exports:

```js
export async function initializeProjectGit(directory, run) {}
```

Run `git init` first. If the executable is unavailable or init fails, throw
`GIT_INITIALIZATION_FAILED`. Query `git config user.name` and
`git config user.email` without writing fallback identity. When either is
missing, return:

```js
{ initialized: true, committed: false, warning: {
  code: 'GIT_IDENTITY_MISSING',
  message: 'Configure Git user.name and user.email, then create the initial commit.'
}}
```

When identity exists, run `git add -A` and
`git commit -m "Initial SQL Apps project"`. A commit failure returns
`GIT_INITIAL_COMMIT_FAILED` warning while preserving the initialized repository.

- [ ] **Step 4: Implement staged expansion**

`scaffold.mjs` exports:

```js
export async function createProject(options) {}
```

Use a staging name:

```js
`.sql-apps-create-${slug}-${randomUUID()}`
```

as a direct child of the final root. Create it with exclusive semantics. For
every declared file:

1. validate containment;
2. create parent directories;
3. read no more than the declared bounded size;
4. verify digest before expansion;
5. replace only `%%TOKEN%%` values declared by the starter;
6. write with `flag: 'wx'`.

Reject a remaining `%%[A-Z0-9_]+%%` token.

- [ ] **Step 5: Validate, initialize Git, and publish**

Before rename:

- parse `.sql-apps-project.json`;
- parse `package.json` and confirm exact package/version agreement;
- confirm all required paths;
- initialize Git.

Publish with one same-filesystem `rename(staging, destination)`. If rename
reports collision, return `PROJECT_ALREADY_EXISTS`.

After publication, register the canonical path. If registration fails, return
`created-unregistered` with the published path and error code; do not delete the
project.

- [ ] **Step 6: Implement exact cleanup**

In `finally`, cleanup only when:

- the staging path equals the locally generated absolute path;
- its canonical parent equals the validated project root;
- its basename starts with `.sql-apps-create-${slug}-`;
- it is not the final destination.

Use `rm(staging, { recursive: true })` only after all four assertions. Never use
a wildcard or unresolved environment variable.

- [ ] **Step 7: Run tests**

Run:

```powershell
node --test tests\project-scaffold.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add plugins\sql-apps\scripts\projects\git.mjs plugins\sql-apps\scripts\projects\scaffold.mjs tests\project-scaffold.test.mjs
git commit -m "feat: scaffold independent SQL Apps projects" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 8: Add create, root, list, and open commands

**Files:**
- Create: `plugins/sql-apps/scripts/projects/commands.mjs`
- Modify: `plugins/sql-apps/scripts/sql-apps.mjs`
- Test: `tests/project-commands.test.mjs`
- Modify: `tests/plugin.test.ts`

- [ ] **Step 1: Write failing CLI parsing and output tests**

Test:

```text
projects create "Equipment Checkout" --starter data --json
projects root --json
projects root set D:\SqlApps
projects list --json
projects open equipment-checkout --json
projects open D:\Outside\registered-project --json
```

Reject unknown/duplicate flags, extra positional arguments, unsupported
starters, relative root-set paths, ambiguous registered names, and malformed
projects.

Assert create can run when no SQL Apps runtime checkout binding exists.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test tests\project-commands.test.mjs
```

Expected: FAIL because command dispatch is absent.

- [ ] **Step 3: Implement versioned JSON results**

`commands.mjs` exports:

```js
export async function projectsMain(args, options = {}) {}
```

Every JSON result has:

```js
{
  version: 1,
  command: 'create',
  ok: true,
  result: {}
}
```

Failures print:

```js
{
  version: 1,
  command: 'create',
  ok: false,
  error: {
    code: 'PROJECT_ALREADY_EXISTS',
    message: 'A project folder named "equipment-checkout" already exists.'
  }
}
```

and set a nonzero exit code. Do not catch and reshape programmer errors that are
not `ProjectError`.

- [ ] **Step 4: Implement root and create rendering**

Human create output must include:

```text
Created Equipment Checkout at C:\Users\Ada\SqlAppsProjects\equipment-checkout
Next:
  cd "C:\Users\Ada\SqlAppsProjects\equipment-checkout"
  npm install
  npm run setup -- approval --profile role-based-data
```

When Git identity or commit warning exists, print it after the created line and
before `Next`. Do not claim an initial commit exists.

- [ ] **Step 5: Implement list reconciliation**

Combine registered entries with valid direct children of the configured root.
Do not recurse. Return status:

```js
'ready' | 'unregistered' | 'missing' | 'invalid' | 'conflict'
```

Do not write registry changes during list. Sort by display name, then canonical
path.

- [ ] **Step 6: Implement open/register**

Resolve an explicit path first. Otherwise match a unique registered display
name or slug case-insensitively. Validate manifest and required package
declaration, detect duplicate IDs, register idempotently, and print:

```text
Registered Equipment Checkout at ${project.path}
Open in VS Code:
  code "${project.path}"
```

Do not spawn `code`.

- [ ] **Step 7: Dispatch projects before runtime-home resolution**

At the top of `plugins/sql-apps/scripts/sql-apps.mjs`:

```js
if (process.argv[2] === 'projects') {
  const { projectsMain } = await import('./projects/commands.mjs');
  await projectsMain(process.argv.slice(3));
  return;
}
```

This branch must execute before `resolveHome()` or `workspaceReport()`.

- [ ] **Step 8: Run tests**

Run:

```powershell
node --test tests\project-commands.test.mjs
npm run build
node --test dist\tests\plugin.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add plugins\sql-apps\scripts\projects\commands.mjs plugins\sql-apps\scripts\sql-apps.mjs tests\project-commands.test.mjs tests\plugin.test.ts
git commit -m "feat: add SQL Apps project commands" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 9: Package and verify the expanded plugin

**Files:**
- Modify: `scripts/check-plugin.mjs`
- Modify: `tests/plugin.test.ts`
- Modify: `plugins/sql-apps/plugin.json`
- Modify: marketplace/plugin manifests only if version policy requires a release bump

- [ ] **Step 1: Make plugin packaging tests fail on undeclared factory files**

Update the expected clean bundle to include:

```text
plugins/sql-apps/scripts/projects/*.mjs
plugins/sql-apps/starters/tooling-version.json
plugins/sql-apps/starters/data/**
plugins/sql-apps/starters/files-jobs/**
```

The test must still reject runtime state, dependencies, build output, credentials,
foundation examples, and links.

- [ ] **Step 2: Verify the test fails before checker updates**

Run:

```powershell
npm run plugin:check
```

Expected: FAIL with a bundle-content mismatch.

- [ ] **Step 3: Extend plugin verification**

Change `scripts/check-plugin.mjs` to:

- recursively allow only existing skill/reference files, launcher, project
  modules, starter manifests, and starter declared files;
- invoke `loadStarterCatalog(plugin)`;
- compare starter tooling version to `packages/sql-apps/package.json`;
- verify every generated package dependency and project manifest token will use
  the same exact version;
- update success output to name six skills and two starters.

- [ ] **Step 4: Update plugin metadata**

Change the description to include independent project creation:

```json
"description": "Create independent SQL Apps projects, design and build their application workflows, and start, inspect, troubleshoot and validate them locally."
```

Apply a repository-standard version bump only if this branch is preparing a
release. If bumped, update every manifest and marketplace consistently using
the existing identity test.

- [ ] **Step 5: Run package tests**

Run:

```powershell
node scripts\update-starter-manifests.mjs
npm run plugin:check
npm run tooling:build
npm run tooling:check
node --test tests\project-catalog.test.mjs tests\project-commands.test.mjs
```

Expected: PASS and `git diff --exit-code` reports no generated checksum drift
after a second starter-manifest run.

- [ ] **Step 6: Commit**

```powershell
git add scripts\check-plugin.mjs tests\plugin.test.ts plugins\sql-apps\plugin.json .github\plugin\marketplace.json .claude-plugin\marketplace.json .agents\plugins\marketplace.json
git commit -m "feat: package SQL Apps project factory" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If version policy did not require marketplace edits, omit unchanged files from
the `git add` command.

## Task 10: Prove generated projects run independently

**Files:**
- Create: `tests/project-factory-e2e.test.mjs`
- Modify: `package.json`
- Modify: `scripts/check-application.mjs`
- Modify: `tests/application.test.ts`

- [ ] **Step 1: Write end-to-end tests for both starters**

For each starter:

1. create under a temporary `USERPROFILE`;
2. pack `dist/tooling-package` to a temporary `.tgz`;
3. replace only the fixture's exact tooling dependency with the tarball path;
4. run `npm install --ignore-scripts`;
5. run `npm run build`;
6. run `npm run check`;
7. run setup planning without foundation binding;
8. assert the project path is outside the repository.

Use dependency installation only in this explicit end-to-end test. Unit tests
remain network-free.

- [ ] **Step 2: Add two-project isolation assertions**

Create `alpha` and `beta`, initialize workspaces with different injected free
port blocks, and assert:

```js
assert.notEqual(alphaRuntime.id, betaRuntime.id);
assert.notEqual(alphaRuntime.database, betaRuntime.database);
assert.notEqual(alphaRuntime.defaultSql, betaRuntime.defaultSql);
assert.notDeepEqual(alphaRuntime.ports, betaRuntime.ports);
assert.ok(alphaRuntime.stateDirectory.startsWith(alpha.path));
assert.ok(betaRuntime.stateDirectory.startsWith(beta.path));
```

- [ ] **Step 3: Run and observe the first failure**

Run:

```powershell
npm run build
npm run tooling:build
node --test tests\project-factory-e2e.test.mjs
```

Expected before compatibility fixes: FAIL at the first remaining assumption that
the project is the foundation checkout. Record the exact assertion and fix that
root cause; do not add a foundation-path fallback.

- [ ] **Step 4: Make application checks project-aware**

Update `scripts/check-application.mjs` to validate the generated-project
contract and project delivery surfaces without requiring foundation-only files.
Keep the existing negative checks for copied examples, broad Docker copies, and
missing build artifacts.

Update `tests/application.test.ts` with one generated data project and one
generated files/jobs project fixture.

- [ ] **Step 5: Iterate on only project/tooling path assumptions**

For each end-to-end failure:

- add a focused regression assertion to `tests/tooling-project-runtime.test.mjs`
  or the owning module test;
- change the owning helper to accept project/tooling roots explicitly;
- rerun the focused test;
- rerun the end-to-end test.

Do not weaken source fingerprints, consent contracts, ownership checks, or
application-boundary validation to make the test pass.

- [ ] **Step 6: Add the end-to-end test to the suite**

Add `tests/project-factory-e2e.test.mjs` after tooling build in `npm test`. Keep
temporary npm cache and project directories under the test fixture and remove
only their exact paths in teardown.

- [ ] **Step 7: Run regression suites**

Run:

```powershell
npm run build
npm run tooling:build
node --test tests\project-contract.test.mjs tests\tooling-package.test.mjs tests\tooling-project-runtime.test.mjs tests\project-paths.test.mjs tests\project-store.test.mjs tests\project-catalog.test.mjs tests\project-scaffold.test.mjs tests\project-commands.test.mjs tests\project-factory-e2e.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add tests\project-factory-e2e.test.mjs tests\tooling-project-runtime.test.mjs scripts\check-application.mjs tests\application.test.ts package.json
git commit -m "test: verify independent generated projects" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 11: Update user and agent guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/guides/getting-started.md`
- Modify: `docs/guides/build-your-app.md`
- Modify: `docs/guides/run-locally.md`
- Create: `docs/guides/migrate-existing-project.md`
- Modify: `docs/reference/copilot-plugin.md`
- Modify: `plugins/sql-apps/skills/sql-apps-application/SKILL.md`
- Modify: `tests/guide.test.mjs`
- Modify: `tests/plugin.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

Assert the documentation contains:

```text
%USERPROFILE%\SqlAppsProjects
projects create
projects list
projects open
projects root set
```

Also assert:

- no primary new-user instruction says to edit the foundation checkout;
- create explicitly says it does not install, start, deploy, or open an editor;
- current directory is authoritative;
- Todo is not a starter;
- migration does not automatically move/delete worktrees.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test tests\guide.test.mjs dist\tests\plugin.test.js
```

Expected: FAIL on missing project-factory guidance.

- [ ] **Step 3: Update the primary journey**

Use this sequence consistently:

```powershell
sql-apps projects create "Equipment Checkout" --starter data
Set-Location "$env:USERPROFILE\SqlAppsProjects\equipment-checkout"
npm install
npm run setup -- approval --profile role-based-data
```

Clarify that the actual plugin invocation may use its installed absolute launcher
path, while `sql-apps` is the product command shown in documentation.

- [ ] **Step 4: Add migration guidance**

The migration guide must require:

1. inspect/stop owned services;
2. preserve uncommitted work;
3. create an independent clone/copy outside plugin source;
4. remove worktree coupling only after verifying the independent copy;
5. add/validate project manifest and pinned tooling;
6. run `projects open <path>`;
7. run setup and workflow validation;
8. leave source worktree deletion as an explicit later user action.

Include Todo and bakery paths as examples only, not hard-coded migration targets.

- [ ] **Step 5: Update the application skill**

Before domain implementation, require:

- resolve current directory to a valid generated/registered project;
- if currently in foundation/plugin source, create or open an independent project;
- never use Copilot worktree storage as the default user project root;
- keep factory actions separate from setup consent and deployment approval.

- [ ] **Step 6: Run documentation and plugin tests**

Run:

```powershell
node --test tests\guide.test.mjs
npm run build
node --test dist\tests\plugin.test.js
npm run plugin:check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add README.md docs\guides\getting-started.md docs\guides\build-your-app.md docs\guides\run-locally.md docs\guides\migrate-existing-project.md docs\reference\copilot-plugin.md plugins\sql-apps\skills\sql-apps-application\SKILL.md tests\guide.test.mjs tests\plugin.test.ts
git commit -m "docs: make independent projects the default" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 12: Full verification and release readiness

**Files:**
- Modify only files required by failures caused by Tasks 1-11.

- [ ] **Step 1: Regenerate deterministic artifacts**

Run:

```powershell
node scripts\update-starter-manifests.mjs
npm run build
npm run tooling:build
```

Expected: PASS.

- [ ] **Step 2: Run static and package checks**

Run:

```powershell
npm run typecheck
npm run plugin:check
npm run tooling:check
npm run app:check
git --no-pager diff --check
```

Expected: all commands PASS.

- [ ] **Step 3: Run the full test suite**

Run:

```powershell
npm test
```

Expected: PASS with zero failed tests.

- [ ] **Step 4: Perform a bounded real CLI smoke test**

Set a temporary user profile and invoke the packaged plugin launcher:

```powershell
$root = Join-Path $env:TEMP "sql-apps-project-factory-smoke"
$env:USERPROFILE = $root
node plugins\sql-apps\scripts\sql-apps.mjs projects create "Smoke Data" --starter data --json
node plugins\sql-apps\scripts\sql-apps.mjs projects create "Smoke Jobs" --starter files-jobs --json
node plugins\sql-apps\scripts\sql-apps.mjs projects list --json
```

Verify both projects are outside the repository, independently Git-initialized,
and contain no `.sql-apps`, `node_modules`, `dist`, examples, plugin source, or
foundation Git metadata. Remove only `$root` after resolving and confirming it
is beneath the temporary directory.

- [ ] **Step 5: Inspect final scope**

Run:

```powershell
git --no-pager status --short
git --no-pager diff --stat origin/main...HEAD
```

Confirm no existing user worktree was moved/deleted, no generated smoke project
is tracked, no credential/state file is staged, and pre-existing unrelated
changes are not included.

- [ ] **Step 6: Route any failure back to its owning task**

Do not patch failures in a catch-all verification commit. Return to the task
that owns the failing module, add the focused regression there, repeat that
task's commit, then rerun Task 12 from Step 1. Do not create an empty commit.
