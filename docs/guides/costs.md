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

The primary personal-project target is Static Web Apps Free with managed
Functions and the Azure SQL Database free offer. It can plausibly remain at
**$0 Azure service cost** while both services remain within their current
allowances. Static Web Apps Free has no SLA. Eligibility, regional availability
and usage are account-specific, and a free allowance is not a spending cap.

The personal-free profile creates no container registry, private network,
private endpoint, private DNS or monitoring workspace. Read
[Sharing your app](sharing.md) and the
[personal-free deployment reference](../reference/personal-free-deployment.md)
before approving it. Use the Azure Cost plugin to confirm current account and
regional facts rather than treating this documentation as a quote.

## Keep the application contract

The low-cost profile makes an explicit networking trade-off: public Azure SQL
with the Azure-services firewall rule and a generated least-privilege SQL
credential. Do not describe it as private networking or managed identity.
If those controls or an SLA are requirements, select and price a production
architecture instead of quietly adding services to the personal default.
