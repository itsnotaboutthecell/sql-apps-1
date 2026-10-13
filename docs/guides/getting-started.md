# Get started

Prepare your computer to build and run SQL Apps locally. You do not need an Azure subscription or Azure CLI login.

## 1. Install the foundation and create a project

On the repository page, choose **Code -> Download ZIP**, or clone it with Git. If it was shared with you, confirm which branch to use. For a ZIP download, extract it first.

Open a terminal in the trusted SQL Apps foundation folder, then create an
independent application:

```powershell
npm run projects -- create "My App"
```

Projects default to `%USERPROFILE%\SqlAppsProjects` on Windows and
`~/SqlAppsProjects` elsewhere. Change the root before creating projects when
needed:

```powershell
npm run projects -- root "D:\SqlAppsProjects"
```

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
| Docker with Linux containers | Run local SQL and Data API builder containers. |
| Azure SQL Database container private-preview access | Download the SQL image for first use, unless a usable image is already cached or a current container is available. |

Initial npm packages, SQL tools and container images require internet and disk space. Docker Desktop has [license conditions](https://docs.docker.com/subscription/desktop-license/) and is not free for every organization. No Azure CLI, host DAB or host sqlcmd installation is needed.

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
node scripts/setup-check.mjs
```

This works before dependency restore or build. It does not install tools, accept licenses, change databases or start services. Read each **Next** instruction and rerun after resolving missing requirements.

If a command is not found, reopen the terminal before reinstalling. Supported version checks are `node --version`, `npm --version` and `dotnet --list-sdks`. Docker's engine must be running, not just installed.

For a container that its owner has agreed you may reuse:

```powershell
node scripts/setup-check.mjs --container existing-sql-name
```

Replace the name with the actual container. This inspects safe state; it does not certify the engine or modify its database.

## 4. Get SQL preview access

The Azure SQL Database container is in **private preview**. [Request access](https://aka.ms/azuresqldb-container-signup) and follow the [container documentation](https://aka.ms/azuresqldb-container) for a first image download. Complete registry sign-in in your own terminal with the provided pull credentials. Do not put them in chat, source files or screenshots.

If a usable image is cached, you do not need to download it again just to refresh it. Startup verifies the actual SQL engine. If preview access is not available yet, keep your completed setup and resume when it is; do not substitute a different database.

Startup passes `ACCEPT_EULA=Y`; there is no chat dialog. Review the [container documentation/access instructions](https://aka.ms/azuresqldb-container) and applicable terms supplied with your preview registry access before approving SQL startup under those terms. If those terms are unavailable, pause rather than assume acceptance. This approval does not cover other licenses or later operations.

You do not need to acknowledge an unchanged reviewed document every session. [Remember local permissions](../reference/local-consent.md) explains the separate persisted terms digest and revocable checkout-scoped operation grants. Plan all upcoming effects together, record only explicit approvals, and ask again only for missing/changed scopes or terms. A local terms copy cannot detect remote changes by itself.

## 5. Choose your next step

Once your app scope is agreed, use the dependency-free [setup coordinator](../reference/setup.md):

```powershell
node scripts\setup.mjs plan --json
```

`role-based-data` is the only profile, so `--profile role-based-data` is
optional. Setup does not generate screens or select an example. The report
separates prerequisites, dependencies, current build, workspace, startup
permissions and application acceptance.
`setup plan` installs nothing. Install missing system tools with separate
`setup install-plan <tool>` reviews. Everything else is one approval:
`setup approval --profile role-based-data --workspace <base-port>` lists
restore, build, workspace, startup and the SQL terms line; after you approve,
`setup approve` records it and `setup run` continues. Licenses, preview
credentials and required restarts remain human steps. See the reference for
platform support and verification limits.

- **Build your own app:** follow [Build your app](build-your-app.md).
- **Try an implemented example:** follow the [Todo reference guide](../../examples/todo/README.md).
- **Start, stop or resume the app:** follow [Run locally](run-locally.md).

For diagnostics and data-preserving recovery, see the [local runtime reference](../reference/local-development.md).
