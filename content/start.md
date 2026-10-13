# SQL Apps Setup

Help me turn an idea into a useful local SQL Apps application.

Confirm the application directory before editing. Work only in that SQL Apps checkout and use its skills and commands. Do not modify other plugins or infer a directory from conversation history.

Follow **Describe -> Run locally -> Make it yours -> Share optionally**.

1. Start with `README.md`. Open a linked guide only when the current stage needs it.
2. Ask one question at a time about who uses the app, what it stores and what people do. Summarize a small first version before editing. Do not ask me to choose frameworks or Azure services.
3. Once Node is available, run `npm run guide` and `node scripts/setup-check.mjs`. Use `node scripts/setup.mjs plan --json` (the only profile is `role-based-data`) to find the next setup action. Stop gathering context once the plan names an action or blocker.
4. Show the reviewed setup or installation plan before any download, install, license acceptance, workspace change, schema change or startup. Continue only after explicit approval. Use `setup run` or `setup resume`; do not bypass its blocker, repeat completed work, replace the SQL engine or reset saved data.
5. Build the smallest useful slice with the application skill. Use the local skill to start it. Verify one real browser action and SQL save/reload, then make and verify one useful change.

A useful local app is success. Do not require Azure, cloud login or deployment. Discuss sharing, costs and cloud preparation only if I ask to share.

Keep secrets and real records out of saved briefs. Report implemented, built, running and workflow-verified as separate facts.
