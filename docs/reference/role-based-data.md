# Role-based data-only applications

`role-based-data` is the only SQL Apps profile, locally and in the cloud. Use it for an implemented domain application that needs SQL/DAB/browser access restricted to users assigned the required role. File storage and background jobs are outside SQL Apps; add them with maintained Azure skills such as `azure-storage`, `azure-prepare` and `azure-deploy`. It is a runtime/deployment path, not an application generator. Keep the original foundation checkout and unrelated databases unchanged; use the intended application checkout.

> **Cloud publishing:** The bundled cloud target is the [personal-free profile](personal-free-deployment.md). This reference describes the local DAB data contract; it is not a second cloud deployment profile.

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

After readiness passes, open the reported workspace origin and select **Sign in**. Product screens use account/access states, label the default simulated identity as **Test user** and do not offer persona selectors. For authorization testing, open the reported local-only developer page in the same tab; Development Alice is labeled as having the required role and Development Bob as lacking it. Switch there and return to the application; switching revokes the old server-issued session. Use **Sign out** to revoke the current local session.

Caller role/principal headers cannot grant access. The gateway forwards the configured DAB role only for a verified authorized preview session or opt-in delegated Entra token. Local DAB remains trusted-gateway claim simulation in either mode; local real sign-in does not prove cloud DAB identity or Entra role assignment in the deployed environment. Read [Authentication and application access](authentication.md) for the explicit local Entra opt-in and its no-fallback boundary.

Verify an agreed browser action, SQL persistence/reload, invalid input and applicable owner rules, plus denial for an identity without the required role. A verified non-role account receives HTTP 200 identity/access information from `/auth/me`, a clear access-denied state with sign-out still available, and HTTP 403 on domain operations before DAB is called. Denial must not erase the account or invite a product persona choice. These checks are separate from startup readiness. Ctrl+C stops the gateway; SQL/DAB data remain. Resume with:

```powershell
npm run local -- serve
```

`role-based-serve` is an alias of `serve`. Use the existing approved `stop` command to stop only the owned DAB container when needed; never delete SQL volumes to resume.
