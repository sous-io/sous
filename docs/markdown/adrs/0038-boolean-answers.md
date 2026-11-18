# ADR 0038: A boolean recipe answer is a boolean in Liquid

**Status:** Accepted, 2026-11-18.

This record amends [ADR 0002](0002-recipe-answers-in-templates.md) for booleans. The design is in
[S12, Manifests as Config](../architecture/specifications/S12-manifests-as-config.md), section
"Booleans in Liquid". The issue is [gh-161](https://github.com/sous-io/sous/issues/161).

## Context

ADR 0002 decided:

> "Answers are laid in as stored. No path is resolved and no number is coerced at this point; the
> value is the string the user stored, the same string an `_env` mapping delivers."
>
>   -- ADR 0002, "Recipe answers in the template scope"

It never considered booleans. A variable of `type: boolean` answered `false`, or defaulting to
`false`, reached a template as the text `"false"`, and Liquid treats any text as true, so
`{% if jiraEnabled %}` took the true branch. Recipe authors worked around it with
`{% if x == true or x == "true" %}`. Now that a manifest's `contents` may hold conditions on
answers (ADR 0032), the same text reached config expressions too.

> "We should probably pull gh-161 into this body of work, too, assuming its just that narrow bug?"
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

## Decision

- A boolean's answer is given in one form, `"true"` or `"false"`, whatever word stored it (`yes`,
  `no`, `on`, `off`, `1`, `0`), and so is a default.
- A `variable-source` entity may name the variables it gives that are booleans (`booleans()`).
  The recipe-answers source names every boolean definition; `variables.booleans` collects them.
- Liquid sees a declared boolean as `true` or `false`: every engine plugin-liquid builds (so every
  template) and the config expression evaluator. `${name}` interpolation still gives the text.
- Only booleans change. Numbers stay text (the agent's choice; gh-161 left it open), and the
  commands that report a variable still show its stored text.

## Consequences

- `{% if flag %}` and `$if: flag` take the false branch for `false`.
- The workaround `x == true or x == "true"` keeps working.
- A template comparing a boolean to the text, `x == "true"` alone, now gives false: such a template
  must compare to `true`.
- The reports show `false`, the build renders `false` as a boolean: the same word, different
  types. gh-161's open question about the reports is answered only that far.
