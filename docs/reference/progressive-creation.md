# Progressive application creation

New guided projects open one loopback browser origin before dependency restore.
The page reveals **Data -> Data access -> Application services -> Application**
as working capabilities are verified. It becomes the application at that same
origin; it does not redirect to a different server port.

## Create with a reviewed plan

From the foundation, without installing the application's dependencies:

```powershell
npm run projects -- create-plan "My App"
npm run projects -- create "My App" --approval <printed-id>
```

The installed plugin's absolute `sql-apps.mjs` launcher accepts the same
`projects` commands. Review the printed destination, new Git repository, port
block, local helper, browser launch and nonsecret session files before approving.
The helper starts before scaffold copying and survives the creating command.
If automatic browser opening fails, open the printed loopback URL manually.
Ports are checked, not reserved; a competing listener fails explicitly.

Creation approval does **not** authorize dependency installation, SQL terms,
schema publication, service recovery or cloud resources. The plan lists those
known later effects together, but the existing [setup approval](setup.md) remains
their authority. Surface new blockers or milestones, not repeated waiting messages.

The original `projects create "My App"` remains a nonprogressive compatibility
path. Existing projects/workspaces keep their direct-start behavior.

## What each check means

| Milestone | Required evidence |
| --- | --- |
| Data | Successful configured least-privilege SQL acceptance/query, not container startup. |
| Data access | Owned, current DAB/gateway identity and readiness backed by an authorized SQL procedure query. |
| Application services | Authenticated configured readiness response with a row envelope, plus every declared endpoint contract. |
| Application | Actual HTML document response and verified required data path. |
| Ready | All current capabilities, primary browser journey evidence, and accepted desktop/narrow design evidence. |

A build exit, process listener, liveness response or historical checkpoint never
grants Ready. **Usable - review pending** means the application is available,
not that browser or design acceptance passed. A compact local-only strip links
back to checks. After acceptance the message becomes secondary; no status strip
is added to the cloud app.

Capabilities retain their own diagnostics. A failed sibling endpoint does not
hide healthy verified endpoints: local preview offers a read-only **Inspect**
link while other work continues. Inspector sessions are short-lived and revoked
after the request. It never invokes MCP tools or retries mutations.

The default contract verifies only the configured REST readiness procedure.
Declare additional *required*, app-relevant surfaces in `creation-checks.json`:

```json
{
  "version": 1,
  "checks": [
    { "kind": "rest", "path": "/api/ContactSummary" },
    { "kind": "graphql", "path": "/graphql", "query": "query Contacts { contacts { items { id } } }" },
    { "kind": "mcp", "path": "/mcp" },
    { "kind": "openapi", "path": "/openapi" }
  ]
}
```

Use only configured gateway paths. REST checks are GETs requiring `value` arrays;
GraphQL accepts named read-only queries and rejects mutation tokens; MCP sends
only JSON-RPC `tools/list` and requires a JSON tools result; OpenAPI requires
`openapi` and `paths`. Unsupported/stream-only responses fail visibly rather than
being assumed healthy. At most 12 additional contracts are allowed. The file is
included in source provenance; modifying it requires rebuilding and revalidation.
Do not declare services the application does not use.

In real Entra mode, sign in through the application and exercise its configured
readiness path. A previous helper's authenticated observations cannot establish
readiness after restart. The helper and gateway must use the same authentication
mode/tenant/client; changing them requires an approved helper restart with the
matching environment, not adoption of the mismatched service.
To probe additional protected contracts, the helper can
read `SQL_APPS_ACCEPTANCE_TOKEN` from its process environment; supply it through
your secure terminal/session, never source, URL, chat or evidence. Tokens are
not written to status snapshots. Without authenticated evidence the appropriate
stage remains blocked; preview identities do not prove Entra authorization.

## Status, retry and ownership

Using the installed launcher (or `npx --no-install sql-apps` after restore):

```powershell
npx --no-install sql-apps creation status
npx --no-install sql-apps creation check
npx --no-install sql-apps creation start --approval <startApproval-from-status>
npx --no-install sql-apps creation stop
```

`status` observes without starting resources. `check` repeats bounded read-only
capability probes; in preview mode it creates/revokes an in-memory preview
identity, but performs no SQL mutations or resource recovery. Both expose
diagnostics and historical/stale states if the owned helper is unavailable.
`start` needs its current reviewed approval; `stop` verifies the responding
session and PID before stopping only that front door. Neither stops SQL/DAB.
Keep normal application `app`/`serve` processes attached and use their existing
Ctrl+C/stop semantics. Restarting the helper never silently starts services.

The helper verifies once at startup. Repeated deep source/evidence/capability
checks run only with an active browser event subscriber; an idle helper does
not keep hashing files or creating preview sessions. Status/page requests
trigger a coalesced refresh when due, and explicit `check` still waits for a
bounded check. Cached capabilities and surfaces become stale after two check
intervals without a completed observation; reopening a page re-verifies them.

Version-2 workspace descriptors mark `topology: "front-door"`: public
`ports.gateway` stays base+0, DAB base+1, `ports.internalGateway` base+2, SQL
base+5. The private gateway requires the public Host/Origin. Only the fixed owned
loopback upstream is proxied; caller forwarding headers are removed.

The project stores `.sql-apps/creation-session.json`, pointing to the canonical
user `.sql-apps/creation-sessions/<session-id>` directory. Bounded snapshots and
process receipts use restricted files and serialized atomic updates. This
filesystem control channel is not a browser write API. Source, tooling, selected
SQL target or authentication changes invalidate prior acceptance. Missing or
changed evidence artifacts also invalidate acceptance. Disconnect/reconnect
never turns persisted green checks into current health.

## Import actual browser and design evidence

First verify one primary interaction in the browser: save, open a fresh browser
document and observe refetched persisted state, then observe a rejected save
with visible error feedback. Do this before expanding to other workflows.
Complete the independent [render-critique-improve review](design-acceptance.md).

Retain artifacts inside the project and write an evidence JSON file, for example
`docs/evidence/creation.json`:

```json
{
  "version": 1,
  "build": "<current creation status build fingerprint>",
  "origin": "http://127.0.0.1:30000",
  "observedAt": "2026-01-01T12:00:00.000Z",
  "workflow": {
    "primaryAction": "Save customer contact",
    "save": { "persisted": true, "artifact": "docs/evidence/save.txt" },
    "reload": { "freshDocument": true, "persisted": true, "artifact": "docs/evidence/reload.txt" },
    "failedSave": { "visibleFeedback": true, "artifact": "docs/evidence/failed-save.txt" }
  },
  "design": {
    "desktop": { "width": 1280, "height": 800, "artifact": "docs/evidence/desktop.png" },
    "narrow": { "width": 390, "height": 844, "artifact": "docs/evidence/narrow.png" }
  }
}
```

PNG dimensions must match actual CSS viewport dimensions (capture at CSS scale),
with desktop width at least 1024 and narrow width at most 768.
`docs/design-review.md` must record the exact current origin and source fingerprint
under Review target, complete unblocked matrix coverage, critique and accepted
quality verdict. Coverage alone is not acceptance. Artifacts must be nonempty,
project-contained regular files without symlinks, at most 10 MiB each.

```powershell
npx --no-install sql-apps creation accept "C:\path\to\My App\docs\evidence\creation.json"
npx --no-install sql-apps creation check
```

The importer validates and hashes retained evidence; it does not manufacture
observations or prove that a human's report is truthful. Synthetic fixtures test
the evidence protocol, not SQL persistence or a generated application's quality.
Missing browser tools, blocked design, missing artifacts or a stale build leave
acceptance incomplete. Final Ready still requires live capabilities.

## Release prerequisite

Independent projects pin an exact `@microsoft/sql-apps` version. A local build,
tarball or successful packaged regression does not prove that version can be
installed from the configured npm feed. Verify a clean install from that feed
before release acceptance. An E404 is an explicit release blocker; never
silently switch registries, versions or vendor binaries as a success substitute.

The generated lockfile includes the pinned package entry and promotes its
runtime dependencies from the foundation's dev-only tree. A real `npm ci`
regression uses a bounded loopback registry and an empty package cache to prove
fresh-install and production dependency behavior independently of public-feed
availability. That test is not evidence that the package has been published.
