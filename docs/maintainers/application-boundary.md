# Application delivery boundaries

Contributor and agent reference: use these checks when changing application composition or preparing a domain application for delivery. For the user journey, start with [Build your app](../guides/build-your-app.md).

The reusable foundation supplies SQL/DAB, browser authentication, ownership security and deployment tooling. A real application supplies its own domain UI, client operations and schema using the `role-based-data` profile. File storage and jobs are outside SQL Apps. Examples are explicitly separate, not hidden UI sections shipped to every user.

## Default boundary

`application.json` names the application and declares `selectedExamples: []`. The default runtime client, browser, DAB and SQL project are sample-free. Optional examples own their client, schema, acceptance and workflow tests under `examples/<name>/tests`; they are not application dependencies.

`tsconfig.runtime.json` compiles only runtime sources, excluding tests/examples. Container builds do not compile example tests and copy only intended runtime output. The domain-neutral `dbo.OwnerPredicate` is independently defined under `sql/security`.

New applications must not copy `examples/` or its workflow tests unless explicitly requested. Inherited tests importing an excluded example are a broken application boundary, not a reason to restore the placeholder. Keep domain-neutral tests and negative regression checks proving legacy sample SQL/API absence. The installed `sql-apps-application` skill guides application-specific development and requires the checks below. This is a validated workflow, not a general schema/application generator.

## Required evidence

Confirm the intended checkout, not a plugin cache. Inspect its `package.json`;
generated apps do not inherit foundation-only validation wrappers. The common
checks below use scaffolded commands or project-owned scripts. Restore/build,
schema and acceptance-session work retain their documented approval boundaries.

```powershell
npm run build
node scripts\check-application.mjs .
dotnet build sql\database.sqlproj --output dist\sql
node scripts\check-application.mjs . sql\obj\Debug\model\model.xml
```

Against an approved running local app, use the verified startup origin and the
selected SQL container:

```powershell
node scripts\check-application-api.mjs "<verified-origin>"
npm run local -- app-check <sql-container-name>
```

- **Source and artifacts:** scans active `src`, `public`, `dab`, `sql`, compiled `dist/src`, `dist/functions`, browser bundle and supplied SQL model. It also parses root `tests` and `dist/tests` for example imports/re-exports and literal file dependencies, including absent example trees. Fixture strings, developer TODO comments and negative SQL/API checks remain valid. The SQL project extracts the DACPAC model using MSBuild's built-in Unzip task. Rejects broad Docker copies that ship examples/test output. Missing build output fails rather than proving absence.
- **API:** creates a separate local acceptance session, verifies authenticated `/api/Todo` returns 404 and the GraphQL `todos` field produces an unknown-field/schema-validation error, then revokes its own session. A backend outage or authentication denial is not accepted as proof of absence.
- **Database:** an admin-only read-only check detects sample table/security objects and requires the shared ownership predicate. It fails on legacy databases instead of dropping objects. Fresh databases published from the default project have no sample table.

No one check proves all layers. These checks target the known reference example, not every possible generated placeholder. Add explicit signatures/acceptance for future examples rather than broad keyword bans or silently excluding failures.

Test dependency inspection includes imports/re-exports, literal filesystem calls
and simple paths stored in variables or arrays. Fixture-source strings and
paths under dynamically created temporary checkouts are not example dependencies.
Arbitrary computed paths cannot all be proved statically; applicable behavior
tests are still needed. Use declared application test scripts or the existing
compiler/Node runner on real files; missing tests are missing evidence.

## Foundation CI

In the foundation, `npm test` runs the delivery check and root tests, then
compiled workflow tests for examples actually present. An absent examples tree
is explicitly skipped; missing compiled output or a failing present workflow
fails the command. CI repeats delivery checking after SQL build.

Generated apps do not initially declare this script. Keep their own
behavior/security tests without restoring excluded examples. A targeted pass
is not full-suite evidence; use the validation skill to select checks for the
actual target.

## Domain contracts and live acceptance

Apply these rules to an application's own fields and procedures, not just the reference example:

- **Text storage:** SQL `nvarchar(n)` limits UTF-16 code units, matching JavaScript string `.length` and HTML `maxlength`, not necessarily a validator's string `.max(n)`. Test ASCII and supplementary Unicode at the exact maximum and maximum + 1 for create, update and returned records. Normalize inputs only as agreed; do not silently trim returned SQL values. Use wide procedure inputs (`nvarchar(max)`) so narrowing cannot truncate invalid input before validation; reject blank values and enforce `DATALENGTH(value) <= 2 * n` after the agreed normalization.
- **Exact values:** validate enum membership and byte length together because SQL comparisons can ignore trailing padding. Use the agreed case-sensitive/binary comparison where exact tokens are required; an unknown token must never pass through a zero-length fallback. Validate real Gregorian dates, including leap days, rather than only their textual shape. Reject caller fields for server-owned identities, ownership and status unless the app explicitly permits them.
- **Readiness:** probe the actual domain schema and required procedure access read-only. Avoid concatenating catalog/domain strings with differing collation; use independent or numeric checks. A responding readiness procedure is necessary, but does not prove CRUD, persistence or authorization.
- **Mutation results:** capture `OUTPUT ... INTO` a typed table variable rather than streaming a result to DAB before affected-row validation. Complete all `THROW` checks and the transaction before the final `SELECT`. Require the API to validate the successful row shape and requested identity for updates/deletes; an empty or mismatched result is not success.
- **Actual errors:** an early empty SQL result was observed as HTTP201 before a later error with the pinned DAB version. Raw SQL rejection can surface as HTTP500 `DatabaseOperationFailed`, not a promised HTTP404/422. Assert actual non-success and unchanged data for missing/foreign mutations; do not hide errors or weaken the contract to accept an empty success.
- **Live controls:** pair negative HTTP/SQL probes with a valid positive control using the same intended route, origin and authorization boundary. Otherwise a missing Origin or denied role can masquerade as successful input/owner validation. Verify the agreed browser action, independent SQL state and a genuinely new browser document after reload. Follow the validation skill for fixture ownership/cleanup and truthful loading/save/refresh errors.

## User-facing evidence lanes

Keep API/SQL acceptance, real browser workflow acceptance and rendered visual review distinct:

- API/SQL evidence proves the data, mutation and access contracts above.
- Real browser workflow evidence proves reachable interaction and save/reload behavior.
- Rendered visual evidence proves presentation at an identified viewport and state.

Screenshots do not prove persistence or access. Compilation, source inspection, health checks and API probes do not prove rendered visuals. Opening a tab is not visual review.

For rendered review, record provenance: intended origin, source/build, viewport, state, artifact when available, findings, fixes and re-review. Review the primary and reachable states at desktop and narrow widths when the host supports them. If tooling or a state is unavailable, record the exact blocked evidence; keep it separate from observed findings. Label user-reported feedback as user-reported rather than direct observation.

These lanes do not change consent, readiness, identity, schema or paid-resource boundaries. Visual approval never authorizes those changes, and no visual check bypasses startup coordination or access controls.

## Existing data is preserved

Schema publishing retains `DropObjectsNotInSource=False` and data-loss blocking. Removing the example from source does **not** drop its table or legacy security objects in existing databases. The old default `sql-apps-sql` database can therefore fail the database-cleanliness check even after source, API and browser are clean.

Do not enable drop-unspecified-objects or reset volumes to make acceptance pass. Review sample row counts under an administrator, export anything needed, and obtain explicit approval for a separately reviewed cleanup migration. Preserve other application objects and shared security. No automatic destructive migration is included or executed.

For a clean development database without deleting existing data:

```powershell
npm run local -- start-sql sql-apps-clean-sql
npm run local -- init sql-apps-clean-sql
npm run local -- app-check sql-apps-clean-sql
```

This creates/reuses a separately owned container and persistent volume. It does not replace the original database or start another DAB/gateway. Follow the documented lifecycle when switching local data services (only one default DAB/gateway port at a time).
