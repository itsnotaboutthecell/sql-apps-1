---
name: sql-apps-cloud-preview
description: "Use when a user wants to publish, share, deploy, price, or assess cloud readiness for a SQL Apps project, especially a small private or personal application."
---

# Publish a SQL Apps project

Sharing is optional. `personal-free` is the primary and only bundled cloud profile for a personal project: **Static Web Apps Free + managed Functions + Azure SQL Database free offer**. It has **no Static Web Apps SLA** and is only **potentially $0 within current allowances**.

Resolve `../../scripts/sql-apps.mjs` from this installed skill, run `home`, and confirm the project with `workspace-check` before any change.

For an SLA, private networking, organizational controls, multiple application roles, or managed identity that does not meet the conditions below, design a production architecture with maintained Azure/SQL skills; do not add another bundled topology.

## When personal-free does not fit

When Entra-only SQL/managed identity is the only unmet need and the user accepts scale-to-zero, cold starts, interruptions and possible charges, Container Apps Consumption with a public gateway and localhost-only DAB is a candidate—not a bundled profile. Otherwise (guaranteed $0, continuous availability, no SQL-resume delay, blocked policy or permissions) use a production architecture. Verify current DAB auth for the pinned image, access, availability and quotas with maintained skills. Expose declared DAB operations only; derive roles from validated identity.

Hand infrastructure to `azure-prepare` → `azure-validate` → `azure-deploy`; do not build another publisher. Before writes, inventory and estimate supporting services; get separate approvals for spend, identity changes and interruption. Replica limits and budgets are not spending caps. Validate shutdown, alerts and manual recovery in a disposable deployment, preserving the database.

## Personal-free pipeline

1. **Confirm the application contract.** `personal-free-api.json` must explicitly allowlist every route, procedure, parameter, and sign-in provider. No arbitrary forwarding.
2. **Initialize local configuration.** `npm run publish -- init --name <name> --location <region> --environment prod` writes nonsecret configuration, not resources.
3. **Plan.** `npm run publish -- plan`: report subscription/resource group, public SQL, credential storage, excluded services, allowances and no-SLA posture.
4. **Get explicit approval.** Azure writes require the approval code from that exact plan. Never infer approval from a request to plan, estimate, or explain.
5. **Deploy.** `npm run publish -- deploy --approve <code>` provisions resources with `project=sql-apps`, environment and `deployment=personal-free` tags, verifies free settings, publishes schema/grants, deploys and checks readiness.
6. **Invite the owner.** Run `npm run publish -- invite-owner --provider <provider> --user <identity>`. Merely authenticated users are not owners.
7. **Validate live.** `npm run publish -- status` must report `Cost guard: verified`. Test anonymous, owner and signed-in-nonowner states, a browser write and SQL persistence after reload. ARM deployment is not acceptance.

## Security and cost truth

- Free limits stop rather than bill and can interrupt service. The cost guard fails closed unless the deployed Free SKU and SQL free-offer/AutoPause settings are proven.
- SQL is public; the `0.0.0.0` firewall rule admits Azure resources outside the subscription.
- Managed Functions lack SQL managed identity. Generated credentials live in Static Web Apps settings and protected `.sql-apps/deployments/` state.
- Runtime grants are only `CONNECT`, `EXECUTE` and `VIEW DEFINITION` on declared procedures.
- Ownership derives from provider plus immutable provider user ID, never email.

The guard excludes manual additions, offer changes, GitHub Actions, domains and third parties. Never claim guaranteed free, private networking, passwordless, production-grade or highly available. Consult maintained current Azure cost/SQL skills before quoting limits, eligibility, regions or prices.

## Evidence and approval

For foundation publisher changes, run focused publisher, infrastructure, authentication and packaging tests; routine publishing does not assume them. Disclose unverified implementation or live canary checks.

Use `sql-apps-validation`'s four-verdict report and state whether live Azure validation was performed. Deployment/invitation requires explicit target, region, resource-group, allowance/spend and owner approval.
For an external architecture, report cost safeguards as configured, exercised, partial or blocked, and which live checks ran.
