---
name: sql-apps-design
description: "Use when creating a new SQL Apps interface, substantially changing a screen, or reviewing whether a rendered application has a clear product-specific hierarchy and responsive composition."
---

# Design a SQL Apps interface

Design acceptance is separate from functional acceptance. A working shell is not a finished interface.

Discover the host's available skills and capabilities, then invoke a suitable maintained frontend or design skill for visual direction, implementation and rendered review. Look explicitly for `frontend-design` and, for self-contained web artifacts, `web-artifacts-builder`; use another maintained host capability when it is a better match. Reuse known user preferences and established application styles. Choose sensible defaults, asking only about unresolved consequential branding or preferences. SQL Apps does not maintain a separate general-purpose design system.

If no suitable design skill or capability is available, state that you are performing a manual design pass and record the reason. Do not fall back silently. Follow existing components, tokens and accessibility conventions when they exist, but evaluate and improve them where needed. Starter CSS is not design direction and is not sufficient merely because it renders. Do not impose a universal theme or require a framework, font, package or asset.

## Quality rubric

The result must have:

- coherent spacing and type hierarchy that make the primary task obvious;
- domain-led surfaces with one clear primary action per surface and secondary actions visually subordinate;
- developer and account notices visually subordinate to domain content and tasks;
- intentional layout and responsive behavior without clipping, overlap or horizontal overflow;
- readable long content, with sensible wrapping and line measure that preserve readability;
- visible keyboard focus, semantic structure, readable contrast and accessible labels;
- designed signed-out, authorized and no-access states; and
- truthful loading, empty, error, saving, success and disabled states; error, success, disabled and other status feedback uses text or iconography and must never rely on color alone.

A basic shell may be small, but it is visually complete for its scope. Review the primary state and every reachable state rather than polishing only the happy path.

## Establish the direction

Before substantial UI implementation:

1. Identify the dominant user action and the information that must be understood first.
2. Develop two distinct compositions, not color or typography variants. Compare their hierarchy, density, interaction prominence, and product character.
3. Write `docs/design-intent.md` using the exact contract in `docs/reference/design-acceptance.md`, including the capability used or the manual fallback reason.
4. Select and document one direction. If the user is unavailable, make the selection from the saved brief rather than defaulting to a generic dashboard.
5. Treat a basic shell as an implementation milestone, not final design acceptance.

Example: an elapsed-time tracker should lead with the tracked items, elapsed values, and completion action. Task creation, account administration, and routine status messages are secondary. The composition must not imply that a long interval is bad.

## Review the rendered interface

Review empty, single-record, and populated states at mobile and desktop sizes. Check:

| Concern | Acceptance question |
| --- | --- |
| Priority | Does the product's defining information appear before setup, explanation, or administration? |
| Density | Does sparse content still form an intentional composition without empty-grid artifacts? |
| Actions | Is the recurring action more prominent than occasional creation or maintenance? |
| Character | Does the interface express the product idea rather than only applying a palette? |
| States | Do loading, empty, error, disabled, save, and reload states reflect actual SQL/DAB outcomes? |

Iterate on material problems before delivery. A screenshot or visual approval is evidence for design review, not functional correctness.

Record the state-by-viewport evidence in `docs/design-review.md` using `docs/reference/design-acceptance.md`. Empty cells are unreviewed; blocked and `n/a` cells require reasons. Run `sql-apps check` and report its design acceptance count.

`sql-apps-application` remains authoritative for domain behavior, identity, capabilities, and functional acceptance. Preserve these SQL Apps-specific UI requirements:

- Product screens show real account and access states, never persona selectors. A signed-in user without the required role sees a clear no-access state (the gateway returns 403 and `/auth/me` reports `access.allowed: false`).
- Local test identities stay on the developer page and are not real-user onboarding.
- Loading, empty, error, saving, success and disabled states must reflect actual SQL/DAB outcomes.
- Visual approval does not authorize schema, identity, data, or startup changes.
- Use `sql-apps-validation` for application/database acceptance and its **Rendered browser review** contract. Screenshots alone do not prove persistence or access.

## Red flags

- The design direction is only a list of colors, fonts, radii, or shadows.
- The first screen prioritizes introduction, setup, or administration over the recurring task.
- One fixed grid is accepted without sparse and populated review.
- Backend or browser checks are used as a substitute for rendered design review.

## Common mistakes

- **Calling the first working shell complete:** review and iterate after real data renders.
- **Treating two themes as two concepts:** change composition and hierarchy, not just styling.
- **Waiting indefinitely for preference:** when the brief is settled, select and document the stronger direction.
- **Letting design authorize data changes:** keep schema, identity, startup, and destructive work in their owning approval paths.

Functional acceptance and design acceptance are separate. Neither substitutes for the other.
