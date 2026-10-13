# Operating and releasing authenticated applications

> **Compatibility runbook:** This describes SQL Apps' custom Azure deployment for existing environments. Use maintained Azure deployment and diagnostics skills for new projects; retain the SQL/DAB-specific acceptance requirements when migrating.

This checklist is for maintainers and operators of the full authenticated Azure deployment, not the local getting-started path.

## Diagnostics

Container Apps sends service logs to Log Analytics. SQL server auditing is enabled and delivered to the same Log Analytics workspace through a diagnostic setting, so `SQLSecurityAuditEvents` is queryable with `AzureDiagnostics`. Gateway logs redact authorization/cookies and report request IDs and error types, not raw downstream exception messages.

Use Azure CLI for container revisions, logs, identities, role assignments, and resource status. `status` checks the gateway resource and data-service readiness and reports the configured SQL backup retention, backup redundancy and audit workspace; it is not an authenticated smoke test and it does not verify that a restore or an audit query actually works.

## Failure and retry

- A failed CLI command exits nonzero and does not select another platform.
- The command runner waits for process output streams to close before returning, so deployment JSON and error diagnostics are not truncated when the child exits.
- Infrastructure/schema/runtime stages are persisted locally. Retry repeats declarative stages rather than assuming prior state is current.
- Schema failure prevents new gateway/data rollout; existing runtime resources are not intentionally deleted.
- Local locks atomically publish a directory containing a unique process/host owner record. Recovery removes only the observed dead owner's record, so concurrent recovery cannot delete a replacement lock. Legacy incomplete files or empty consent locks are recovered after 30 seconds; live owners remain protected regardless of age.
- `deploy-all` checks the saved deployment fingerprint before skipping completed stages. A changed configuration or SQL/DAB source makes `artifacts` and `deploy` pending again under a new approval id; a historical ready stage is not proof that a changed release was deployed.
- `deploy` refuses images whose recorded `imageSource` differs from the current SQL/DAB source; run `artifacts`, then `deploy`. A changed configuration or source rolls every stage forward; an unchanged one resumes from its saved stage.
- `deploy-all` stops after ordinary infrastructure provisioning for an administrator-run `rbac-plan`/`rbac-deploy` handoff. Runtime deployment reads every required assignment back from its exact Azure scope before schema or service changes.
- Gateway proxies use Fastify's native Web-stream handling for incremental delivery and backpressure. Disconnecting a client cancels the upstream response even while its next chunk is pending; loopback HTTP regressions cover the DAB proxy path.
- ARM changes, SQL publishing, and Graph assignments are not a single transaction. Inspect recorded stages and Azure state after failure.
- Runtime rollback does not reverse schema changes. Use expand/contract changes and operator-reviewed recovery.
- Do not run deployment from two unrelated machines simultaneously. CI provides concurrency grouping; a distributed lock service is not implemented.

### Live Azure deployment lessons

- A newly created ACR can exist in ARM before its login-server DNS record is consistently resolvable. If preflight reports `CONNECTIVITY_DNS_ERROR`, verify the configured login server with `az acr show`, run `az acr check-health`, and test DNS/HTTPS. Retry after DNS is healthy; do not create a replacement registry or republish images merely because DNS has not propagated.
- ARM deployments are not transactions. A failed `provision` can leave SQL, Container Apps, identities, private endpoints, and monitoring resources running and billing even though no local infrastructure stage was saved. Use `az deployment operation group list` and `az resource list` to inventory the partial result before retrying or making cleanup decisions.
- Container Apps managed-environment creation can fail with `ManagedEnvironmentCapacityHeavyUsageError` / `AKSCapacityHeavyUsage` while other resources succeed. Stop the publish attempt and inventory the partially billed resources. Do not loop retries or switch regions automatically; select a new region only through a fresh placement and cost review.
- Managed-environment retries can remain in `Running` / `Updating` for tens of minutes. Check the ARM deployment and environment provisioning states rather than starting a concurrent deployment. The CLI process can legitimately remain quiet while ARM is still working.
- Ordinary provisioning no longer creates Azure role assignments. After it succeeds, an authorized administrator runs `rbac-plan` and `rbac-deploy`; the ordinary deployer then verifies exact live principal/role/scope assignments before SQL or runtime publication.
- Query Cost Management after deployment, but expect billing data to lag and the API to throttle with HTTP 429. A zero or unavailable same-day result is not proof that the environment is free. Use the declared SKUs and current Retail Prices API as the pre-deployment floor, then reconcile against actual and forecast cost when data arrives.

## Durable data

SQL owns application data and any row-level security the application defines. Deleting the application does not require deleting its data.

The SQL administrator intentionally has privileged schema access. The DAB managed identity receives only `EXECUTE` and object-scoped `VIEW DEFINITION` on the authorized DAB stored procedures; `npm run azure -- grants <config>` writes that exact set to `dist/sql/role-based-grants.sql` for a maintained deployment route. Gateway and DAB identities are separate; their only Azure role assignments are ACR pull.

SqlPackage authenticates with Microsoft Entra (Active Directory Default through the Azure CLI credential), so no SQL access token is passed on the command line. Still, do not run deployment operations on an untrusted shared host. SQL Apps provisions no Storage or Key Vault; add file storage or secrets with the maintained Azure skills.

## Production release gates

Before production:

- Run the deployed two-user acceptance suite in [deployment reference](../reference/deployment.md).
- Verify network isolation and DNS from both trusted and untrusted hosts.
- Pin every deployed image to an immutable digest, including validated base image provenance.
- Exercise multiple replicas, temporary SQL outage, and dependency recovery.
- Perform and document a SQL restore drill.
- Set SQL backup retention according to policy; do not treat default retention as an approved recovery plan. The template provisions a 7-day retention window and reports the effective redundancy (default Local).
- Confirm SQL auditing reaches the workspace reported by `status`: run a failed login and an authorized query, then query `AzureDiagnostics` for `SQLSecurityAuditEvents` and record the evidence. Provisioned auditing is not verified auditing.
- Burst-test before production launch: drive concurrent authenticated traffic plus unauthenticated requests at `/api/*` and `/graphql`, and record observed throughput, error rates, serverless SQL saturation and the replica scaling response. Do not add production-scale controls before measured need.
- Configure alert rules and cost budgets for the selected environment.
- Verify tenant consent restrictions and least-privilege directory/resource deployment permissions.
- Exercise CI SQL authentication/private networking; hosted GitHub runners do not inherently reach private endpoints.
- Record regional quota/SKU availability and cost estimates.

No automatic resource-deletion command is provided. Resource deletion, database restore, retention changes, and destructive migrations require explicit operator review.
