# Role-based data-only applications

`role-based-data` is the only SQL Apps profile, locally and in the cloud. Use it for an implemented domain application that needs SQL/DAB/browser access restricted to users assigned the required role. File storage and background jobs are outside SQL Apps; add them with maintained Azure skills such as `azure-storage`, `azure-prepare` and `azure-deploy`. It is a runtime/deployment path, not an application generator. Keep the original foundation checkout and unrelated databases unchanged; use the intended application checkout.

> **Cloud lifecycle:** The Azure commands in this reference remain supported for existing SQL Apps deployments. For new cloud deployments, use maintained Azure Skills for onboarding, infrastructure, predeployment validation, deployment, cost, and Azure diagnostics; preserve the SQL/DAB requirements and acceptance checks described here.

This is application role-based access control: Entra authenticates users, the gateway requires the configured application role, and DAB enforces procedure permissions. It is not Azure resource-management RBAC and does not automatically provide row-level security (RLS). Implement row/owner restrictions separately where the application requires them. `AppUser` is an example role; choose a role appropriate to your application.

## Application contract

Keep `application.json` named for your app with `selectedExamples: []`. Implement its domain screens and SQL procedures. Copy `role-based-data.example.json` to `role-based-data.json` in that checkout and choose:

- `requiredRole`: a dedicated human role such as `AppUser`; reserved roles (`anonymous`, `authenticated`, `Function.Invoke`, `processor`) are rejected.
- `readinessPath`: one `/api/<entity>` REST endpoint backed by an approved read-only procedure with no required request parameters. It must check the domain schema/access needed to operate, not substitute a success-shaped response for real readiness.

Configure `dab/dab-config.json` with explicit stored-procedure entities and role-authorized `execute` permissions. Autoentities, legacy `FileJob` entities and anonymous/processor permissions are rejected. Source objects use `schema.procedure` identifiers. A readiness entity looks like:

```json
"AppReady": {
  "source": { "object": "dbo.AppReady", "type": "stored-procedure" },
  "rest": { "enabled": true, "methods": ["get"] },
  "graphql": false,
  "permissions": [{ "role": "AppUser", "actions": ["execute"] }]
}
```

Implement the procedure in the app's SQL project before startup. Other authorized procedures can expose approved GET/POST operations. DAB defaults procedures to POST, so explicitly enable GET on the read-only readiness procedure. Permission grants are generated only for the validated procedures (`EXECUTE` and object-scoped `VIEW DEFINITION` for DAB metadata); no schema-wide execute or database-owner grant is added.

For cloud delivery, preserve production `AzureAD` DAB authentication, `/api` REST routing, and JWT settings `@env('API_CLIENT_ID')` / `@env('ENTRA_ISSUER')`. The local launcher generates a separately saved AppService simulation configuration; never deploy that configuration. The gateway serves only the browser app, authentication routes and the authorized `/api` and `/graphql` proxy.

## Local startup and acceptance

Follow [scoped consent](../guides/run-locally.md#approvals-and-readiness). Dependency restore, build, workspace selection, SQL terms/downloads/schema/startup and synthetic acceptance are distinct approval scopes.

Before build, `node scripts/setup-check.mjs --profile role-based-data` checks prerequisites and only selected gateway/DAB ports; the installed launcher exposes the same diagnostic as `role-based-setup-check`. It does not install tools or start services.

After an approved build and explicit workspace selection:

```powershell
npm run local -- app
```

`role-based-app` is an alias of `app`. An optional second argument selects an explicitly approved existing SQL container. Startup runs the `start-sql`, `init` (schema, procedure grants and read-only SQL acceptance) and `data` stages, then checks the actual readiness procedure before listening on the loopback gateway (`serve`). Port ownership checks include only the gateway, DAB and SQL ports. It preserves data and reports the failed stage rather than resetting volumes.

After readiness passes, open the reported workspace origin and select **Open local preview**. Product screens use account/access states, not persona selectors. The server chooses the default simulated identity. For authorization testing, open the reported local-only developer page in the same tab; Development Alice is labeled as having the required role and Development Bob as lacking it. Switch there and return to the application; switching revokes the old server-issued session.

Caller role/principal headers cannot grant access. The gateway forwards the configured DAB role only for a verified authorized preview session or opt-in delegated Entra token. Local DAB remains trusted-gateway claim simulation in either mode; local real sign-in does not prove cloud DAB identity or Entra role assignment in the deployed environment. Read [Authentication and application access](authentication.md) for the explicit local Entra opt-in and its no-fallback boundary.

Verify an agreed browser action, SQL persistence/reload, invalid input and applicable owner rules, plus denial for an identity without the required role. A verified non-role account receives HTTP 200 identity/access information from `/auth/me`, a clear access-denied state with sign-out still available, and HTTP 403 on domain operations before DAB is called. Denial must not erase the account or invite a product persona choice. These checks are separate from startup readiness. Ctrl+C stops the gateway; SQL/DAB data remain. Resume with:

```powershell
npm run local -- serve
```

`role-based-serve` is an alias of `serve`. Use the existing approved `stop` command to stop only the owned DAB container when needed; never delete SQL volumes to resume.

## Profile-specific Azure preparation

Copy `azure-role-based.example.json` to an application-specific configuration, fill the exact tenant/subscription/target and immutable version image choices, and retain `profile`, `requiredRole` and `readinessPath` consistent with the local app. No Functions image is accepted (a legacy `functionsImage` must be empty). Placeholder identifiers in the example are not valid deployment targets.

Review costs with the Azure Cost plugin before approving paid steps. The profile uses eligible free-limit serverless SQL with `AutoPause`, two scale-to-zero Consumption apps, Local backup redundancy and a 0.1 GB/day Log Analytics cap, but ACR Basic, one SQL private endpoint and custom Container Apps network infrastructure can still carry fixed charges. Free SQL eligibility and shared Container Apps allowances must be verified for the target subscription. An estimate is not a quote, eligibility check, spending cap or deployment approval.

With separate target/read-only authorization, validate the app/configuration and review what-if. No command silently selects discovered older resources; treat them as collisions unless reuse is explicitly requested.

## Identity, artifacts and deployment

After explicit approval for each relevant cloud-write scope:

```powershell
npm run azure -- identity azure-role-based.json
```

This creates a new single-tenant registration/service principal with delegated `access_as_user` and the configured human application role (allowed member type `User`). A configuration from `npm run azure -- init ...` receives the printed identifier automatically. `deploy-all` runs the reviewed ordinary-operator stages, stops after provisioning for the separate administrator RBAC handoff, and resumes afterward ([deployment reference](deployment.md#shortest-path)); otherwise set `apiClientId` to its printed identifier. Existing registrations need an enabled equivalent application role; creation does not patch unrelated registrations.

Assign only approved authorized users/groups by object ID:

```powershell
npm run azure -- role-based-assign azure-role-based.json <user-or-group-object-id>
```

This verifies the configured tenant, role and assignment, and avoids duplicating an existing assignment. Directory permissions/consent are separate from Azure RBAC. Acquire a fresh delegated API access token after assignment.

The existing orchestration:

```powershell
npm run azure -- validate azure-role-based.json
npm run azure -- artifacts azure-role-based.json
npm run azure -- plan azure-role-based.json
npm run azure -- provision azure-role-based.json
npm run azure -- rbac-plan azure-role-based.json
npm run azure -- rbac-deploy azure-role-based.json
npm run azure -- deploy azure-role-based.json
npm run azure -- status azure-role-based.json
```

`validate` is offline. For this profile it also requires `requiredRole` and `readinessPath` to match `role-based-data.json` when present, and every DAB procedure to be declared under `sql/`, so a mismatch fails before images are published. `artifacts` builds/publishes exactly gateway and DAB images from this checkout, records the SQL/DAB source fingerprint (`imageSource`) and saves digests only after both succeed. `plan` uses Azure/Graph reads and ARM what-if; obtain separate authorization. `provision`/`deploy` create paid resources. The administrator-only `rbac-plan`/`rbac-deploy` commands grant and verify only the two exact ACR pull assignments; the ordinary `deploy` command verifies those assignments again before publishing SQL. ACR must already exist at the explicitly selected target; creating it is a separate approved operation.

SQL remains Entra-only with its public endpoint disabled. The deployment uses
one SQL private endpoint/DNS path for schema publication and runtime access.
SqlPackage publishes with Microsoft Entra (Active Directory Default through the
Azure CLI credential); no access token is passed on the command line. Schema
publishing is non-destructive and grants the DAB managed identity only approved
procedure permissions.

Role-based deployment persists infrastructure/schema/runtime/readiness stages and resumes an unchanged configuration from the saved stage. State is bound to the canonical application checkout. To update a deployment after editing SQL, DAB configuration or the Azure configuration, run `artifacts` and then `deploy`; changed configuration or SQL/DAB source rolls every stage forward. `deploy` refuses images built from different SQL/DAB source than the current checkout. Copied or malformed state fails rather than resetting state or transferring deployment to an older app. See [Updating a deployment](deployment.md#updating-a-deployment). Runtime HTTP readiness is not authorization acceptance or a production-release claim.

## Live cloud acceptance

In a trusted process, set `SQL_APPS_USER_TOKEN` to an authorized delegated API token and `SQL_APPS_SECOND_USER_TOKEN` to a valid delegated token without the required role for the same tenant/API. Never paste tokens into chat or commit them.

```powershell
npm run azure -- role-based-smoke azure-role-based.json
```

This checks real authorized procedure execution, denial for valid users without the required role and anonymous denial, including caller-forged role headers. It does not create domain records. Then verify real browser sign-in, the agreed order/record save and reload, owner rules, validation and persistence in Azure. Use the validation skill to retain actual commands, results and outstanding acceptance gaps.

Compiled templates, mocked Azure calls and local simulation do not prove live Entra, private-network SQL, image startup or domain workflows. No live deployment is implicit in implementation or documentation updates.
