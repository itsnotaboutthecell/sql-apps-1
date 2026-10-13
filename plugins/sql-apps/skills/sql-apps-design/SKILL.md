---
name: sql-apps-design
description: "Route substantial SQL Apps interface design to an available frontend design capability while preserving SQL Apps application-state and access requirements."
---

# Design a SQL Apps interface

Use the host's maintained frontend or design skill for visual direction, component styling, responsive behavior, and rendered review. SQL Apps does not maintain a separate general-purpose design system.

If no suitable design skill is available, follow the application's existing components, tokens, and accessibility conventions rather than importing a new framework, package, font, or design system without approval.

`sql-apps-application` remains authoritative for domain behavior, identity, capabilities, and functional acceptance. Preserve these SQL Apps-specific UI requirements:

- Product screens show real account and access states, never persona selectors. A signed-in user without the required role sees a clear no-access state (the gateway returns 403 and `/auth/me` reports `access.allowed: false`).
- Local test identities stay on the developer page and are not real-user onboarding.
- Loading, empty, error, disabled, save, and reload states must reflect actual SQL/DAB outcomes.
- Visual approval does not authorize schema, identity, data, or startup changes.
- Use `sql-apps-validation` for application and database acceptance; screenshots alone do not prove it.
