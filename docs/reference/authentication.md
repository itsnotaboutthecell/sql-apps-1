# Authentication and application access

The product journey is **Build -> Sign in -> Give access -> Publish**. Application screens contain sign-in, sign-out, and access states, never persona selectors. Test identities belong on a separate local-only developer page.

## Three distinct boundaries

| Mode | Browser and gateway | Data/backend |
| --- | --- | --- |
| Local preview (default) | Server-issued opaque sessions for fixed simulated identities | Local DAB claim simulation and development services |
| Local Entra (opt-in) | Real MSAL sign-in and verified delegated Entra access tokens | Local DAB claim simulation and development services |
| Personal-free Azure deployment | Static Web Apps built-in sign-in and an invited `owner` role | Managed Functions, a procedure allowlist, and least-privilege SQL credentials |
| Legacy private Azure deployment | Real MSAL sign-in and signature-verified delegated access tokens | Gateway, DAB managed identity, SQL grants and ownership rules |

Local real sign-in does not prove cloud DAB identity or Azure service permissions. Dependency readiness is not user authorization or browser/SQL acceptance.

## Local preview

After the approved profile is ready, open its reported URL and select **Sign in**. The server signs in the default simulated **Test user**; **Sign out** revokes the session. No Azure subscription is needed.

For authorization and ownership testing, open the reported developer page, `/__dev/identity`, in the **same tab**. It contains the existing Development Alice and Development Bob test identities, with role-based labels indicating whether they have the required role. Switching identities invalidates the old session. Return to the application to test access; application screens do not select personas.

The developer page and script, `/local/users` and `/local/session` exist only in preview mode, behind the loopback and exact Host/Origin guards. They are absent in local Entra mode and production. Preview sessions use unpredictable 43-character opaque tokens, expire after eight hours and are limited to 1,000 active sessions. Sessions are held in server memory and do not survive a gateway restart.

These guards are not a security boundary against other processes on the same machine. Never expose the local stack remotely or deploy its generated development configuration. Automated two-user preview harnesses create and revoke their own sessions rather than clicking product persona controls; those checks are not Entra acceptance.

## Real Entra sign-in locally

Use a development app registration in the intended tenant. Registration changes, role assignments and other Azure mutations require separate explicit approval. Do not add development callbacks to a production registration by default.

Register the exact SPA callback `http://127.0.0.1:PORT/auth/redirect.html`, where `PORT` is the reported gateway port. Copy the printed callback instead of guessing port 8080 or 18080. The Azure portal's redirect-URI text box rejects HTTP callbacks using `127.0.0.1`; follow the official [Entra application-manifest instructions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#prefer-127001-over-localhost) for this separately approved change. Keep the port and path exact; do not weaken the gateway's Host/Origin guards or the cloud HTTPS requirement.

Set these nonsecret identifiers in the terminal that will start the intended gateway:

```powershell
$env:SQL_APPS_LOCAL_AUTH = 'entra'
$env:AZURE_TENANT_ID = Read-Host 'Development tenant ID'
$env:API_CLIENT_ID = Read-Host 'Application client ID'
```

Both identifiers must be UUIDs. Use the already approved profile-matched setup start/resume path, `role-based-serve` for the role-based-data profile, or foundation `serve` against its existing services. Do not start excluded services.

The registration must expose `access_as_user` and request v2 delegated access tokens. Role-authorized applications also need the required human application-role definition and approved assignments. Use the existing separately approved identity and assignment workflow; there is no browser role editor.

Local Entra mode has no preview session or developer-identity endpoints. Invalid configuration stops startup, and sign-in failures never fall back to preview simulation. To change authentication mode or registration, stop only the intended gateway and restart with the reviewed configuration. Do not reset data or replace a foreign process. Setup refuses to adopt a gateway with different authentication settings.

## Sign-in and authorization

MSAL uses `/auth/redirect.html` as its dedicated v5 redirect bridge. This page runs only the bridge script, makes no application API calls and must not receive a `Cross-Origin-Opener-Policy` header. An approved Azure deployment registers the exact HTTPS callback on the actual gateway origin while preserving existing redirect URIs. Update an existing registration before accepting the new browser build; a root-only redirect URI does not match the bridge path.

The gateway validates the token's signature, issuer, audience, expiry, tenant, object ID and delegated scope. `/auth/me` returns HTTP 200 with verified identity and access information even when a valid account lacks the required application role. That account receives a clear access-denied state and can still sign out; domain requests are rejected with HTTP 403 before DAB is called.

HTTP 401 means authentication is missing, invalid or expired. The browser clears owner-specific data and stops authenticated requests until access is re-established. HTTP 403 denies an operation; it is not a persona choice or a reason to discard the signed-in account. A backend outage keeps an authorized account signed in and reports a separate retryable service failure.

Hiding UI controls improves usability, but the gateway, DAB and SQL are authoritative. Caller-supplied principal and role headers are untrusted. Ownership uses verified `oid` and `tid`, not an email address or a provider-specific user ID.

In the personal-free profile, **Give access** means creating a time-limited Static Web Apps invitation carrying the custom `owner` role. The API accepts only that role and derives its stable owner ID from the provider and immutable provider user ID, not email. Static Web Apps roles do not themselves grant arbitrary SQL access; the Functions runtime can execute only the procedures declared in `personal-free-api.json`.

In the legacy profile, **Give access** requires an approved Entra application-role assignment and the relevant DAB/SQL permissions. A browser administration console is not implemented.

## Static Web Apps boundary

The primary personal profile uses Static Web Apps built-in authentication and managed Functions. The browser reads `/.auth/me`; sign-in and sign-out use the platform `/.auth` routes. The Functions boundary strictly parses `x-ms-client-principal`, rejects malformed or oversized principals, and requires exactly the invited `owner` role. Caller-submitted platform identity headers are stripped before request adaptation.

This is intentionally different from the legacy single-tenant delegated-token gateway. Do not copy the Static Web Apps principal model outside its hosting boundary or claim that it supplies a managed identity for Azure SQL.

The SWA CLI is a deployment dependency for the personal-free artifact. Local preview continues to use SQL Apps' local session model; an SWA CLI authentication simulation is not production acceptance.

## References

- [MSAL Browser redirect bridge](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/redirect-bridge)
- [Entra redirect URI restrictions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [Static Web Apps CLI overview](https://learn.microsoft.com/en-us/azure/static-web-apps/static-web-apps-cli-overview)
- [Static Web Apps authentication and authorization](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-authorization)
- [Static Web Apps user information](https://learn.microsoft.com/en-us/azure/static-web-apps/user-information)
- [App Service overview](https://learn.microsoft.com/en-us/azure/app-service/overview)
- [App Service authentication and authorization](https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization)
