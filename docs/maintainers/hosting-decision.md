# Hosting decision: Static Web Apps candidate for public demos

## Decision

Public synthetic-data applications may use Azure Static Web Apps Standard for
static assets and one linked Azure Container App for `/api/*`. The Container App
keeps the Node API and an internal DAB sidecar. Role-based-data and
full-foundation deployments remain unchanged.

The current Container Apps public-demo path remains the default until both the
measured hosting comparison and live acceptance gates pass. Static Web Apps is
not assumed to be cheaper: Standard adds a resource while SQL, Azure Container
Registry, networking, Container Apps, the Node API and DAB remain.

## Why DAB is still self-hosted

[Static Web Apps Database Connections][database-retirement] retired on
November 30, 2025. Do not use the retired `/data-api` integration. DAB runs in the
Container App and connects to Azure SQL with managed identity. Microsoft's
[DAB deployment guide][dab-container-apps] documents DAB hosting on Container
Apps.

## Trust boundary

The browser calls only same-origin `/api/*`. Static Web Apps links that prefix to
the Node API. The Node API owns HttpOnly visitor sessions, request validation,
procedure allowlisting and response validation. DAB is reachable only from the
Node API over loopback and is never the public or linked backend.

Linking installs the `Azure Static Web Apps (Linked)` identity provider on the
Container App. That platform boundary, not the caller-controlled `Origin`
header, denies direct backend requests. Publication verifies the boundary by
calling the Container App URL directly and requiring HTTP 401 or 403.

## First-party constraints

Microsoft's [API overview][api-overview], [Container Apps linked-backend
guide][linked-container-app] and [hosting-plan comparison][swa-plans] establish
the applicable boundaries:

- A linked Container App requires Static Web Apps Standard.
- Only routes under `/api` are proxied to the linked backend.
- Each Static Web Apps environment can link only one backend type.
- Each API request has a maximum duration of 45 seconds.
- Network-isolated backends are unsupported.
- Bring-your-own linked backends are unsupported in pull-request environments.

The [SWA CLI deployment guide][swa-cli-deploy] describes static deployment; it
does not replace provisioning or operating the linked backend.

## Default promotion gate

Change the default only in a reviewed commit after:

1. `hosting-compare` accepts current regional and account evidence and reports
   the Static Web Apps candidate no more expensive for the agreed workload.
2. Live acceptance passes static delivery, same-origin cookies, all CRUD routes,
   cold start, readiness, direct-backend denial, CORS denial and cleanup.
3. The evidence date, region, currency, workload and command output are
   recorded.