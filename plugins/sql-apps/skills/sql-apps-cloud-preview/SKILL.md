---
name: sql-apps-cloud-preview
description: "Use when a user wants to publish, share, deploy, price, or assess cloud readiness for a SQL Apps project, especially a small private or personal application."
---

# Publish a SQL Apps project

Sharing is optional.

The primary target for a new personal project is **Azure Static Web Apps Free + managed Functions + the Azure SQL Database free offer**. It is a personal-project tier with **no Static Web Apps SLA** and can be described only as **potentially $0 while usage remains within current allowances**.

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home`, and confirm the requested project with `workspace-check` before reading or changing it.

`personal-free` is the only bundled cloud profile. If the application requires an SLA, managed identity, private networking, organizational controls, or multiple application roles, stop and design a production architecture with maintained Azure and Azure SQL skills instead of growing a second SQL Apps deployer.

## Personal-free pipeline

1. **Confirm the application contract.** `personal-free-api.json` must explicitly allowlist every route, procedure, parameter, and sign-in provider. Arbitrary procedure forwarding is forbidden.
2. **Initialize read-only.** Run `npm run publish -- init --name <name> --location <region> --environment prod`. This reads the active Azure account and writes nonsecret configuration; it must not create resources.
3. **Plan.** Run `npm run publish -- plan`. Report the exact subscription/resource group, public-SQL boundary, generated SQL credential, excluded services, potentially-$0 allowance posture, and no-SLA status.
4. **Get explicit approval.** Azure writes require the approval code from that exact plan. Never infer approval from a request to plan, estimate, or explain.
5. **Deploy.** Run `npm run publish -- deploy --approve <code>`. The publisher provisions only Static Web Apps and Azure SQL, publishes the DACPAC, creates object-scoped runtime grants, deploys the site/API artifact, and verifies database-backed readiness.
6. **Invite the owner.** Run `npm run publish -- invite-owner --provider <provider> --user <identity>`. Merely authenticated users are not owners.
7. **Validate live.** Test anonymous, owner, and signed-in-nonowner states, then perform a browser write and prove SQL persistence after reload. A template build or successful ARM deployment is not acceptance.

Before presenting this route as executable, run the repository's focused publisher, infrastructure, authentication, and packaging tests. If the implementation or live canary is incomplete, say exactly what is unverified.

## Security and cost truth

The low fixed cost is an explicit trade-off:

- Azure SQL has a public endpoint.
- The `0.0.0.0` firewall rule admits Azure resources outside the subscription.
- Managed Functions do not provide this profile a SQL managed identity.
- Generated SQL credentials live in Static Web Apps settings and protected `.sql-apps/deployments/` state.
- The runtime receives only `CONNECT`, `EXECUTE`, and `VIEW DEFINITION` on declared procedures.
- The API requires an invited `owner` role and derives ownership from provider plus immutable provider user ID, never email.

Never call this private networking, passwordless, guaranteed free, production-grade, or highly available. Use maintained current Azure cost and Azure SQL skills before quoting limits, eligibility, regional availability, or prices.

## Report separate verdicts

Always report four independent lines:

- implemented/built;
- running/deployed;
- functional acceptance;
- design acceptance (`accepted`, `partial: N cells`, or `blocked`).

Also state whether live Azure validation was performed. No live deployment or invitation occurs without explicit target, region, resource-group, allowance/spend, and owner approval.

## Red flags

- Inventing a second bundled cloud topology
- Calling a free allowance a guarantee or cap
- Hiding public SQL or credential storage
- Treating `authenticated` as `owner`
- Reporting deployment success as application acceptance
- Claiming a canary that was not run
