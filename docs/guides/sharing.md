# Sharing your app

Before moving a local app online, decide **who should use it** and **what information it contains**. A public URL is not a substitute for access control.

For new cloud deployments, SQL Apps owns the Azure SQL/DAB application contract and acceptance checks; maintained Azure tooling owns service selection, infrastructure, cost review, predeployment validation, deployment, and cloud diagnostics. Use the Azure Skills `azure-app-onboard` when the architecture is open, then `azure-prepare` -> `azure-validate` -> `azure-deploy`. Use the `azure-cost` plugin for Azure estimates and cost analysis, and `azure-diagnostics` for production incidents. For SQL-specific identity, schema, and DAB requirements, route to `build-app-on-azure-sql`, `entra-id-auth`, and `dab-rest-and-graphql`.

The `npm run azure` workflow documented below remains supported for existing role-based-data deployments; do not use it as the default for new projects. External deployment success is not SQL/DAB application acceptance: verify the deployed identity, DAB role forwarding, intended permissions, and a real browser-to-SQL persistence/reload workflow with `sql-apps-validation`.

## Choose the right path

| You want to... | Current option |
| --- | --- |
| Keep using the app on your computer | Stay local. No cloud deployment is needed. |
| Prepare a new app for Azure | Use the maintained Azure Skills onboarding and prepare/validate/deploy flow above, with SQL Apps requirements and acceptance. |
| Estimate cost or inspect current spend | Use the `azure-cost` plugin; treat estimates as estimates, not a spending cap or deployment approval. |
| Diagnose an Azure production incident | Use `azure-diagnostics`; use SQL Apps validation for the app-specific SQL/DAB contract. |
| Continue an existing SQL Apps deployment | Review the [deployment reference](../reference/deployment.md) and [role-based-data profile](../reference/role-based-data.md); do not mix its state with `azd` deployments. |

Do not put real or sensitive information in the anonymous synthetic-data reference.

## Existing SQL Apps deployments

The `npm run azure` commands deploy the role-based-data profile: private Azure SQL, an internal DAB with managed-identity database grants, and live SQL Apps acceptance. They remain supported for existing deployments. Follow the [deployment reference](../reference/deployment.md) and [role-based-data profile](../reference/role-based-data.md); you will review your Azure target, identities, images, networking and schema before creating resources.

Do not change authorized access to an anonymous demo to fit a template. If the app needs file storage or background jobs, add them with maintained Azure skills such as `azure-storage`, outside SQL Apps. The `identity` command creates only the configured human role and `role-based-assign` manages explicitly approved assignments. Verify token claims and trusted DAB forwarding in the real environment.

To update an existing deployment after changing SQL, DAB or configuration, run `artifacts` and then `deploy`; see [Updating a deployment](../reference/deployment.md#updating-a-deployment).

Existing-resource discovery must not change the deployment subject. Older matching Azure resources are potential collisions and remain untouched. Keep the new checkout and its artifacts as the source unless reuse is explicitly requested and separately reviewed. Preparation is not permission to create, modify or delete resources.

After an approved deployment, test sign-in, each user's access, saved data and recovery in that environment. Local tests and template compilation do not prove those cloud behaviors.

## Public synthetic demos

Selected example applications build a hardened `public-demo` container (`npm run app:build -- <application> public-demo`) with visitor sessions and synthetic data only. SQL Apps no longer ships its own public-demo publisher or hosting comparison: deploy that artifact through the maintained Azure Skills, keep DAB internal with managed-identity access to Azure SQL, and verify direct backend access is denied before sharing the URL.

## Accounts before publishing

Follow **Build -> Sign in -> Give access -> Publish** and the [authentication and application-access reference](../reference/authentication.md). Product screens use account and access states; local preview test identities are not an onboarding system for real users.

Giving someone access requires a separately approved application-role assignment and the appropriate DAB permissions and SQL grants. Verify the delegated token, role forwarding and any owner restrictions, not just the ability to sign in. Browser role editing, guest invitations and an administration console are not implemented.

Container Apps is the hosting implementation used by the retained deployment. SWA CLI only mocks authentication and is not a prerequisite for real local Entra sign-in.

Changing hosting does not remove private SQL, networking, selected-service costs or identity requirements. Any new publishing path needs its own deployment and rollback plan, cost review, spending approval and explicit authorization before Azure changes.
