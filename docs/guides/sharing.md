# Sharing your app

Before moving a local app online, decide **who should use it** and **what information it contains**. A public URL is not access control.

## Default for a personal project

The primary SQL Apps cloud target is:

- Azure Static Web Apps **Free** for the site and managed Functions API;
- the Azure SQL Database free offer;
- an explicitly invited Static Web Apps `owner`; and
- a generated, least-privilege SQL login held in application settings and protected local deployment state.

This is a personal-project tier with **no Static Web Apps SLA**. It can plausibly remain at **$0 Azure service cost** only while both services remain within their current free allowances. Eligibility and consumption are account-specific; free allowances are not a spending cap or availability promise.

The trade-off for the low fixed cost is deliberate: Azure SQL has a public endpoint, and its `0.0.0.0` firewall rule admits connections from Azure resources outside your subscription. SQL authentication remains enabled because Static Web Apps managed Functions do not provide the application a managed identity. Stored-procedure allowlisting, object-scoped grants, an invited owner role, encryption, and certificate validation limit the resulting access, but do not turn this into an enterprise private-network architecture.

Use the [personal-free deployment reference](../reference/personal-free-deployment.md). The workflow is read-only until `deploy --approve` receives the approval code from the current plan.

## Choose the right path

| Need | Path |
| --- | --- |
| One owner, light personal use, potentially $0, no SLA | Primary `personal-free` publisher |
| No cloud deployment | Keep using the local application |
| Enterprise SLA, managed identity, private networking, or organizational controls | Plan a production architecture with maintained Azure and Azure SQL skills |
The project ships no second cloud topology. If the personal profile does not meet the requirements, use maintained Azure skills to design, own, and validate a separate production architecture.

## Acceptance after deployment

Deployment success is not application acceptance. Verify separately:

1. anonymous and signed-in nonowners cannot call domain APIs;
2. the invited owner can sign in and use the application;
3. a browser write persists to SQL and remains after reload;
4. the readiness endpoint reports healthy;
5. current Azure usage still fits the intended allowances.

Do not put sensitive data in a deployment that has not passed these checks.
