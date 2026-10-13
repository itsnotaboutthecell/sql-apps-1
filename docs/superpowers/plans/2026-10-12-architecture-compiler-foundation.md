# Architecture Compiler Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, deterministic architecture compiler that turns a strict application intent into a canonical plan built from validated modules, with Azure SQL free-tier intent and DAB always present.

**Architecture:** This is the first of four implementation increments from the approved design. It adds contracts, catalog validation, an initial metadata-only module catalog, deterministic compilation, and an offline `architecture-plan` command. It does not provision Azure resources or change the current deployment paths; later plans will extract Bicep modules, unify orchestration, and update the plugin journey.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Zod 4, `node:test`, existing `npm run azure` CLI

---

## Scope and file structure

This plan deliberately stops at a working read-only compiler:

- `src/architecture-contract.ts` owns only brief, intent, and compiled-plan data contracts.
- `src/architecture-module.ts` owns the module descriptor and catalog structural validation.
- `src/architecture-catalog.ts` owns the initial reviewed module metadata.
- `src/architecture-compiler.ts` owns composition search, ranking, canonicalization, and fingerprints.
- `src/cli.ts` exposes the offline `architecture-plan` command.
- `azure-architecture-intent.example.json` is a valid example input.
- Tests are split by the same responsibilities.

Subsequent plans will cover:

1. Bicep/resource extraction and module execution contracts.
2. Plan-driven deployment state and legacy-path migration.
3. Plugin elicitation, recommendation, approval, agent evaluations, and final documentation migration.

No existing paid `foundation` or `role-based-data` configuration is converted or represented as a free-tier plan.

### Task 1: Add strict brief and intent contracts

**Files:**
- Create: `src/architecture-contract.ts`
- Test: `tests/architecture-contract.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `tests/architecture-contract.test.ts` with tests that prove:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationBriefSchema, architectureIntentSchema, briefFingerprint,
  type ApplicationBrief,
} from '../src/architecture-contract.js';

const brief: ApplicationBrief = {
  version: 1,
  audience: 'public',
  access: 'visitor-session',
  frontend: 'static',
  api: 'application',
  data: 'synthetic',
  files: false,
  backgroundWork: false,
  availability: 'proof-of-concept',
  observability: 'basic',
  growthPriority: 'simplest-start',
  acceptanceActions: ['Create an item and see it after reload'],
};

test('application briefs are service-agnostic, strict and fingerprinted canonically', () => {
  assert.deepEqual(applicationBriefSchema.parse(brief), brief);
  assert.match(briefFingerprint(brief), /^[a-f0-9]{64}$/);
  assert.equal(
    briefFingerprint(brief),
    briefFingerprint({ ...brief, acceptanceActions: [...brief.acceptanceActions] }),
  );
  assert.equal(applicationBriefSchema.safeParse({ ...brief, hosting: 'app-service' }).success, false);
  assert.equal(applicationBriefSchema.safeParse({ ...brief, acceptanceActions: [] }).success, false);
});

test('architecture intents contain goals, not resource definitions', () => {
  const intent = {
    version: 1,
    briefFingerprint: briefFingerprint(brief),
    capabilities: ['static-web', 'application-api', 'visitor-sessions'],
    guarantees: ['synthetic-data-only', 'same-origin-browser'],
    optimization: 'simplest-validated-start',
    growth: ['add-operational-observability'],
  };
  assert.deepEqual(architectureIntentSchema.parse(intent), intent);
  assert.equal(architectureIntentSchema.safeParse({ ...intent, resources: [] }).success, false);
  assert.equal(architectureIntentSchema.safeParse({
    ...intent, capabilities: ['static-web', 'static-web'],
  }).success, false);
});

test('contradictory brief choices fail explicitly', () => {
  assert.equal(applicationBriefSchema.safeParse({
    ...brief, access: 'anonymous', data: 'real',
  }).success, false);
  assert.equal(applicationBriefSchema.safeParse({
    ...brief, frontend: 'server-rendered', api: 'dab-only',
  }).success, false);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-contract.test.js
```

Expected: TypeScript fails because `src/architecture-contract.ts` does not exist.

- [ ] **Step 3: Implement the contracts**

Create `src/architecture-contract.ts` with:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';

const unique = <T extends z.ZodType<string>>(item: T) =>
  z.array(item).min(1).refine(values => new Set(values).size === values.length, 'Values must be unique');

export const capabilitySchema = z.enum([
  'static-web', 'server-rendered', 'application-api', 'visitor-sessions',
  'entra-auth', 'files', 'background-jobs', 'operational-observability',
]);
export type ArchitectureCapability = z.infer<typeof capabilitySchema>;

export const guaranteeSchema = z.enum([
  'synthetic-data-only', 'same-origin-browser', 'authenticated-users',
  'private-data-path', 'operational-investigation',
]);
export type ArchitectureGuarantee = z.infer<typeof guaranteeSchema>;

export const applicationBriefSchema = z.strictObject({
  version: z.literal(1),
  audience: z.enum(['private', 'invited', 'organization', 'public']),
  access: z.enum(['anonymous', 'visitor-session', 'entra']),
  frontend: z.enum(['static', 'server-rendered']),
  api: z.enum(['dab-only', 'application']),
  data: z.enum(['synthetic', 'real']),
  files: z.boolean(),
  backgroundWork: z.boolean(),
  availability: z.enum(['proof-of-concept', 'shared-preview', 'relied-upon']),
  observability: z.enum(['basic', 'operational']),
  growthPriority: z.enum(['simplest-start', 'continuity', 'stronger-isolation']),
  acceptanceActions: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
}).superRefine((brief, context) => {
  if (brief.access === 'anonymous' && brief.data === 'real') {
    context.addIssue({ code: 'custom', path: ['data'], message: 'Anonymous access is limited to synthetic data' });
  }
  if (brief.frontend === 'server-rendered' && brief.api === 'dab-only') {
    context.addIssue({ code: 'custom', path: ['api'], message: 'Server-rendered applications require application API logic' });
  }
});
export type ApplicationBrief = z.infer<typeof applicationBriefSchema>;

export const architectureIntentSchema = z.strictObject({
  version: z.literal(1),
  briefFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: unique(capabilitySchema),
  guarantees: z.array(guaranteeSchema)
    .refine(values => new Set(values).size === values.length, 'Values must be unique'),
  optimization: z.literal('simplest-validated-start'),
  growth: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/))
    .refine(values => new Set(values).size === values.length, 'Values must be unique'),
});
export type ArchitectureIntent = z.infer<typeof architectureIntentSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function briefFingerprint(input: ApplicationBrief): string {
  const brief = applicationBriefSchema.parse(input);
  return createHash('sha256').update(canonical(brief)).digest('hex');
}

export { canonical };
```

- [ ] **Step 4: Run the focused test**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-contract.test.js
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the contracts**

```powershell
git add src\architecture-contract.ts tests\architecture-contract.test.ts
git commit -m "feat: add adaptive architecture contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add module descriptors and catalog validation

**Files:**
- Create: `src/architecture-module.ts`
- Test: `tests/architecture-module.test.ts`

- [ ] **Step 1: Write failing catalog-validation tests**

Create `tests/architecture-module.test.ts` with a `module()` fixture and tests
for a valid catalog plus duplicate IDs, missing dependencies, dependency cycles,
incompatible required modules, and empty acceptance checks:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  architectureModuleSchema, validateModuleCatalog, type ArchitectureModule,
} from '../src/architecture-module.js';

function module(id: string, overrides: Partial<ArchitectureModule> = {}): ArchitectureModule {
  return architectureModuleSchema.parse({
    id, version: 1, surface: 1,
    provides: [`capability-${id}`],
    requiresCapabilities: [],
    requiresModules: [],
    incompatibleModules: [],
    guarantees: [],
    resources: [{ type: `Test/${id}`, purpose: id }],
    acceptanceChecks: [`verify-${id}`],
    growthTransitions: [],
    ...overrides,
  });
}

test('validates a complete acyclic module catalog', () => {
  const catalog = validateModuleCatalog([
    module('core'),
    module('api', { requiresModules: ['core'] }),
  ]);
  assert.deepEqual([...catalog.keys()], ['api', 'core']);
});

test('rejects malformed module catalogs', () => {
  assert.throws(() => validateModuleCatalog([module('core'), module('core')]), /Duplicate module core/);
  assert.throws(() => validateModuleCatalog([
    module('api', { requiresModules: ['missing'] }),
  ]), /unknown module missing/);
  assert.throws(() => validateModuleCatalog([
    module('a', { requiresModules: ['b'] }),
    module('b', { requiresModules: ['a'] }),
  ]), /dependency cycle/i);
  assert.throws(() => validateModuleCatalog([
    module('core'),
    module('api', { requiresModules: ['core'], incompatibleModules: ['core'] }),
  ]), /requires and rejects core/);
  assert.equal(architectureModuleSchema.safeParse({
    ...module('core'), acceptanceChecks: [],
  }).success, false);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-module.test.js
```

Expected: TypeScript fails because `src/architecture-module.ts` does not exist.

- [ ] **Step 3: Implement the descriptor and validator**

Create `src/architecture-module.ts`. Define:

```ts
export const architectureModuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  version: z.number().int().positive(),
  surface: z.number().int().nonnegative(),
  provides: uniqueNameArray,
  requiresCapabilities: nameArray,
  requiresModules: nameArray,
  incompatibleModules: nameArray,
  guarantees: nameArray,
  resources: z.array(z.strictObject({
    type: z.string().min(1),
    sku: z.string().min(1).optional(),
    purpose: z.string().min(1),
  })),
  acceptanceChecks: uniqueNameArray,
  growthTransitions: nameArray,
});
```

Export `ArchitectureModule`, `ArchitectureModuleCatalog`, and
`validateModuleCatalog(input)`. The validator must:

1. Parse every descriptor.
2. Reject duplicate IDs.
3. Sort the returned `Map` by module ID.
4. Reject unknown required/incompatible/growth module IDs.
5. Reject a module that both requires and rejects the same module.
6. Use depth-first traversal with `visiting` and `visited` sets to reject cycles
   and include the cycle path in the error.

- [ ] **Step 4: Run the focused test**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-module.test.js
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit the module contract**

```powershell
git add src\architecture-module.ts tests\architecture-module.test.ts
git commit -m "feat: validate architecture module catalogs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Add the initial reviewed metadata catalog

**Files:**
- Create: `src/architecture-catalog.ts`
- Test: `tests/architecture-catalog.test.ts`

- [ ] **Step 1: Write failing catalog-policy tests**

Create `tests/architecture-catalog.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectureCatalog, mandatoryArchitectureModules } from '../src/architecture-catalog.js';

test('Azure SQL free enrollment and DAB are mandatory and paid fallback is absent', () => {
  assert.deepEqual(mandatoryArchitectureModules, ['azure-sql-free', 'dab']);
  const sql = architectureCatalog.get('azure-sql-free')!;
  assert.ok(sql.guarantees.includes('no-paid-sql-fallback'));
  assert.ok(sql.acceptanceChecks.includes('verify-sql-free-enrollment'));
  assert.equal([...architectureCatalog.keys()].some(id => /paid-sql|bill-overage/.test(id)), false);
  assert.ok(architectureCatalog.get('dab')!.requiresCapabilities.includes('dab-runtime'));
});

test('optional capabilities are separate modules', () => {
  assert.ok(architectureCatalog.get('static-web'));
  assert.ok(architectureCatalog.get('visitor-session-api'));
  assert.ok(architectureCatalog.get('entra-identity'));
  assert.ok(architectureCatalog.get('files'));
  assert.ok(architectureCatalog.get('background-jobs'));
  assert.ok(architectureCatalog.get('log-analytics'));
  assert.equal(architectureCatalog.get('dab')!.requiresModules.includes('log-analytics'), false);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-catalog.test.js
```

Expected: TypeScript fails because `src/architecture-catalog.ts` does not exist.

- [ ] **Step 3: Implement the initial catalog**

Create `src/architecture-catalog.ts` and validate a constant descriptor array
with `validateModuleCatalog`. Include these exact module IDs:

| Module | Provides | Required modules/capabilities |
| --- | --- | --- |
| `azure-sql-free` | `sql` | none |
| `dab` | `data-api` | module `azure-sql-free`, capability `dab-runtime` |
| `container-apps-dab-runtime` | `dab-runtime` | modules `managed-identity`, `container-images` |
| `managed-identity` | `managed-identity` | none |
| `container-images` | `container-images` | none |
| `static-web` | `static-web` | none |
| `node-api` | `application-api` | capability `node-runtime` |
| `container-apps-node-runtime` | `node-runtime` | modules `managed-identity`, `container-images` |
| `visitor-session-api` | `visitor-sessions` | module `node-api` |
| `entra-identity` | `entra-auth` | module `node-api` |
| `files` | `files` | modules `node-api`, `managed-identity` |
| `background-jobs` | `background-jobs` | modules `node-api`, `managed-identity` |
| `log-analytics` | `operational-observability` | none |

Use resource metadata only; do not call Azure or claim these descriptors can yet
provision resources. Give each module at least one explicit acceptance check.
Set lower `surface` values for modules with fewer resources.

Export:

```ts
export const mandatoryArchitectureModules = ['azure-sql-free', 'dab'] as const;
export const architectureCatalog = validateModuleCatalog(descriptors);
```

- [ ] **Step 4: Run catalog and contract tests**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-contract.test.js dist/tests/architecture-module.test.js dist/tests/architecture-catalog.test.js
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit the initial catalog**

```powershell
git add src\architecture-catalog.ts tests\architecture-catalog.test.ts
git commit -m "feat: add reviewed architecture module catalog" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Implement deterministic compilation

**Files:**
- Create: `src/architecture-compiler.ts`
- Test: `tests/architecture-compiler.test.ts`

- [ ] **Step 1: Write failing compiler tests**

Create `tests/architecture-compiler.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileArchitecture } from '../src/architecture-compiler.js';

const base = {
  version: 1 as const,
  briefFingerprint: 'a'.repeat(64),
  capabilities: ['static-web', 'application-api', 'visitor-sessions'] as const,
  guarantees: ['synthetic-data-only', 'same-origin-browser'] as const,
  optimization: 'simplest-validated-start' as const,
  growth: ['add-operational-observability'],
};

test('compiles the smallest canonical plan with mandatory SQL and DAB', () => {
  const first = compileArchitecture(base);
  const second = compileArchitecture({ ...base, capabilities: [...base.capabilities].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.mandatoryCore, ['azure-sql-free', 'dab']);
  assert.ok(first.modules.includes('azure-sql-free'));
  assert.ok(first.modules.includes('dab'));
  assert.ok(first.modules.includes('container-apps-dab-runtime'));
  assert.ok(first.modules.includes('visitor-session-api'));
  assert.equal(first.modules.includes('entra-identity'), false);
  assert.equal(first.modules.includes('log-analytics'), false);
  assert.match(first.approval, /^[a-f0-9]{12}$/);
  assert.equal(first.authorized, false);
  assert.equal(first.deployable, false);
});

test('selects optional modules only for requested capabilities', () => {
  const plan = compileArchitecture({
    ...base,
    capabilities: ['static-web', 'application-api', 'entra-auth', 'files', 'operational-observability'],
    guarantees: ['authenticated-users', 'operational-investigation'],
  });
  for (const id of ['entra-identity', 'files', 'log-analytics']) assert.ok(plan.modules.includes(id));
  assert.equal(plan.modules.includes('visitor-session-api'), false);
});

test('fails closed for unsupported capabilities and never emits deployment-shaped output', () => {
  assert.throws(() => compileArchitecture({
    ...base, capabilities: ['server-rendered'],
  }), /No supported module provides server-rendered/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-compiler.test.js
```

Expected: TypeScript fails because `src/architecture-compiler.ts` does not exist.

- [ ] **Step 3: Implement composition search**

Create `src/architecture-compiler.ts` with:

```ts
export interface CompiledArchitecturePlan {
  version: 1;
  briefFingerprint: string;
  optimization: 'simplest-validated-start';
  mandatoryCore: string[];
  modules: string[];
  resources: { type: string; sku?: string; purpose: string; module: string }[];
  guarantees: string[];
  acceptanceChecks: string[];
  growth: string[];
  limitations: string[];
  authorized: false;
  deployable: false;
  approval: string;
}
```

Implement `compileArchitecture(input, catalog = architectureCatalog)`:

1. Parse and sort intent arrays.
2. Seed selection with `mandatoryArchitectureModules`.
3. Recursively add required modules.
4. For each unsatisfied capability, branch over catalog providers sorted by ID.
5. Close dependencies after each branch.
6. Reject branches containing incompatible modules.
7. Keep complete branches, ranked by:
   - module count;
   - sum of `surface`;
   - lexicographically joined module IDs.
8. If no branch completes, throw `No supported module provides <capability>` or
   an incompatibility message naming both modules.
9. Canonicalize modules, resources, guarantees, checks, and growth.
10. Set `authorized: false` and `deployable: false`; this foundation is review
    only.
11. Hash the canonical plan without `approval`, then use the first 12 hex
    characters as `approval`.
12. Include limitations stating that Azure eligibility is unverified, resource
    modules are metadata-only, costs are not quoted, and no Azure writes are
    authorized.

- [ ] **Step 4: Run compiler tests**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-compiler.test.js
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the compiler**

```powershell
git add src\architecture-compiler.ts tests\architecture-compiler.test.ts
git commit -m "feat: compile canonical architecture plans" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Add the offline architecture-plan command

**Files:**
- Modify: `src/cli.ts:1-60`
- Create: `azure-architecture-intent.example.json`
- Test: `tests/architecture-cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/architecture-cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../src/process.js';

test('architecture-plan is offline, read-only and emits a non-deployable canonical plan', async t => {
  const example = JSON.parse(await readFile('azure-architecture-intent.example.json', 'utf8'));
  const output = JSON.parse(await run(process.execPath, [
    resolve('dist/src/cli.js'), 'architecture-plan', resolve('azure-architecture-intent.example.json'),
  ]));
  assert.equal(output.authorized, false);
  assert.equal(output.deployable, false);
  assert.deepEqual(output.mandatoryCore, ['azure-sql-free', 'dab']);
  assert.match(output.approval, /^[a-f0-9]{12}$/);
  assert.equal(example.version, 1);

  const directory = await mkdtemp(join(tmpdir(), 'sql-apps-architecture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = join(directory, 'invalid.json');
  await writeFile(invalid, JSON.stringify({ ...example, resources: [] }));
  await assert.rejects(run(process.execPath, [
    resolve('dist/src/cli.js'), 'architecture-plan', invalid,
  ]), /Unrecognized key.*resources|failed \\(1\\)/s);
});

test('help describes architecture-plan as read-only and not deployment approval', async () => {
  const output = await run(process.execPath, [resolve('dist/src/cli.js'), 'help']);
  assert.match(output, /architecture-plan/);
  assert.match(output, /offline.*read-only.*no Azure writes/i);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-cli.test.js
```

Expected: tests fail with `Unknown command: architecture-plan`.

- [ ] **Step 3: Add the example intent**

Create `azure-architecture-intent.example.json`:

```json
{
  "version": 1,
  "briefFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "capabilities": [
    "static-web",
    "application-api",
    "visitor-sessions"
  ],
  "guarantees": [
    "synthetic-data-only",
    "same-origin-browser"
  ],
  "optimization": "simplest-validated-start",
  "growth": [
    "add-operational-observability"
  ]
}
```

- [ ] **Step 4: Wire the CLI command**

In `src/cli.ts`, import `compileArchitecture`, add `architecture-plan` to the help
command list, and add this branch before commands that load deployment configs:

```ts
if (command === 'architecture-plan') {
  if (process.argv.length !== 4) {
    throw new Error('Usage: architecture-plan <architecture-intent.json>');
  }
  const intent: unknown = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  console.log(JSON.stringify(compileArchitecture(intent), null, 2));
  return;
}
```

Add a help line:

```ts
console.log('Architecture: architecture-plan <intent.json> compiles an offline, read-only recommendation. It performs no Azure calls or writes and is not deployment approval.');
```

- [ ] **Step 5: Run CLI and compiler tests**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-contract.test.js dist/tests/architecture-module.test.js dist/tests/architecture-catalog.test.js dist/tests/architecture-compiler.test.js dist/tests/architecture-cli.test.js
```

Expected: all architecture tests pass.

- [ ] **Step 6: Commit the offline command**

```powershell
git add src\cli.ts tests\architecture-cli.test.ts azure-architecture-intent.example.json
git commit -m "feat: add offline architecture planning command" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Lock the legacy billing migration boundary

**Files:**
- Create: `tests/architecture-migration.test.ts`
- Modify: `docs/reference/deployment.md`
- Modify: `docs/reference/demo-deployment.md`

- [ ] **Step 1: Write the migration-boundary test**

Create `tests/architecture-migration.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileArchitecture } from '../src/architecture-compiler.js';

test('compiler plans always use the free-tier core and cannot ingest legacy deployment configs', async () => {
  const legacy = JSON.parse(await readFile('azure-role-based.example.json', 'utf8'));
  assert.throws(() => compileArchitecture(legacy), /Unrecognized key|Invalid input/);
  const plan = compileArchitecture({
    version: 1,
    briefFingerprint: 'b'.repeat(64),
    capabilities: ['static-web', 'application-api', 'entra-auth'],
    guarantees: ['authenticated-users'],
    optimization: 'simplest-validated-start',
    growth: [],
  });
  assert.ok(plan.modules.includes('azure-sql-free'));
  assert.equal(plan.modules.some(id => /paid-sql/.test(id)), false);
});

test('deployment references forbid automatic conversion of paid legacy databases', async () => {
  const docs = `${await readFile('docs/reference/deployment.md', 'utf8')}\n${
    await readFile('docs/reference/demo-deployment.md', 'utf8')}`;
  assert.match(docs, /architecture-plan/);
  assert.match(docs, /does not convert.*existing.*database/is);
  assert.match(docs, /not deployment approval/i);
});
```

- [ ] **Step 2: Run the test and verify the documentation assertion fails**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-migration.test.js
```

Expected: the code boundary passes and the documentation assertion fails because
the new command is not documented.

- [ ] **Step 3: Document the read-only foundation**

Add a short **Adaptive architecture planning** section to
`docs/reference/deployment.md` and cross-link it from
`docs/reference/demo-deployment.md`. State exactly:

- `architecture-plan` accepts a strict architecture intent and performs no Azure
  calls or writes.
- Azure SQL free-tier intent and DAB are mandatory.
- Output is metadata-only, `authorized: false`, and `deployable: false`.
- The command makes no pricing claim and does not verify Azure eligibility.
- It does not convert an existing database or legacy paid deployment.
- Existing deployment commands remain authoritative until later migration
  plans pass parity and live acceptance.

Do not modify the existing uncommitted edits in
`docs/guides/costs.md`, `docs/maintainers/hosting-decision.md`, or
`docs/reference/demo-cost.md`.

- [ ] **Step 4: Run the migration and architecture tests**

Run:

```powershell
npm run build
npx tsc
node --test dist/tests/architecture-*.test.js
```

Expected: all architecture tests pass.

- [ ] **Step 5: Commit the migration boundary**

```powershell
git add tests\architecture-migration.test.ts docs\reference\deployment.md docs\reference\demo-deployment.md
git commit -m "docs: define architecture compiler migration boundary" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 7: Run full validation and record the foundation checkpoint

**Files:**
- Modify only files required to fix failures caused by Tasks 1-6.

- [ ] **Step 1: Run formatting and type validation**

Run:

```powershell
git --no-pager diff --check
npm run typecheck
```

Expected: no whitespace errors and TypeScript exits 0.

- [ ] **Step 2: Run the full repository suite**

Run:

```powershell
npm test
```

Expected: all root and example tests pass.

- [ ] **Step 3: Run infrastructure and DAB validation**

Run:

```powershell
npm run infra:test-demo
npm run dab:validate
```

Expected: infrastructure tests pass and DAB schema validation succeeds.

- [ ] **Step 4: Inspect the final diff**

Run:

```powershell
git --no-pager status --short
git --no-pager diff --stat HEAD~6..HEAD
```

Expected: only compiler-foundation files and the two intended deployment
references are part of this implementation. The pre-existing edits in
`docs/guides/costs.md`, `docs/maintainers/hosting-decision.md`, and
`docs/reference/demo-cost.md`, plus untracked `.azure/` and `.vscode/`, remain
unstaged and unchanged.

- [ ] **Step 5: Commit any verification-only correction**

If validation required a correction, commit only the affected compiler files:

```powershell
git add -- src\architecture-contract.ts src\architecture-module.ts src\architecture-catalog.ts src\architecture-compiler.ts src\cli.ts tests\architecture-contract.test.ts tests\architecture-module.test.ts tests\architecture-catalog.test.ts tests\architecture-compiler.test.ts tests\architecture-cli.test.ts tests\architecture-migration.test.ts azure-architecture-intent.example.json docs\reference\deployment.md docs\reference\demo-deployment.md
git commit -m "fix: complete architecture compiler foundation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no correction was needed, do not create an empty commit.

## Completion criteria

- A strict application intent can be compiled offline through
  `npm run azure -- architecture-plan <intent.json>`.
- Every plan contains `azure-sql-free` and `dab`.
- Unsupported capabilities fail without deployment-shaped output.
- Optional modules appear only when required.
- Plan ordering and approval fingerprints are deterministic.
- Output explicitly remains unauthorized and non-deployable.
- Legacy paid deployment configurations are rejected rather than converted.
- Existing deployment behavior and tests remain unchanged.
