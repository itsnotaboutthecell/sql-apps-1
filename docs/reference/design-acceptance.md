# Design acceptance

Functional acceptance and design acceptance are separate. `sql-apps check`
reports missing or incomplete design evidence when application UI differs from
the SQL Apps template.

## Design intent

Create `docs/design-intent.md` before implementing a new user-facing app or
meaningful UI change. Use these exact level-two headings:

```markdown
# Design Intent

## Audience
Who uses the interface.

## Primary recurring task
The action users perform most often.

## First-read information
What users must understand first.

## Composition A
- Hierarchy: ...
- Density: ...
- Primary action: ...

## Composition B
- Hierarchy: ...
- Density: ...
- Primary action: ...

## Selected composition
- Choice: Composition A.
- Why: ...

## Typography
...

## Palette
...

## Layout
...

## Responsive behavior
...

## Design capability
- Skill: sql-apps-design
```

The two compositions must differ in hierarchy and layout, not only in color or
type. `sql-apps-design` owns this pass in the app's existing stack; no companion
skill is required.

`sql-apps check` warns when customized UI has no intent. An intent that omits
required sections, either composition, comparison fields, selection rationale
or the capability record fails validation.

## Rendered review

Review in this order: **brief → composition choice → one representative
screen → render → critique → improve → re-render → remaining states.** The first
implementation is a candidate. Critique the screen that carries the primary
task at desktop and narrow widths before building out the whole state matrix,
while weak composition is still cheap to replace.

Create `docs/design-review.md` and record direct rendered observations:

```markdown
# Design Review

## Review target
- Origin: http://127.0.0.1:18080
- Source/build: commit or build fingerprint

## Matrix
| State | Desktop | Narrow |
| --- | --- | --- |
| signed-out | observed | observed |
| no-access | observed | observed |
| first-run | observed | observed |
| empty | observed | observed |
| single-record | observed | observed |
| populated | fixed+re-reviewed | observed |
| saving | observed | observed |
| error | blocked: service unavailable | observed |
| success | observed | observed |
| disabled | observed | observed |
| role: AppUser | observed | n/a: same presentation |

## Findings
- populated desktop: tightened summary spacing, then re-reviewed.

## Critique
- Representative screen: single-record, desktop + narrow, build abc123.
- First viewport: The record's identifying details lead; the header is compact.
- Defining information: Visible above the fold at both widths.
- Generic elements: Summary tiles and a marketing hero were removed.
- Remove or demote: Persistent status banner and a prominent Refresh button.
- Top changes: 1. Compact header; 2. Identity-first records; 3. Domain-led capture.

## Design quality
- Verdict: accepted
- Rationale: The primary task and its information lead; no material defects remain.
- Unresolved tradeoffs: none
```

Use only:

- `observed`
- `fixed+re-reviewed`
- `blocked: <reason>`
- `n/a: <reason>`
- an empty cell for work not yet reviewed

The role row must match `requiredRole` in `role-based-data.json`. Add rows for
other role-differentiated views the app defines. `sql-apps check` reports the
number of required desktop and narrow cells that remain unreviewed and rejects
unsupported status text. Record the reviewed origin, source/build, findings and
re-review result in the same artifact. Blocked and `n/a` cells are explicit
evidence, not claims that a state was observed.

## Coverage versus quality

The matrix is **rendered coverage**: it shows which states and widths were
inspected. It is not a design verdict; "22 cells reviewed" says nothing about
whether the design is good. **Design quality** is a separate judgment of
hierarchy, task fit, density and product character against the brief.

The `Critique` section must be tied to an actual render. Each item records a
visible problem, its task consequence and a concrete change; avoid findings
such as "more polish" or "add personality". List at most three ranked changes
per iteration, apply them in one batch, and re-render affected views. Further
passes follow unresolved findings rather than a fixed loop count. After the
composition stabilizes, complete broad state coverage.

`Design quality` accepts one verdict:

- `accepted` — requires every `Critique` field plus a `Rationale`. Use it only
  when the primary task and information lead, the composition demonstrably
  serves this domain, and no material visual or usability defects remain.
  Record any remaining tradeoff under `Unresolved tradeoffs`.
- `revise: <finding>` — material shortcomings remain.
- `blocked: <reason>` — quality could not be judged from a real render.

`sql-apps check` prints three lines:

```text
Rendered coverage: complete (22 reviewed cells).
Design quality: accepted.
Design acceptance: accepted.
```

Design acceptance requires design intent, complete coverage and an accepted
quality verdict. A complete matrix without a quality verdict reports
`Design acceptance: partial: design quality not judged`.

## Final report

Report four separate verdicts:

1. **Implemented/built:** exact build and source evidence.
2. **Running:** intended origin and readiness evidence.
3. **Functional acceptance:** accepted, partial or blocked, with exact checks.
4. **Design acceptance:** accepted, partial or blocked, citing
   `docs/design-review.md` and stating rendered coverage and design quality
   separately.

Do not substitute one verdict for another.
