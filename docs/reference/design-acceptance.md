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
- Skill: frontend-design
```

The two compositions must differ in hierarchy and layout, not only in color or
type. If no maintained design capability is available, replace `Skill` with:

```markdown
- Manual fallback reason: No maintained frontend design skill was available in the host.
```

`sql-apps check` warns when customized UI has no intent. An intent that omits
required sections, either composition, comparison fields, selection rationale
or the capability/fallback record fails validation.

## Rendered review

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

## Final report

Report four separate verdicts:

1. **Implemented/built:** exact build and source evidence.
2. **Running:** intended origin and readiness evidence.
3. **Functional acceptance:** accepted, partial or blocked, with exact checks.
4. **Design acceptance:** accepted, `partial: N cells`, or blocked, citing
   `docs/design-review.md`.

Do not substitute one verdict for another.
