---
name: sql-apps-design
description: "Use for every new user-facing SQL Apps application and meaningful UI change. Discover and invoke an available host frontend/design capability, or perform an intentional stack-neutral design pass when none is available, while preserving application-state and access requirements."
---

# Design a SQL Apps interface

Discover the host's available skills and capabilities, then invoke a suitable maintained frontend or design skill for visual direction, implementation and rendered review. Reuse known user preferences and established application styles. Write a short design intent covering audience, primary task, hierarchy, typography, palette, layout and responsive behavior. Choose sensible defaults, asking only about unresolved consequential branding or preferences.

If no suitable design skill or capability is available, perform an intentional design pass with the existing technology. Follow existing components, tokens and accessibility conventions when they exist, but evaluate and improve them where needed. Starter CSS is not design direction and is not sufficient merely because it renders. Do not impose a universal theme or require a framework, font, package or asset.

## Quality rubric

The result must have:

- coherent spacing and type hierarchy that make the primary task obvious;
- domain-led surfaces and actions, with notices and supporting information subordinate;
- intentional layout and responsive behavior without clipping, overlap or horizontal overflow;
- visible keyboard focus, semantic structure, readable contrast and accessible labels;
- designed signed-out, authorized and no-access states; and
- truthful loading, empty, error, saving, success and disabled states.

A basic shell may be small, but it is visually complete for its scope. Review the primary state and every reachable state rather than polishing only the happy path.

`sql-apps-application` remains authoritative for domain behavior, identity, capabilities, and functional acceptance. Preserve these SQL Apps-specific UI requirements:

- Product screens show real account and access states, never persona selectors. A signed-in user without the required role sees a clear no-access state (the gateway returns 403 and `/auth/me` reports `access.allowed: false`).
- Local test identities stay on the developer page and are not real-user onboarding.
- Loading, empty, error, saving, success and disabled states must reflect actual SQL/DAB outcomes.
- Visual approval does not authorize schema, identity, data, or startup changes.
- Use `sql-apps-validation` for application/database acceptance and its **Rendered browser review** contract. Screenshots alone do not prove persistence or access.
