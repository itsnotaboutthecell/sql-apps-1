# Get started

Prepare your computer to build and run SQL Apps locally. You do not need an Azure subscription or Azure CLI login.

## 1. Install the foundation and create a project

On the repository page, choose **Code -> Download ZIP**, or clone it with Git. If it was shared with you, confirm which branch to use. For a ZIP download, extract it first.

Open a terminal in the trusted SQL Apps foundation folder, then create an
independent application:

```powershell
npm run projects -- create-plan "My App"
npm run projects -- create "My App" --approval <printed-id>
```

Projects default to `%USERPROFILE%\SqlAppsProjects` on Windows and
`~/SqlAppsProjects` elsewhere. Change the root before creating projects when
needed:

```powershell
npm run projects -- root "D:\SqlAppsProjects"
```

Review the first command's effects before using its approval ID. The browser
opens immediately on a creation page, before app restore; the same origin becomes
your application as capabilities are verified. Creation does not authorize later
setup changes. See [progressive creation](../reference/progressive-creation.md).

The create command refuses an existing destination, initializes a new Git
repository and records the project as active. Open the generated folder
containing `package.json`, `scripts` and `src` in your preferred editor. The
foundation/plugin checkout remains separate and should not become an
application. See [Manage projects](../reference/projects.md).

You can ask your AI assistant:

> Help me set up SQL Apps on this computer, one step at a time. Check what is installed and explain downloads and license requirements before changing anything. Do not deploy to Azure or delete existing data.

An AI assistant is optional for running the application. Guided app building can use your preferred LLM provider, subject to its account, access and pricing conditions. Review its data-handling policies before sharing project files. Never paste passwords or registry credentials into chat.

## 2. Check the requirements

| Tool or access | Why you need it |
| --- | --- |
| Node.js 22 or 24 with npm | Build and run the application and setup check. |
| .NET SDK 8 or later | Build and publish the SQL schema. Choose SDK, not just Runtime. |
| Docker with Linux containers | Preferred container route only; endpoint fallbacks use host DAB without Docker. |
| Azure SQL Database container private-preview access | Preferred first-use route, unless cached. If unavailable, offer Azure SQL directly, then SQL Server 2025 Express on Windows x64. |

Initial npm packages, SQL tools and container images require internet and disk space. Docker Desktop has [license conditions](https://docs.docker.com/subscription/desktop-license/) and is not free for every organization. Azure CLI is needed only when choosing Azure SQL directly. Endpoint routes restore pinned host DAB under the services approval; host sqlcmd is not required.

Endpoint routes also require the .NET **and ASP.NET Core 8.0 runtimes**,
even if a newer SDK is installed. The setup check identifies missing runtimes;
review `setup install-plan dotnet` to install SDK 8 side-by-side, preserving
existing SDKs. This is separate from permission to restore the DAB tool.

### Windows

Install only what is missing:

1. [Node.js](https://nodejs.org/en/download), including npm. Keep an existing supported version-manager installation.
2. [.NET SDK](https://dotnet.microsoft.com/download), version 8 or later.
3. [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Check its hardware, Windows and license requirements, then start it in **Linux containers** mode.

If Docker requires WSL, virtualization or a reboot, follow its linked instructions with your administrator as needed. Review license agreements yourself.

Close and reopen the terminal after installation. Restart your editor if it still sees the old PATH.

### macOS

Check **Apple menu -> About This Mac** for Intel or Apple Silicon. Install the matching [Node.js](https://nodejs.org/en/download), [.NET SDK](https://learn.microsoft.com/dotnet/core/install/macos) and [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) packages.

The SQL image is x64-only. Apple Silicon uses x64 emulation; having Docker installed does not guarantee that this workload will run. Follow Docker's emulation guidance if startup fails. Open a new terminal after installing tools.

### Linux

Check your distribution and version in `/etc/os-release`. Use [Node.js downloads](https://nodejs.org/en/download), the [.NET Linux distribution selector](https://learn.microsoft.com/dotnet/core/install/linux) and the [Docker Engine distribution selector](https://docs.docker.com/engine/install/).

For Ubuntu or Debian, follow the official instructions for that exact distribution and version; package feeds differ. Verify Node is 22 or 24 instead of assuming the distribution package is current. Keep an existing supported version-manager installation.

If Docker reports socket permission denied, follow its [post-install guidance](https://docs.docker.com/engine/install/linux-postinstall/). Docker group membership grants powerful host access. Do not make the socket world-writable or run the entire app as root to hide the problem.

## 3. Run the setup check

From the generated project folder:

```powershell
npm run setup:check
```

This requires restored tooling, not an application build. Before restore, use
the installed plugin launcher's `setup plan --json` through its explicit
foundation binding; see [setup](../reference/setup.md). The checks do not install
tools, accept licenses, change databases or start services. Read each **Next**
instruction and rerun after resolving missing requirements.

If a command is not found, reopen the terminal before reinstalling. Supported version checks are `node --version`, `npm --version` and `dotnet --list-sdks`. Docker's engine must be running, not just installed.
For endpoint routes, also check `dotnet --list-runtimes` for both
`Microsoft.NETCore.App 8.0.x` and `Microsoft.AspNetCore.App 8.0.x`.

For a container that its owner has agreed you may reuse:

```powershell
npm run setup:check -- --container existing-sql-name
```

Replace the name with the actual container. This inspects safe state; it does not certify the engine or modify its database.

## 4. Get SQL preview access

The Azure SQL Database container is in **private preview**. [Request access](https://aka.ms/azuresqldb-container-signup) and follow the [container documentation](https://aka.ms/azuresqldb-container) for a first image download. Complete registry sign-in in your own terminal with the provided pull credentials. Do not put them in chat, source files or screenshots.

If a usable image is cached, you do not need to download it again just to refresh it. Startup verifies the actual SQL engine. If preview access is unavailable, do not stop the whole journey: offer **Azure SQL directly**, then **SQL Server 2025 Express on supported Windows x64**. Follow [database selection and separate approvals](../reference/setup.md#choose-a-database-without-blocking-the-journey). Never silently switch an existing database or present mock persistence as working SQL.

Startup passes `ACCEPT_EULA=Y`; there is no chat dialog. Review the [container documentation/access instructions](https://aka.ms/azuresqldb-container) and applicable terms supplied with your preview registry access before approving SQL startup under those terms. If those terms are unavailable, pause rather than assume acceptance. This approval does not cover other licenses or later operations.

You do not need to acknowledge an unchanged reviewed document every session. [Remember local permissions](../reference/local-consent.md) explains the separate persisted terms digest and revocable checkout-scoped operation grants. Plan all upcoming effects together, record only explicit approvals, and ask again only for missing/changed scopes or terms. A local terms copy cannot detect remote changes by itself.

## 5. Choose your next step

Once your app scope is agreed, use the [setup coordinator](../reference/setup.md):

```powershell
npm run setup -- plan --json
```

`role-based-data` is the only profile, so `--profile role-based-data` is
optional. Setup does not generate screens or select an example. The report
separates prerequisites, dependencies, current build, workspace, startup
permissions and application acceptance.
`setup plan` installs nothing. Install missing system tools with separate
`setup install-plan <tool>` reviews. With pinned tooling installed, local stages share one approval:
`setup approval --profile role-based-data --workspace <base-port>` lists
restore, build, workspace, startup and the SQL terms line; after you approve,
`setup approve` records it and `setup run` continues. Licenses, preview
credentials and required restarts remain human steps. See the reference for
platform support and verification limits.

- **Build your own app:** follow [Build your app](build-your-app.md).
- **Try an implemented example:** follow the [Todo reference guide](../../examples/todo/README.md).
- **Start, stop or resume the app:** follow [Run locally](run-locally.md).

For diagnostics and data-preserving recovery, see the [local runtime reference](../reference/local-development.md).
