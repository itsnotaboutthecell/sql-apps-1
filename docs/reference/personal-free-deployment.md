# Personal-free Azure deployment

`personal-free` is the primary SQL Apps cloud profile for a small, private, one-owner application. It deploys Azure Static Web Apps Free with a managed Functions API and an Azure SQL Database configured for the free offer.

This profile has no Static Web Apps SLA. It is **potentially $0**, not guaranteed free: the subscription must be eligible and usage must remain within current allowances.

## Security and cost boundary

The profile intentionally creates only a Static Web App and Azure SQL server/database. It does not create DAB, Container Apps, ACR, a VNet, private endpoints, private DNS, Log Analytics, Application Insights, or Key Vault.

Azure SQL uses a public endpoint and the Azure-services firewall rule. The application uses a generated `sql_apps_runtime` login that receives `CONNECT` plus object-scoped `EXECUTE` and `VIEW DEFINITION` only for procedures declared in `personal-free-api.json`. Secrets are stored under `.sql-apps/deployments/`, which generated projects exclude from Git.

## Configure the API surface

`personal-free-api.json` is an allowlist, not an automatic schema explorer. Declare each HTTP route, stored procedure, and exact parameter type. The supported types are `nvarchar`, `uniqueidentifier`, `bit`, `int`, and `datetime2`.

Set `authenticationProvider` to `aad`, `github`, or `google`. The same provider must be used by `invite-owner`.

## Plan and deploy

Sign in with Azure CLI as the person who will administer the database:

```powershell
az login
npm run publish -- init --name my-app --location eastus --environment prod
npm run publish -- plan
```

`init` reads the active tenant, subscription, and signed-in user. It writes `sql-apps.personal-free.json` and makes no Azure changes. `plan` builds the exact site/API artifact and prints the target, security trade-offs, excluded services, and an approval code.

Deploy only after reviewing that output:

```powershell
npm run publish -- deploy --approve <approval-code>
```

Deployment creates the resource group, applies Bicep through a temporary protected parameter file, publishes `sql/personal-free.sqlproj`, creates the least-privilege runtime user, deploys the Static Web Apps artifact, and verifies database-backed readiness. The state file records completed stages so a failed deployment can be run again with the same approved build.

Check status without printing secrets:

```powershell
npm run publish -- status
```

Rotate the runtime SQL secret using the current deployment approval code:

```powershell
npm run publish -- rotate-secret --approve <approval-code>
```

## Invite the owner

After deployment, create a seven-day invitation:

```powershell
npm run publish -- invite-owner --provider aad --user owner@example.com
```

Open the returned link with the intended account. Authentication alone is insufficient: the API requires the custom `owner` role, and SQL ownership derives from the provider plus immutable provider user ID rather than email.

## Validation

Test anonymous, invited-owner, and signed-in-nonowner states. Complete a browser write, confirm the row in SQL, and reload the browser. Record functional and design acceptance separately.

The publisher does not run a live Azure canary automatically. Azure creation, invitations, and any resulting usage require explicit operator approval.
