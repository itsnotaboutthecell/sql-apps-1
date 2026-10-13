# Build your app

<img src="../../content/icons/sql-apps.png" alt="SQL Apps icon: a blue database with a purple application ribbon" width="96">

Turn an idea into a working browser app, then change it to fit your needs.

**Describe -> Run locally -> Make it yours -> Share optionally.**

This walkthrough uses an equipment checkout app as an example. You can use the same steps for inventory, registrations or another small workflow. Those apps are not included templates: you and your AI assistant will implement your own screens and data.

## 1. Describe the first useful version

Create or open an independent project as described in
[Manage projects](../reference/projects.md), then open that project folder in
your preferred editor. Do not implement the app in the SQL Apps
foundation/plugin checkout. Give your AI assistant access to the project files
and guides, then ask:

> Help me build an equipment checkout app with SQL Apps. Ask me one question at a time about the people using it, the information it needs and what they should be able to do. Keep the first version small and local.

Think about:

- **People:** who records loans, and who can see or change them?
- **Information:** equipment name, borrower, checkout date and return date.
- **Actions:** register equipment, check it out and record a return.
- **First improvement:** perhaps a due date or an overdue filter.

A useful starting scope might be: "Our team can register equipment and track loans. We will use test records on this computer first. No file uploads or public access yet."

If you know SQL, bring your tables and relationships into the discussion. If not, describe the information in everyday language.

## 2. Build and run the first version

Complete [Get started](getting-started.md) before downloading dependencies or launching the app.

SQL Apps builds data apps with one profile, `role-based-data`; `npm run guide` reports it as the `suggestedProfile`. The [role-based-data profile](../reference/role-based-data.md) provides SQL/DAB/browser startup with trusted application-role forwarding and a free-limit, scale-to-zero Azure POC path. The starter is a minimal status page that calls a read-only readiness procedure; domain tables, procedures, screens and actual workflow acceptance still need implementation. If the app later needs file storage or background jobs, add them with the maintained Azure skills outside SQL Apps; do not switch to anonymous access just to fit a template.

Then ask:

> Implement the agreed screens and SQL behavior in this SQL Apps role-based-data project. Explain the files you change and help me run the app locally.

Your AI assistant can help write your frontend, API and schema; SQL Apps does not generate a complete domain app automatically. Review its changes and use the startup path for your application in [Run locally](run-locally.md). Trying the Todo reference is optional, not a prerequisite.

For substantial new screens or a visual redesign, ask your assistant to use the `sql-apps-design` skill for an app-appropriate visual direction and browser review of the rendered interface.

In the browser, create a test record and reload the page. Check that it is still there. Try a missing required field and, if the app has different users, check who can see or edit the record. Use synthetic data while developing.

## 3. Make one useful change

For example:

> Add a due date to equipment loans and show an overdue filter. Explain how the change reaches the screen and database.

Try the new behavior, check that old actions still work, and run the relevant tests with your AI assistant. This is the point where the app becomes yours: you can change what it remembers and how it works.

## Pick up where you left off

Keep a short description of the agreed app and next change. Ask your AI assistant to write the agreed brief to an untracked JSON file, then save it with:

```powershell
node scripts/guide.mjs --save "C:\path\to\project-brief.json"
```

The plugin equivalent is `guide-save "<absolute-brief-path>"`. Run `npm run guide` afterward to show saved decisions and the suggested next step. Saved check results are historical; the command does not start the app or check running services. After a code change, run the affected workflow again. See the [guide command reference](../reference/guide.md) for the brief format.

## 4. Share when it is useful

A local app is a valid stopping point. When you want other people to use it, decide who needs access and whether it contains real information.

Read [Sharing your app](sharing.md) for current deployment options and [Costs and growth](costs.md) for free-tier limits and paid capacity. Local success does not mean the app is ready for public or production use.
