# Operating and releasing authenticated applications

This checklist is for maintainers and operators of the full authenticated Azure deployment, not the local getting-started path.

## Diagnostics

Container Apps sends service logs to Log Analytics. Functions is configured with Application Insights. SQL server auditing is enabled and delivered to the same Log Analytics workspace through a diagnostic setting, so `SQLSecurityAuditEvents` is queryable with `AzureDiagnostics`. Gateway logs redact authorization/cookies and report request IDs and error types, not raw downstream exception messages.

Use Azure CLI for container revisions, logs, identities, role assignments, and resource status. `status` checks the gateway resource and data-service readiness and reports the configured SQL backup retention, backup redundancy and audit workspace; it is not an authenticated storage/function smoke test and it does not verify that a restore or an audit query actually works.

## Failure and retry

- A failed CLI command exits nonzero and does not select another platform.
- The command runner waits for process output streams to close before returning, so deployment JSON and error diagnostics are not truncated when the child exits.
- Infrastructure/schema/runtime stages are persisted locally. Retry repeats declarative stages rather than assuming prior state is current.
- Schema failure prevents new gateway/data rollout; existing runtime resources are not intentionally deleted.
- Local locks atomically publish a directory containing a unique process/host owner record. Recovery removes only the observed dead owner's record, so concurrent recovery cannot delete a replacement lock. Legacy incomplete files or empty consent locks are recovered after 30 seconds; live owners remain protected regardless of age.
- `deploy-all` checks the saved deployment fingerprint before skipping completed stages. A changed configuration or role-based SQL/DAB source stops continuation for operator review; a historical ready stage is not proof that a changed release was deployed.
- `deploy-all` stops after ordinary infrastructure provisioning for an administrator-run `rbac-plan`/`rbac-deploy` handoff. Runtime deployment reads every required assignment back from its exact Azure scope before schema or service changes.
- Gateway proxies use Fastify's native Web-stream handling for incremental delivery and backpressure. Disconnecting a client cancels the upstream response even while its next chunk is pending; loopback HTTP regressions cover both DAB and Functions proxy paths.
- ARM changes, SQL publishing, and Graph assignments are not a single transaction. Inspect recorded stages and Azure state after failure.
- Runtime rollback does not reverse schema changes. Use expand/contract changes and operator-reviewed recovery.
- Do not run deployment from two unrelated machines simultaneously. CI provides concurrency grouping; a distributed lock service is not implemented.

## Durable data

SQL owns application data and row-level security. Blob owns user files. Files are addressed by tenant/object-ID/name; deleting the application does not require deleting its data. The gateway returns at most 100 files per storage response with an opaque continuation token. The browser loads one page initially and follows a token only when the user selects **Load more files**.

An Azure Blob SDK regression uses a loopback HTTP fixture to verify the 100-result page limit, one request per page, opaque continuation and private snapshot-prefix exclusion. It needs no live storage account and is not live Azure acceptance.

The SQL administrator intentionally has privileged schema access. The DAB identity receives only table CRUD, and SQL block/filter predicates protect ownership. Gateway and function identities are separate.

Blob shared keys and anonymous access are disabled. File storage uses managed identity. The Functions host receives Blob/Queue/Table roles on the account; gateway permission is scoped to the file container.

Key Vault is provisioned with private access, RBAC, soft delete, and purge protection. `secret-set` writes a value supplied through `SQL_APPS_SECRET_VALUE` without persisting it locally or printing it. The operator needs Key Vault data-plane write permissions and private connectivity; provisioning permissions alone do not grant access.

The function identity has Key Vault Secrets User. Function implementations can import `functionSecrets` from `functions/src/secrets.ts` using `KEY_VAULT_URL` and `FUNCTIONS_IDENTITY_CLIENT_ID`. The example echo function does not read or return secrets. Never expose this helper through a generic client-controlled secret lookup endpoint.

Secret values, like SqlPackage access tokens, pass through the tools' normal process arguments on a trusted deployment host. Do not run deployment/secret operations on an untrusted shared host.

## Production release gates

Before production:

- Run the deployed two-user acceptance suite in [deployment reference](../reference/deployment.md).
- Verify network isolation and DNS from both trusted and untrusted hosts.
- Pin every deployed image to an immutable digest, including validated base image provenance.
- Exercise multiple replicas, temporary SQL outage, and dependency recovery.
- Perform and document a SQL restore drill and Blob retention recovery.
- Set SQL backup retention according to policy; do not treat default retention as an approved recovery plan. The template provisions an explicit `sqlBackupRetentionDays` (default 7) and `sqlBackupRedundancy` (default Geo), and `npm run azure -- status` reports both: confirm the reported values match the approved recovery objective.
- Confirm SQL auditing reaches the workspace reported by `status`: run a failed login and an authorized query, then query `AzureDiagnostics` for `SQLSecurityAuditEvents` and record the evidence. Provisioned auditing is not verified auditing.
- Burst-test the gateway before launch: drive concurrent authenticated traffic plus unauthenticated requests at `/api/*`, `/graphql` and `/storage`, and record observed throughput, error rates, SQL DTU saturation on S0 and the replica scaling response. The gateway applies no application-level rate limit, so establish the real saturation point and the fronting control (Front Door, App Gateway WAF or API Management) that will absorb it.
- Configure alert rules and cost budgets for the selected environment.
- Verify tenant consent restrictions and least-privilege directory/resource deployment permissions.
- Exercise CI SQL authentication/private networking; hosted GitHub runners do not inherently reach private endpoints.
- Record regional quota/SKU availability and cost estimates.

No automatic resource-deletion command is provided. Resource deletion, database restore, retention changes, and destructive migrations require explicit operator review.
