# Adaptive Azure architecture compiler

## Decision

SQL Apps will replace infrastructure-first deployment choices with a validated
architecture compiler.

Every cloud deployment has two universal components:

1. Azure SQL Database with free-tier enrollment requested, live eligibility
   checked, and no automatic paid fallback.
2. Data API builder (DAB) with a validated hosting and trust boundary.

All other services are selected because the application requires them. The LLM
interprets the user's goals and recommends one architecture. The plugin owns the
finite set of supported modules, deterministic compilation, policy enforcement,
deployment, and verification.

This makes selection adaptive without allowing the LLM to invent infrastructure
that the repository cannot validate or support.

## Goals

- Let a non-technical user describe an application instead of choosing Azure
  services.
- Recommend the simplest validated starting architecture that satisfies the
  application brief.
- Preserve a documented path for adding capabilities as the application grows.
- Keep Azure SQL free-tier enrollment and DAB as universal cloud requirements.
- Select hosting, identity, files, jobs, networking, registry, and observability
  only when required by the brief or by another selected module.
- Use one explanation and one approval for the exact compiled deployment plan.
- Preserve the security, resumability, source binding, and acceptance guarantees
  of the current deployment paths.
- Describe resources, SKUs, eligibility, and allowances factually without
  claiming that a deployment is free, cheapest, or guaranteed to remain within
  an allowance.

## Non-goals

- Supporting every possible Azure service combination.
- Generating Bicep or deployment code from an unconstrained LLM response.
- Automatically changing region, billing mode, security posture, or architecture
  after a failed preflight.
- Automatically upgrading resources when usage grows.
- Replacing live Azure eligibility, availability, quota, or cost review with an
  offline estimate.
- Removing the existing deployment paths before equivalent compiled plans pass
  their current tests and live acceptance gates.

## Ownership boundary

### LLM

The LLM:

- asks about users, access, frontend behavior, API behavior, files, background
  work, availability, and growth priorities;
- creates a service-agnostic application brief;
- maps the brief to required capabilities and an architecture intent;
- requests compilation;
- explains the compiled resource plan, limitations, and growth path; and
- asks once for approval of that exact plan.

The LLM does not:

- write raw deployment templates;
- select unregistered modules;
- bypass module incompatibilities;
- silently enable paid SQL continuation;
- weaken SQL or DAB access;
- broaden networking;
- add or remove resources after approval; or
- make unsupported pricing claims.

### Plugin

The plugin:

- validates the brief and architecture intent;
- enforces the Azure SQL and DAB core;
- owns the module catalog and compatibility rules;
- compiles the exact resource plan;
- produces a canonical approval fingerprint;
- runs provider, target, and eligibility preflight;
- runs Azure What-If before writes;
- executes one resumable plan-driven deployment;
- verifies module-specific acceptance contracts; and
- records supported growth transitions.

The plugin defines rules and building blocks rather than one permanent
architecture.

## Contracts

All contracts are strict, versioned, and reject unknown fields.

### Application brief

The application brief contains user goals rather than Azure service names. It
records:

- audience: private individual, invited users, organization, or public;
- access: anonymous, visitor session, or Entra-authenticated;
- frontend: static assets or server-rendered behavior;
- API needs: DAB-only data access or additional application logic;
- data policy: synthetic or real data and applicable ownership boundaries;
- files: absent or required;
- background work: absent or required;
- availability expectation: proof of concept, shared preview, or relied-upon;
- observability need: basic deployment evidence or operational investigation;
- growth priority: simplest start, continuity, or stronger isolation; and
- application capabilities and acceptance actions.

The brief cannot request a SKU, Azure product, network topology, or billing
fallback.

### Architecture intent

The LLM derives an architecture intent from the brief. The intent contains:

- contract version;
- source-brief fingerprint;
- required capabilities;
- security and availability guarantees;
- optimization priority, initially `simplest-validated-start`;
- requested growth characteristics; and
- explanation inputs used to produce the recommendation.

The intent does not contain arbitrary resource definitions. Azure SQL free-tier
enrollment and DAB are inserted as mandatory requirements by the validator, not
left to LLM discretion.

### Compiled plan

The compiler produces a canonical plan containing:

- selected module IDs and versions;
- dependency order;
- exact resource types, SKUs, and reviewed parameters;
- inputs and outputs for each module;
- security guarantees and trust boundaries;
- known limitations and live checks still required;
- deployment and acceptance stages;
- cleanup ownership;
- supported growth transitions;
- source/artifact fingerprints; and
- an approval fingerprint over the entire canonical plan.

The compiled plan is the deployment subject. A changed module, parameter,
artifact, source fingerprint, target, or stage set invalidates approval.

## Module catalog

Each module has one clear purpose and exposes a typed descriptor:

- stable ID and contract version;
- capabilities provided;
- capabilities and modules required;
- incompatible capabilities and modules;
- security guarantees;
- target/provider prerequisites;
- configuration schema;
- resource inventory and template implementation;
- outputs;
- deployment stages;
- acceptance checks;
- cleanup behavior;
- operational caveats; and
- supported growth transitions.

Catalog validation rejects:

- duplicate IDs;
- unknown dependencies;
- dependency cycles;
- conflicting providers;
- contradictory security guarantees;
- outputs with no producer;
- required inputs with no source;
- modules without acceptance coverage; and
- growth transitions whose destination is not a supported composition.

Internal module implementation can change without changing the application brief
or architecture intent. A change to a module's externally observable contract
requires a module contract-version change.

## Initial module boundaries

### Mandatory core

`azure-sql-free` preserves:

- explicit free-tier enrollment intent;
- the reviewed serverless free-tier sizing contract;
- pause-at-monthly-limit behavior;
- local backup redundancy for that contract;
- explicit region, subscription, and free-slot eligibility checks;
- no paid-continuation fallback;
- schema deployment; and
- application-specific SQL grants.

`dab` preserves:

- explicit entities and permissions;
- production authentication appropriate to the access model;
- trusted claim forwarding;
- no caller-controlled identity headers;
- schema/object-scoped SQL permissions;
- configuration validation; and
- REST/GraphQL or stored-procedure acceptance appropriate to the application.

DAB requires a compatible runtime module. The core contract does not globally
fix that runtime to Container Apps, App Service, or another host.

### Optional capabilities

The initial catalog extracts current behavior into modules for:

- static web delivery;
- Node application API hosting;
- DAB runtime hosting;
- Entra application identity and role authorization;
- visitor sessions;
- Blob Storage;
- Azure Functions/background processing;
- managed identity;
- private or restricted SQL connectivity;
- container registry/image distribution;
- Log Analytics and diagnostic routing; and
- backup/audit/recovery posture beyond the free-tier core.

Log Analytics is not universal. It is selected when the application brief needs
operational investigation or when a selected runtime module declares it as a
support prerequisite.

Only combinations that pass the repository's security and live acceptance gates
are advertised as supported.

## Compilation

Compilation is deterministic:

1. Validate the application brief.
2. Validate the architecture intent and insert mandatory core requirements.
3. Filter catalog modules by required guarantees and target compatibility.
4. Resolve all module dependencies.
5. Reject incompatible or cyclic compositions.
6. Minimize the composition by module count and declared operational surface.
7. Apply stable module-ID tie-breaking.
8. Produce the canonical plan and approval fingerprint.

The compiler never silently substitutes a different architecture. If two
compositions remain semantically distinct after deterministic ranking, it
returns an ambiguity that the LLM must resolve in a revised, explained intent.

An unsupported intent returns:

- the unsatisfied capability or guarantee;
- the conflicting modules or requirements;
- the smallest brief change that would permit a supported plan; and
- no deployment-shaped output.

## User journey

The cloud-sharing journey becomes:

1. The LLM asks only application-level questions.
2. The LLM writes the application brief and architecture intent.
3. The plugin compiles the intent.
4. The LLM presents one recommendation:
   - selected services;
   - why each service is present;
   - known limitations;
   - live eligibility and target checks still required; and
   - supported growth path.
5. The user approves once.
6. The plugin verifies that approval matches the canonical plan.
7. Preflight and Azure What-If run before resource writes.
8. Deployment executes and resumes by plan stage.
9. Module-specific acceptance checks verify the deployed result.

The user is not asked to choose App Service, Static Web Apps, Container Apps,
networking, registries, or observability without application context.

## Deployment and state

One plan-driven state machine replaces profile-specific planning and resume
logic. Modules contribute stages and dependencies; the orchestrator executes the
resulting directed acyclic graph in stable order.

The state records:

- plan and approval fingerprints;
- workspace and source identity;
- artifact fingerprints;
- Azure target identity;
- completed module stages;
- validated outputs;
- failure stage and error category; and
- owned resources eligible for cleanup.

State writes remain atomic. A copied state file, changed checkout, changed SQL or
DAB source, changed image digest, changed target, or changed compiled plan stops
resume before cloud writes.

## Failure behavior

- Invalid briefs and intents return field-specific validation errors.
- Unsupported compositions return explicit capability/module conflicts.
- Unavailable SQL free-tier enrollment stops deployment. The system does not
  change region, enable paid continuation, or deploy ordinary paid SQL.
- Failed provider registration, target validation, What-If, provisioning,
  schema publication, runtime configuration, or acceptance leaves a visible
  failed stage.
- Resume starts only from verified completed stages.
- Any plan change requires a new explanation and approval.
- The system does not return success-shaped output for a partial deployment.

## Resource and cost disclosure

The product reports:

- exact selected resources and SKUs;
- whether SQL free-tier enrollment was requested and verified;
- documented allowance and exhaustion behavior;
- target-specific eligibility or quota checks;
- resources that may incur charges;
- monitoring or alerting that is and is not configured; and
- links for current regional/account review.

The product does not report:

- guaranteed zero cost;
- a cheapest-provider or cheapest-architecture claim;
- a monthly estimate without separately reviewed evidence; or
- a promise that usage remains within an allowance.

In this design, "optimal" means the simplest validated starting architecture
with a documented growth path.

## Growth

Growth is a new planning event, not an automatic scale action. A new requirement
or observed operational limitation updates the brief and produces a new compiled
plan.

Each transition states:

- the trigger;
- retained resources and data;
- added, changed, and removed modules;
- migration and rollback boundaries;
- new limitations and live checks; and
- whether the public endpoint or identity contract changes.

The user reviews and approves the new plan before changes occur.

## Compatibility baseline

The first implementation preserves these current paths as compatibility
compositions:

| Current path | Behavior that must remain covered |
| --- | --- |
| `public-demo` | Synthetic data only; visitor sessions; Azure SQL free-tier intent; DAB internal to the API boundary; same-origin browser access; session/data limits; immutable artifacts; staged publication; direct-backend denial; CRUD, cold-start, readiness, cleanup, and ownership acceptance. |
| `role-based-data` | Entra delegated access; required human application role; gateway and DAB only; explicit stored-procedure entities and grants; no files, jobs, Functions, storage, or Key Vault; private SQL boundary; authorized/unauthorized token acceptance. |
| `foundation` | Entra delegated access; gateway, DAB, files, and Functions; managed identity; restricted SQL access; private file ownership; two-user REST and GraphQL reads; file/function invocation; anonymous rejection; SQL audit and recovery outputs. |

Existing commands and templates remain available until an equivalent compiled
composition passes the original unit, infrastructure, deployment, smoke, and
live acceptance gates.

## Verification

### Contract tests

- Strict application-brief and intent parsing.
- Mandatory core insertion.
- Contradictory-goal rejection.
- Module descriptor validation.
- Dependency-cycle and incompatibility rejection.
- Missing acceptance-contract rejection.

### Compiler tests

- Golden canonical plans.
- Stable ordering and fingerprints.
- Minimal supported composition selection.
- Explicit ambiguity and unsatisfied-capability errors.
- No paid SQL fallback.
- No unregistered module output.

### Infrastructure tests

- Compile every supported Bicep composition.
- Assert exact resource types and module exclusions.
- Assert SQL free-tier settings.
- Assert DAB trust boundaries and grants.
- Assert optional services are absent unless selected.

### Orchestration tests

- Approval binding and stale-plan rejection.
- Atomic state and resume behavior.
- Changed checkout/source/artifact/target rejection.
- Failed-stage retention.
- Module dependency ordering.
- Cleanup ownership.

### Acceptance tests

- Reuse current public-demo, role-based, and foundation acceptance suites.
- Add module-specific positive and negative controls.
- Require live acceptance before a new composition is documented as supported.
- Test growth transitions separately from fresh deployments.

### Agent evaluations

- The LLM asks application questions rather than infrastructure questions.
- The recommendation contains one compiled supported plan.
- The explanation makes no guarantee of zero or cheapest cost.
- SQL eligibility failure produces a stop, not a paid fallback.
- Unsupported requirements produce an explicit revision, not invented Bicep.
- A changed plan requires a new approval.

## Migration sequence

1. Add the strict brief, intent, module, and compiled-plan contracts.
2. Record current profile behavior as compatibility tests.
3. Extract Azure SQL free-tier and DAB core modules without changing deployment.
4. Extract optional modules behind the catalog contract.
5. Add deterministic compilation and canonical plan review.
6. Add the plan-driven orchestrator while retaining profile adapters.
7. Route plugin guidance through brief, intent, compile, explain, and approve.
8. Prove parity for current paths.
9. Add and live-validate simpler starting compositions.
10. Deprecate duplicated profile-specific orchestration only after parity and
    migration documentation are complete.

The migration does not start by deleting current templates or deployment
commands.

## Simplification result

This design substantially simplifies the user journey and consolidates repeated
planning, approval, state, and orchestration logic. It does not remove Azure's
inherent infrastructure complexity. It moves that complexity behind stable,
testable module contracts.

Allowing arbitrary LLM-generated infrastructure would increase the number of
security boundaries, combinations, tests, and support cases. The compiler is the
boundary that makes adaptive architecture simpler and supportable.
