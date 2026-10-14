# Try the Todo reference app

Create, edit and complete a short list in your browser, with records stored in SQL. This is a synthetic-data example for learning, not an authenticated app for real information.

Complete [Get started](../../docs/guides/getting-started.md), then run these from the project root:

```powershell
npm ci
npm run build
npm run local -- workspace-plan
```

Select an isolated workspace with `npm run local -- workspace-init <base-port>`, replacing `<base-port>` with the proposed free block. If you already have a workspace, review it rather than overwriting its state. This example requires isolated mode.

Continue with [Start and verify the selected local app](#start-and-verify-the-selected-local-app) below. Use the artifact directory printed by the builder, open the reported browser URL and create a test item. Reload, edit and complete it to try the main workflow.

To build something different, use [Build your app](../../docs/guides/build-your-app.md). This example is explicitly selected; it is not copied into your application automatically.

## Reference components

This example is not part of the foundation's browser, runtime client, DAB configuration, default database project or deployment images.

- `client.ts` extends the reusable client with Todo-only methods.
- `schema.sql` and `database.sqlproj` define the sample table/security policy using the domain-neutral ownership predicate.
- `dab-entity.json` is the sample-only DAB entity definition, to merge into an explicitly selected example configuration.
- `smoke.ts` preserves the sample's two-user REST/GraphQL acceptance implementation.

Build the example schema explicitly with `dotnet build examples/todo/database.sqlproj --output dist/examples/todo/sql`. Client/composition/browser/SQL workflow regressions live in this example's `tests/` directory, outside root application tests and production runtime inputs. `npm test` runs them only when this example tree is included. To run example tests separately after `npx tsc`, use `node scripts/test-examples.mjs`. Do not copy this folder or its tests into generated applications unless a user explicitly requests the Todo example.

The concurrency limits also have an opt-in real-engine test. After authenticating Docker to the private-preview Azure SQL Database registry, run `npm run test:sql-integration`. This starts an isolated container, verifies `EngineEdition = 5`, tests the session, mutation, and item boundaries under concurrent requests, and removes the container afterward.

The default local application now demonstrates selected foundation file/job capabilities without a Todo UI or API. Existing databases may retain old sample rows under the non-destructive publishing policy. Review/export them before any separately authorized removal; publishing does not drop them.

## Selected synthetic-demo assembly

The selected starter adds `application.ts`, a complete browser under `web/`, and a separate visitor-session SQL/DAB project under `demo/`. It does not replace the authenticated example files above or change the root `selectedExamples: []`.

After building the foundation and explicitly initializing an isolated workspace, developers can build this selection with `npm run app:build -- todo local-simulation` or `npm run app:build -- todo public-demo`. The output is a unique artifact directory under that workspace's state. Validate it with `npm run app:check -- --selected "<artifact-directory>" <profile>`. Every use checks checkout/workspace binding, selected inputs, source/artifact checksums and the shared route/method contract. Other selections cannot import this example implicitly. The selected image copies only its compiled server and browser, not the examples or tests tree.

These build commands assemble and validate artifacts only; they do not provision or deploy resources.

### Start and verify the selected local app

From the explicitly selected checkout with an initialized isolated workspace:

```powershell
npm run build
npm run app:build -- todo local-simulation
npm run local -- selected-app "<artifact-directory-printed-by-app-build>"
```

Approve SQL EULA acceptance, first-time image/NuGet downloads, and schema initialization before startup. The command checks source/artifact binding and resource ownership, provisions a separate workspace/app database and execute-only login, publishes its selected schema with .NET/SqlPackage, starts only SQL and DAB, probes the actual runtime login/procedure, and serves the selected browser. It does not start storage or Functions, alter root example selection, reset credentials, or delete existing data. The origin is reported by the command; use that URL rather than a legacy fixed port.

Ctrl+C stops the gateway. `npm run local -- selected-serve "<artifact-directory>"` reuses verified services and persisted visitor sessions. `npm run local -- selected-stop todo` removes only this app's verified DAB container; SQL data and credential state persist. A changed DAB configuration requires explicit stop before replacement. Missing credential state alongside existing SQL objects is a binding error, never permission to reset their passwords.

With the browser app running, explicitly approve synthetic acceptance writes and run:

```powershell
npm run local -- selected-test "<artifact-directory>"
```

The opt-in suite lives in `demo/smoke.mjs`, outside default delivery. It measures actual two-session ownership, the 200/201 UTF-16 code-unit boundary with ASCII and supplementary Unicode titles, concurrent 50-item quota and 30/31-mutation rate limits, SQL expiry, bounded cleanup, execute-only permissions, pooled-context spoof rejection, and end-session cascade deletion. It advances clocks only for its randomly created synthetic sessions and removes those sessions/rows on success or failure. It does not restart services. Run it in an approved disposable workspace without concurrent activity for deterministic cleanup-count evidence.

Before relying on the example, try browser create/update/completion/reload/delete and check persistence after restarting your own stack. The public-demo artifact is buildable; deploy it through the maintained Azure Skills (prepare, validate, deploy) and keep synthetic data only. No cloud deployment is implied by local readiness.

The selected gateway validates successful procedure records, including the requested item's identity for update/delete. An empty, incomplete or mismatched deletion result fails as HTTP502 rather than returning a false-success HTTP204.

The selected experience uses anonymous synthetic visitor sessions in both the loopback test transport and the public HTTPS adapter. This is deliberately separate from the default foundation's local preview account journey, which keeps identity testing on a separate developer-only page. There are no app-registration, Graph, storage, Functions or Key Vault requirements for this selection. The public adapter has no generic DAB proxy, GraphQL or simulated-user endpoint.

The SQL contract allows 60-minute sessions, 50 items, titles of 1 to 200 UTF-16 code units and 30 mutation attempts per minute. It also caps the demo at 1,000 active sessions and 300 mutation attempts per minute across all sessions, so replacing a cookie cannot create unbounded load. A singleton SQL row with update locks serializes those two global checks; reaching either global limit returns HTTP 429. JavaScript string `.length`, HTML `maxlength` and SQL `nvarchar(200)` use the title limit; a supplementary Unicode character uses two units. Both reference clients validate trimmed input before HTTP, while returned titles are validated without trimming or transforming stored text. Invalid browser fields are rejected before SQL; valid attempts that encounter quota or missing items consume a rate slot. Session-row locks serialize per-session mutations, and expiry is checked after acquiring those locks. Regular cleanup removes at most 32 expired sessions; capacity checks remove all expired sessions before counting active ones. Logical expiry does not wait for cleanup. DAB can execute only the eight configured procedures, not table CRUD, DDL or internal helpers.

SQL stores hashes of opaque session cookies, never their original values. Ownership is passed explicitly to every procedure and never read from pooled session context; the selected DAB configuration disables session-context forwarding. Public cookies are Secure/HttpOnly/SameSite=Strict. Loopback cookies have distinct origin-derived names to avoid sharing anonymous browser state across local workspaces.
