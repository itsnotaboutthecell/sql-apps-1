# SQL Apps

<img src="content/icons/sql-apps.png" alt="SQL Apps icon: a blue database with a purple application ribbon" width="160">

**Start free. Build something real. Make it yours.**

SQL Apps gives you a working application foundation and guides for creating your own screens, data and workflows with the AI assistant of your choice. You can start with an idea rather than a framework choice.

## What will you build?

- An equipment checkout app that records loans and returns.
- An inventory app that helps a team find and update stock.
- A registration app that collects and manages signups.
- A small team workflow where signed-in members with the right role review and update shared records.

These are ideas for your own application, not prebuilt templates. SQL Apps includes a separate [Todo reference app](examples/todo/README.md) if you want to try a concrete example first.

## Create a project

Keep this foundation checkout as the SQL Apps tool source. Create each application
as an independent Git repository under your user project root (by default
`%USERPROFILE%\SqlAppsProjects` on Windows):

```powershell
npm run projects -- create "Equipment Checkout"
```

The command creates `%USERPROFILE%\SqlAppsProjects\equipment-checkout`, records
it as the active SQL Apps project and initializes its Git history. It refuses to
merge into an existing folder. Use `npm run projects -- root D:\SqlAppsProjects`
to choose another absolute root, `npm run projects -- list` to see registered
projects, and `npm run projects -- open C:\path\to\project` to register an
existing SQL Apps project.

Open the generated project—not this foundation checkout—in your preferred editor
and give your AI assistant access to that project. Ask:

> Help me build an equipment checkout app with SQL Apps. Start by asking who will use it and what it should do. Help me run it locally, then make one useful change. Do not deploy it yet.

Replace equipment checkout with your idea. Follow [Build your app](docs/guides/build-your-app.md) for the walkthrough, or [Get started](docs/guides/getting-started.md) if you need help installing tools.

The journey is **Describe -> Run locally -> Make it yours -> Share optionally**.

Already have Node installed? Check your setup from the generated project folder:

```powershell
node scripts/setup-check.mjs
```

The check explains missing prerequisites without installing anything. The guides and commands do not require a particular LLM provider. If you use GitHub Copilot, the optional [Copilot plugin](docs/reference/copilot-plugin.md) adds project-specific skills. Local work needs only that plugin; its documentation lists the maintained Microsoft SQL, Azure Skills and Azure Cost companion plugins to install when you choose cloud work.

For one connected setup journey, ask your assistant to use the [setup coordinator](docs/reference/setup.md). It plans needed installation, restore, build, workspace and startup steps, then resumes after explicit approvals without repeating current work. It does not generate your domain app, accept licenses or deploy to Azure.

## What to expect

**Local first.** No Azure subscription is needed to run locally. You need Node 22 or 24, a .NET SDK, Docker with Linux containers, and access to the Azure SQL Database container. The container is in **private preview**: [request access](https://aka.ms/azuresqldb-container-signup) and read the [container documentation](https://aka.ms/azuresqldb-container). Initial package and image downloads require internet. Docker and your chosen AI provider have their own licensing/access conditions.

**Your application.** Work with your AI assistant to implement and test its screens and SQL behavior in its generated repository. The project factory creates the runtime foundation, not a finished domain app. The default project has no Todo screen or sample data; examples are selected explicitly.

**A useful first result.** Run the app, sign in as a development user and see its readiness check pass, then add your first table, stored procedure and screen. A launch URL is usable only after the intended server responds. [Run locally](docs/guides/run-locally.md) explains startup paths, scoped approvals and how to keep your data between sessions.

**Sharing is optional.** The primary personal-project target is Static Web Apps Free, managed Functions and the Azure SQL Database free offer. It can plausibly remain at $0 only within current allowances, and it has no Static Web Apps SLA. When you are ready to share, read [Sharing your app](docs/guides/sharing.md) and [Costs and growth](docs/guides/costs.md).

## Find your next step

| I want to... | Start here |
| --- | --- |
| Set up my computer | [Get started](docs/guides/getting-started.md) |
| Turn an idea into an app | [Build your app](docs/guides/build-your-app.md) |
| Try the included example | [Todo reference](examples/todo/README.md) |
| Start, stop or resume locally | [Run locally](docs/guides/run-locally.md) |
| Understand cloud costs | [Costs and growth](docs/guides/costs.md) |
| Share with other people | [Sharing your app](docs/guides/sharing.md) |
| Find detailed commands or contribute | [Documentation index](docs/README.md) |

Under the hood, SQL Apps uses TypeScript and Azure SQL Database. Local development uses Data API builder and a sign-in gateway; the primary personal cloud profile uses a managed Functions API with an explicit stored-procedure allowlist. If your app later needs file storage or background jobs, add them with maintained Azure skills rather than SQL Apps.

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos must follow the [Microsoft Trademark and Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos is subject to those third parties' policies.

## License

[MIT](LICENSE)

For contributions and help, see [Contributing](CONTRIBUTING.md), [Support](SUPPORT.md) and [Security](SECURITY.md).
