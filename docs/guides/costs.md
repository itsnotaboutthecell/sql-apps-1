# Costs and growth

## Start locally

Building and running SQL Apps locally does not create an Azure usage bill. You
still need the required tools, downloads, and Azure SQL Database container
private-preview access. Docker Desktop and your chosen AI provider have their
own licensing, account, and pricing conditions.

You do not need to deploy to Azure to build, test, or keep using a local app.

## Review Azure costs when you choose to share

Use the maintained **Azure Cost** plugin for current regional and account-aware
price estimates, actual spend analysis, forecasts, optimization, and governance.
Use `azure-app-onboard` when comparing Azure architectures. A cost estimate is
not a quote, spending cap, deployment approval, or proof that a resource is
eligible for a free offer.

For database-specific provisioning and workload sizing, route to
`provision-azure-sql-db` or `provision-hyperscale`. For SQL Apps deployment,
follow the maintained Azure Skills prepare -> validate -> deploy workflow in
[Sharing your app](sharing.md). Preserve SQL Apps' requirements for managed
identity, least-privilege database grants, DAB exposure, private networking,
and live application acceptance.

SQL Apps does not ship its own price calculators. Ask the Azure Cost plugin
to estimate the planned resource inventory before approving any deployment,
including fixed charges such as the container registry, private endpoints and
managed networking that free SQL or compute allowances do not cover.

## Keep the SQL/DAB application contract

Do not weaken authorization, SQL grants, network isolation, or data retention
to reduce a cost estimate. Prefer removing optional capabilities from the
agreed application scope. Before applying any paid deployment, review the
actual target, resource inventory, expected use, cleanup/retention plan, and
account-specific estimate with the operator.
