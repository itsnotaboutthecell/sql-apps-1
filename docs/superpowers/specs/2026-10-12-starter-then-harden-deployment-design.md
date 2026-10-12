# Starter-Then-Harden Deployment Design

## Goal

Make idea-to-deployment the default SQL Apps experience for non-technical
users. A user with ordinary Azure resource deployment permissions should be
able to publish a synthetic public demo and receive a working URL without first
obtaining permission to create Azure role assignments.

Production-oriented hardening remains available as an explicit in-place
upgrade. It must not block the first useful deployment.

## Product Principles

1. A successful starter deployment is a real, working deployment, not a
   success-shaped mock or an incomplete provisioning result.
2. Starter mode relaxes only private-registry pull authentication. It preserves
   the existing application, data, network, ownership, cost, and live acceptance
   safeguards.
3. Hardening upgrades the same resources. It does not create a second hosting
   architecture or require users to migrate from App Service to Container Apps.
4. Security posture is always explicit. The workflow never silently falls back
   from hardened to starter behavior.
5. Credentials never appear in source, publication configuration, saved
   publication state, review output, or logs.

## Architecture

Both postures use the same runtime:

```text
Azure Static Web Apps Standard
        |
        | linked /api backend
        v
Azure Container Apps
  - Node gateway (public HTTPS ingress)
  - DAB sidecar (loopback only)
        |
        | managed identity
        v
Azure SQL Database
```

The linked Static Web Apps provider remains the public trust boundary. Direct
Container App API requests must continue to return HTTP 401 or 403. DAB remains
internal and Azure SQL remains Entra-only.

### Starter posture

- The runtime managed identity continues to authenticate to Azure SQL.
- Azure Container Registry image pulls use deployment-managed registry
  credentials stored as Container App secrets.
- Publication does not create an Azure RBAC role assignment.
- The required Azure authorization is ordinary resource deployment plus the ACR
  credential operations needed by the publication workflow.

### Hardened posture

- The runtime managed identity receives `AcrPull` on the owned registry.
- The Container App switches its registry configuration from credential-based
  pulls to the runtime managed identity.
- Registry administrator credentials are disabled only after the identity-based
  revision and public acceptance both succeed.
- The hardening operation requires
  `Microsoft.Authorization/roleAssignments/write` at the owned registry scope.

## Configuration Contract

The publication configuration gains an explicit security posture:

```json
{
  "securityPosture": "starter"
}
```

`starter` is the only initial public-demo publication posture in this design.
The separate hardening operation targets `hardened` and must fail before writes
if its required IAM permission is unavailable. No command may reinterpret a
hardening request as permission to deploy or retain Starter automatically.

The security posture participates in the publication configuration hash and
approval ID. Changing posture invalidates an earlier approval.

Secrets are not configuration fields. Registry credentials are acquired during
the approved publication stage and passed to Azure only through redacted
process arguments, secure deployment parameters, or Container App secret
operations.

## Guided User Journey

The primary journey is:

1. Select and build an application.
2. Select the Azure subscription, resource group, backend region, and Static Web
   Apps region.
3. Review known charge sources and acknowledge that budgets are alerts rather
   than hard spending caps.
4. Run read-only starter preflight.
5. Review one exact publication plan covering resources, source/image
   publication, schema access, synthetic writes, cleanup, and security posture.
6. Approve and publish.
7. Run live acceptance and display the working Static Web Apps URL.
8. Report `Starter` posture and offer hardening as the recommended next step.

The guided workflow derives or discovers values that non-technical users should
not have to hand-author:

- deployment ID;
- owned resource names;
- image names and immutable digests;
- signed-in SQL administrator object ID and display name;
- schema runner public IPv4 address;
- generated ACR credentials.

Every derived value that affects resource writes is shown in the approval plan
or represented by its approval-bound hash. Secret values are never shown.

## Preflight Behavior

Preflight becomes posture-aware.

### Starter preflight

Starter preflight requires:

- the existing provider, region, resource-write, schema, ACR build, and Static
  Web Apps permissions;
- permission to read or regenerate the owned registry credentials;
- no `Microsoft.Authorization/roleAssignments/write`.

It continues to report policy and quota evaluation as pending until target-
specific what-if or deployment.

### Hardening preflight

The `demo-harden` preflight requires every starter permission plus:

- `Microsoft.Authorization/roleAssignments/write`;
- the managed-identity assignment action already required by the runtime.

A missing hardening permission is a hardening blocker, not a failed starter
deployment.

## Publication and Secret Handling

Starter publication creates the owned ACR with administrator access enabled.
The publication process retrieves the credentials only after infrastructure
creation and before runtime deployment.

The runtime template accepts a registry username and password through secure
parameters and writes them into a Container App secret. The registry entry
references that secret. Neither the Bicep outputs nor the publication state
contain the password.

The process runner must redact:

- registry usernames when included in sensitive command contexts;
- both ACR passwords;
- deployment parameter material that contains a registry password;
- Azure deployment errors that echo secure parameter values.

Publication state records only non-secret posture evidence, such as:

- requested posture;
- whether credential-based registry pull is configured;
- whether identity-based registry pull is configured;
- whether ACR administrator access is enabled;
- the last completed stage.

If credential retrieval or secret injection fails, publication stops without
writing a success state. Existing completed infrastructure remains owned and
resumable.

## Hardening Operation

`demo-harden <publication-config>` is a separate review-and-approve workflow.
Its approval binds:

- subscription, resource group, and deployment ID;
- current publication state and runtime resource IDs;
- the exact pending hardening stages;
- the `AcrPull` role definition and registry scope.

The stages are:

1. **Preflight:** verify ownership, current Starter posture, resource health, and
   effective IAM permission.
2. **Role assignment:** grant `AcrPull` to the owned runtime identity at the
   owned registry.
3. **Identity revision:** update Container Apps registry authentication to the
   managed identity while credentials remain enabled.
4. **Acceptance:** wait for the revision and rerun public readiness, static
   content verification, direct-backend denial, and synthetic application
   acceptance.
5. **Credential disable:** disable ACR administrator access.
6. **Final verification:** prove the application can still start/pull and
   complete acceptance, then record `Hardened`.

The operation is idempotent and resumable. If stages 1-4 fail, Starter remains
operational. If credential disable or final verification fails, status is
`Partially hardened`; it reports the completed stages and an exact resume
command rather than claiming success.

## Status and Messaging

Deployment readiness and security posture are separate fields.

Example starter result:

```text
Deployment: Ready
Public URL: https://...
Security posture: Starter
Deferred hardening: ACR image pulls use a deployment-managed credential.
Next: run demo-harden when scoped IAM permission is available.
```

Example hardened result:

```text
Deployment: Ready
Public URL: https://...
Security posture: Hardened
Registry authentication: Managed identity (AcrPull)
ACR administrator access: Disabled
```

Documentation must describe Starter as appropriate for a temporary synthetic
demo, not as a production baseline. It must not describe a working Starter
deployment as blocked or failed.

## Preserved Safeguards

Starter mode preserves:

- exact tenant, subscription, and resource-group binding;
- deployment ownership tags and resource reconciliation;
- explicit paid-cost acknowledgement;
- free-paused SQL policy without paid fallback;
- immutable image digest verification;
- Entra-only SQL administration;
- managed-identity SQL data access;
- a temporary single-IP schema firewall rule with mandatory cleanup;
- internal-only DAB with GraphQL and MCP disabled;
- Static Web Apps linked-backend direct-access denial;
- bounded Container Apps scaling;
- foreign-origin and forged-platform-header rejection;
- per-session and global public-demo limits;
- resumable, approval-bound publication stages;
- complete live acceptance before readiness is reported.

## Cleanup and Shared Resource Groups

Cleanup remains deployment-ID scoped. It may remove only resources carrying the
matching SQL Apps ownership tags and reconciled resource IDs. It must never
delete a shared resource group or unrelated resources.

Starter cleanup also removes or invalidates generated registry credentials as
part of deleting the owned registry. Hardened cleanup removes the owned role
assignment with the owned registry; it does not enumerate or delete unrelated
assignments.

Destructive cleanup still requires a fresh, explicit approval.

## Testing Strategy

Implementation is test-driven.

### Preflight tests

- Starter succeeds without `roleAssignments/write`.
- Starter still fails when required resource-write or ACR credential actions
  are absent.
- Hardened fails before writes without `roleAssignments/write`.
- Hardened succeeds when the exact scoped permission is present.

### Configuration and approval tests

- Initial publication accepts only the explicit Starter posture, which
  participates in the approval hash.
- The separate hardening target participates in its own approval hash.
- Unknown postures and silent fallback are rejected.

### Secret-safety tests

- Registry passwords are passed only through secure/redacted channels.
- Publication state, JSON output, approval text, thrown errors, and logs contain
  no registry password.
- Interrupted publication leaves no plaintext secret file.

### Publication tests

- Starter runtime uses credential-based registry configuration.
- SQL continues to use managed identity.
- Existing publication resume behavior remains deterministic.
- Direct-backend denial and full public acceptance still pass.

### Hardening tests

- Operations occur in the safe order: role assignment, identity revision,
  acceptance, credential disable, final verification.
- Failure before credential disable leaves Starter operational.
- Failure after credential disable records `Partially hardened` and remains
  resumable.
- Repeated hardening does not create duplicate assignments or revisions.
- Successful hardening removes credential references and reports `Hardened`.

### Regression validation

- Full repository tests and type-check pass.
- Both Bicep templates compile.
- Public-demo infrastructure contract tests pass.
- `git diff --check` passes.
- Live Starter publication is validated with Contributor-level permissions.
- Live Hardened publication is optional until a target with scoped IAM
  permission is available; lack of that permission does not invalidate Starter.

## Documentation Changes

The primary documentation sequence becomes:

1. Build an idea.
2. Publish a Starter demo.
3. Share and validate the working URL.
4. Harden before production or sustained use.

Cost, synthetic-data, and public-access warnings remain before publication.
Production hardening documentation explains the additional IAM permission,
security benefit, in-place migration, verification, and rollback behavior.

## Out of Scope

- Replacing Container Apps with App Service.
- Making application images public.
- Treating Starter as production-ready.
- Automatically assigning IAM privileges to the publishing user.
- Weakening SQL authentication, DAB isolation, Static Web Apps linkage, origin
  checks, or application-level authorization.
- Automatically converting an existing deployment between SQL billing modes.
