# Run locally

Run a browser app backed by SQL on your own computer. No Azure subscription is required. Complete [Get started](getting-started.md) first.

## Choose what to run

| What you are working on | Startup path |
| --- | --- |
| Your own app | Follow [Build your app](build-your-app.md), then the startup below. It starts SQL, Data API builder (DAB) and the browser gateway. |
| The included Todo reference | Follow the [Todo guide](../../examples/todo/README.md). It starts only SQL, DAB and the browser/API. |

SQL Apps has one profile, [role-based-data](../reference/role-based-data.md): Azure SQL Database plus DAB, with a dedicated application role and a read-only readiness procedure. The starter is a minimal status page; your domain screens need to be implemented. File storage and background jobs are outside SQL Apps; add them with the maintained Azure skills.

## Approvals and readiness

The [setup coordinator](../reference/setup.md) connects these steps without
requiring a desktop executable. Run `npm run setup -- plan --json`
before changing anything. After explicit approvals, `run` or `resume` rechecks
the checkout, skips current dependencies/builds and launches the app.
It never records grants automatically. The existing individual commands below
remain available; selected examples retain their separate application workflow.

Before the first approval, explain what stays separate: tool installations (only if missing) and anything in Azure. Everything else for local startup is one approval: `npm run setup -- approval --profile role-based-data --workspace <base-port>` lists restore, build, the workspace port block, image downloads, SQL startup, schema, services, the read-only SQL acceptance check and the SQL terms line, with exclusions. After explicit approval run the printed `setup approve ... --approval <id>`, then `setup run`. Editing your application's SQL, DAB configuration or `role-based-data.json` reuses the approval; launcher, port or terms changes show a new id to review.

[Remembered local permissions](../reference/local-consent.md) store that approval per checkout and workspace across sessions. Grants are revocable, never global, and do not cover tool installations or Azure deployment.

If the approval control first returns "user unavailable" or is invisible, no approval was captured. Stop retrying that control. The assistant should provide one precise statement with the actual checkout, operations, effects and exclusions that you can send in ordinary chat. Wait for explicit consent before continuing.

Startup passes `ACCEPT_EULA=Y`; there is no chat dialog. Review the [container documentation/access instructions](https://aka.ms/azuresqldb-container) and applicable preview terms supplied with your registry access. The terms line in the setup approval permits the launcher to pass that value; it is not approval for other licenses.

Use the validation skill for current evidence and reporting. A proposed port/URL is unavailable until the intended server responds and readiness checks pass. Only then open/publish the launch URL. Verify the agreed browser save/reload action and SQL persistence separately; tests or a successful build do not replace it. If launch is blocked, the task is blocked, not complete.

Initial launch requires the configured readiness procedure (default `/api/AppReady`) to succeed through DAB with the required role (default `AppUser`). A matching gateway that responds but is not ready is a setup blocker, not a launch success. Setup does not replace it automatically.

An early synthetic or mock-only shell is useful progress, not proof of SQL connectivity. Approve the visual direction before substantial UI work and review the actual desktop/mobile render when feasible.

## Start the app

Configure the dedicated application role and read-only readiness procedure in `role-based-data.json` as described in [role-based-data](../reference/role-based-data.md). From the project folder:

```powershell
npm ci
npm run build
npm run local -- workspace-plan
```

Review the proposed port block. Select it by replacing `<base-port>` with the reported value:

```powershell
npm run local -- workspace-init <base-port>
npm run local -- app
```

Workspace selection keeps this checkout's service names, ports and saved state separate. `app` (alias `role-based-app`) runs four stages: `start-sql`, `init`, `data` and `serve`. It downloads missing images, accepts the SQL container EULA, publishes the project schema, starts DAB and launches the browser gateway. Read the [local runtime reference](../reference/local-development.md) before reusing an existing stack or database.

The workspace and startup commands above are covered by the single `setup approval` bundle; with the individual commands you can instead record scopes from their [consent plans](../reference/local-consent.md). Use the guarded `consent run restore`/`consent run build` paths for assistant-led work; raw package commands are not permission bypasses.

After the intended server responds and `/health/ready` passes, open its reported browser URL and select **Open local preview**. The product offers **Open local preview**, not a persona selector. To check authorization, open the reported local-only developer page in the same tab and switch between Development Alice (has the required role) and Development Bob (does not). Bob receives HTTP 403 for data requests; `/auth/me` reports whether access is allowed. Real Entra sign-in is an explicit local opt-in described in [Authentication and application access](../reference/authentication.md).

Preview identities are simulations, not production sign-in. Keep the local app and DAB on loopback; do not expose them to other computers. See the [authentication boundaries](../reference/authentication.md#three-distinct-boundaries) for how preview, real local Entra sign-in and cloud backend identity differ.

For your own application, try its main action and reload to check persistence. Use test data, not sensitive production records. The selected synthetic reference is not a role-authorized substitute.

## Stop and return later

Press **Ctrl+C** in the browser-server terminal. SQL data remains saved; the SQL and DAB containers may still be running.

To resume against those services:

```powershell
npm run local -- serve
```

To stop the DAB container without deleting data:

```powershell
npm run local -- stop
```

After `stop`, use `app` (or `data`, then `serve`) to start again. Selected-reference commands have their own stop/resume steps in the Todo guide. Do not delete volumes or saved credentials to restart an app. In preview mode, open local preview again after a gateway restart; SQL data persists independently of the session.

`serve` (alias `role-based-serve`) only resumes the gateway against existing SQL and DAB. It tries readiness three times, with one-second pauses and a four-second shared deadline per attempt, then reports the named failure without listening or publishing a ready URL. It never starts or restarts a dependency. Inspect the failure before separately approved recovery; full `app` startup recreates the owned DAB container and is not a diagnostic retry.

If SQL or DAB fails after a successful launch, keep the gateway running. Readiness becomes HTTP 503 while liveness remains HTTP 200. Readiness recovers on the next successful probe without a gateway restart.

## When something fails

Read the named failed startup stage (`start-sql`, `init`, `data` or `serve`) before retrying. Common first checks:

- **Tool not found:** reopen the terminal after installation and run the setup check again.
- **Docker unavailable:** start its Linux-container engine.
- **SQL image unauthorized:** complete preview access in your own terminal.
- **Port occupied:** identify the existing app; do not stop an unrelated process.
- **SQL error:** use the [local runtime reference](../reference/local-development.md) for diagnostics and recovery.
- **Readiness names `data`:** inspect SQL and DAB before requesting recovery. Anonymous DAB aggregate health is not proof that the authorized SQL procedure failed.

For deeper checks, use the [local runtime reference](../reference/local-development.md). Test commands that create sessions or restart services are described there so you can choose when to run them.
