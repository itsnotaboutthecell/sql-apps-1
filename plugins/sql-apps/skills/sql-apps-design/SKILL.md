---
name: sql-apps-design
description: "Use when building or changing SQL Apps screens, or reviewing a generic interface, unclear hierarchy, or responsive layout."
---

# Design for the app

Own the design pass in the app's existing stack. No companion skill is required. Functional acceptance and design acceptance are separate; a working shell is not a finished design.

## Choose a direction

Before meaningful UI implementation:

- Read the agreed brief: audience, recurring task, and information users need first.
- Compare two distinct compositions: hierarchy, density, and action placement, not different palettes.
- Choose the composition that serves the task. Reuse established styles and known preferences; otherwise choose sensible defaults. Starter CSS is not design direction.
- Record the choice and rationale in `docs/design-intent.md` using `docs/reference/design-acceptance.md`. Record `sql-apps-design` as the design capability.

## Make the purpose visible

- Lead with the product's defining information and recurring action. Keep account, setup, and administration secondary.
- Use typography, spacing, color, and layout to reinforce that hierarchy, not a default dashboard or universal theme.
- Give each surface one clear primary action; keep secondary and destructive actions distinct.
- Make empty, single-record, and populated states intentional compositions, not leftovers from a fixed grid.
- Support narrow screens, readable line lengths, wrapping long content, contrast, visible keyboard focus, semantic structure and accessible labels.
- Show truthful signed-out, authorized, no-access, loading, empty, error, saving, success and disabled states. Keep test-persona selection off product screens; status uses text or iconography, never color alone.

## Review and improve

Verify the intended origin. Inspect rendered primary and reachable states at desktop and narrow widths. Judge task priority, readability, density, and product character, not merely whether content fits. Source review and compilation are not visual review.

Fix observed problems and re-review. Record direct observations and blocked checks in `docs/design-review.md` using the same acceptance contract. Run `sql-apps check` and report its design acceptance count.

`sql-apps-application` remains authoritative for behavior and permissions; `sql-apps-validation` owns functional evidence. Visual approval does not authorize schema, identity, data, or startup changes.
