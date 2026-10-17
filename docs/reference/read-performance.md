# Design and verify application reads

Use this reference for a new or changed list, search, dashboard or detail read, or an existing slow read. Visual-only changes do not require a performance investigation. SQL Apps owns the application read contract and user-action evidence; the maintained microsoft-sql skills own database tuning.

## 1. Agree on the read contract

Reuse the saved brief and existing behavior. Ask only about consequential missing choices:

- User action, authorized users/owners, required columns and expected data scale.
- Server-side filters, sort order, result bound or pagination, and how users reach remaining records.
- Freshness and read-after-write expectations, including changes by other users.
- Acceptable end-to-end latency and relevant concurrency, with cold-start behavior distinguished from warm reads.

Agree limits and targets per feature, not globally. "Faster" permits measuring improvement but does not define an acceptance threshold. Do not silently truncate results, invent totals or change refresh behavior.

## 2. Avoid unnecessary work

Use the existing procedure, DAB and client contracts; verify their actual capabilities before choosing a paging mechanism.

- Return explicit required columns and authorized rows. Apply filtering, sorting and appropriate aggregation server-side rather than fetching the whole table to display a subset.
- Bound list reads. Pagination needs deterministic ordering with a unique tie-breaker; preserve filter, sort and authorization scope across pages. Test reachable remaining records and the agreed behavior when records change.
- Count requests per action. Look for N+1 fetches, duplicate requests, refresh loops, unnecessary polling and request fan-out. Remove redundant work or use an appropriate existing set-based read before proposing a cache.
- Inspect payload size and result consumption as well as SQL execution. A fast query does not prove a fast screen; a slow screen does not prove SQL is the bottleneck.

Preserve owner isolation, validation, Unicode/date correctness, mutation visibility and explicit errors. Do not add `NOLOCK`, optimizer hints or speculative indexes as defaults. Physical schema/index changes belong to specialist analysis and a reviewed migration. Narrowing a declared string maximum alone does not demonstrate smaller stored rows or faster reads.

## 3. Isolate a slow action before escalating

Confirm the application checkout, workspace, origin and local/cloud database. Record the action, observed delay, target and UTC window. Trace available browser/request, gateway/API, DAB/SQL and result-consumption evidence for that same action. Concurrent requests can overlap; do not subtract unrelated aggregate timings to invent a latency breakdown.

Keep collection bounded and read-only, using an authorized operator identity rather than broadening the application's permissions. Missing timings, permissions or services are evidence gaps, not healthy results. Do not replay unknown-cost production queries, generate load, restart services, clear caches/counters, change Query Store or install plugins as diagnostic collection. Fixture writes, load generation and remedial changes require their own approval.

Load a specialist only after evidence identifies its boundary:

| Isolated question | Maintained skill |
| --- | --- |
| Slow SQL or query-plan regression | `diagnose-slow-query` |
| Interpret a specific execution plan | `read-execution-plan` |
| Blocking chain or deadlocks | `diagnose-blocking-and-deadlocks` |
| Resource pressure or service governance | `diagnose-resource-pressure` |
| Database connection failures | `diagnose-connection-errors` |

For cloud resource samples and cost/capacity decisions, reuse [Monitor usage and growth](monitor-growth.md), not another monitoring workflow. Local preview results do not prove cloud capacity or cold-start behavior.

If the companion is unavailable, report the missing specialist and hand over the action, target, window, observed evidence and isolated question. See [companion plugin installation](copilot-plugin.md#install-companion-plugins-for-cloud-work); installation is a separate decision, not an automatic prerequisite for application-side diagnosis. Do not replace it with a competing DMV cookbook.

## 4. Consider a cache only under a separate contract

High execution counts, query hashes, plan handles and repeated row counts do not prove identical parameters, stable contents or interchangeable authorization. First establish equivalent repeated reads, their contribution to the slow action and the owner's acceptable freshness window. Do not introduce a cache or choose a technology or TTL solely from those counters.

A justified cache proposal must define:

- **Access:** authenticate and authorize each request; a cache hit never grants access. The cache key must distinguish tenant, owner/user and authorization scope as required, plus parameters, filters, sort and page. Tenant-only keys are insufficient for owner-scoped data. Never put raw credentials/tokens in keys or evidence.
- **Freshness and invalidation:** expiry, edits/deletes, read-after-write visibility, other writers, account switching/sign-out and permission revocation. Cached results must not outlive the requester's access.
- **Operation:** bounded cache memory/cardinality, ownership of invalidation, and explicit miss/failure behavior. Preserve established errors; never conceal backend failures with empty or stale success.
- **Verification:** positive and denied/foreign access controls, account/permission changes and mutation/reload behavior, alongside measured latency and request reductions.

An existing cache needs the same review. A cache layer is not a substitute for correct authorization or evidence that redundant requests were removed.

## 5. Measure before and after

For performance work or a relevant changed read path, keep a before/after record:

| Evidence | Record |
| --- | --- |
| Identity of the run | User action/endpoint, source/build, intended origin, local/cloud environment and UTC window |
| Workload | Synthetic data scale, parameter/filter/sort cases, concurrency, cold or warm state |
| Measurements | Sample count, end-to-end durations, request count and payload size where observed; SQL duration/reads only when available |
| Change | One attributable change, expected effect, named rollback and any confounding differences |
| Correctness | Same action plus existing access, validation, save/reload and mutation-visibility controls |

Use existing supported tools and approved synthetic fixtures, not a new benchmark framework or an unapproved production load test. Record unavailable evidence explicitly.

Compare equivalent data, parameters, load, build provenance and environment. Separate cold-start/resume from warm reads. Cumulative counters need matching windows; a reset or failover invalidates deltas across that boundary. Empty Query Store/DMV output is not proof of low cost. Aggregate waits across workers/sessions are not an exact fraction of one user's wall-clock delay.

Report p50/p95 only when the sample count and method support those percentiles; state both. One observation is one duration, not a demonstrated p95. Do not relabel a mean, SQL aggregate or estimate as a measured percentile.

Repeat the same action after the change under comparable conditions, then recheck correctness and isolation. Stop when the agreed target is met, the remaining work needs a separate decision, or evidence is blocked. State which:

- Target met with observed measurements and preserved correctness.
- Improvement measured, but target unmet or not agreed.
- Evidence incomplete or incomparable; name the next required observation.

Keep performance evidence within the validation skill's existing functional-acceptance verdict, not a fifth mandatory verdict. Passing documentation, compilation or contract tests does not demonstrate an application's latency improvement.

## Sources

- [Azure SQL application and database performance guidance](https://learn.microsoft.com/en-us/azure/azure-sql/database/performance-guidance?view=azuresql): chattiness, batching, tuning and cache consistency.
- [ASYNC_NETWORK_IO troubleshooting](https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/performance/troubleshoot-query-async-network-io): large result sets and slow consumers.
- [Database-scoped wait statistics](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-wait-stats-azure-sql-database?view=azuresqldb-current): completed waits, scope and resets.
