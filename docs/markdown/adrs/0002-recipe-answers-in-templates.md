# ADR 0002: Recipe answers in the template scope

**Status:** Accepted, 2026-09-13.

This record amends [ADR 0001](0001-repositories.md). It records only the delta from that design:
one piece of it that was designed but not built, the decisions made while building it, and two
corrections to what 0001 describes. Everything 0001 says otherwise stands. The living answer to
"how does it work right now?" is [Recipe Variables](../repositories-variables.md), and the process
record is [gh-45](https://github.com/sous-io/sous/issues/45) under
[gh-4](https://github.com/sous-io/sous/issues/4).

## Context

ADR 0001 gave recipes published variable definitions, gave projects two env files to hold the
answers, and gave sous a five-rung ladder to find them, so that a recipe's own templates could
render what the project answered. The answer side was built in full: definitions, the ladder, the
env-file writer, `sous vars ask`, and the questions a subscription asks. The build side was not.
The scope a template renders with was assembled from the auto-injected variables, the config's
`_env` block and its `_vars` block only, so a recipe's `{{ variable }}` rendered as an empty string
unless the project mapped that one variable by hand through `_env`. The gh-4 task file recorded
this as a known gap, and the variables documentation carried the workaround as an instruction.

That left the env files answering questions nothing read. This project's own configuration
carried every recipe answer in `_vars` for the same reason.

## Decision

### The build lays the answers into the scope

- For every variable definition a project's locked recipes publish, the build walks the ladder and
  lays the first answer it finds into the render scope under the definition's name. This happens
  wherever the root scope is assembled, so every command that resolves the scope (build, compile,
  watch, launch, validation, the inspection commands) sees the same values, and `${name}` works in
  `_vars` as well as `{{ name }}` in a template.
- **Precedence:** the auto-injected `sous*` variables, then the recipe answers, then `_env`, then
  `_vars`. An explicit config value always wins. A project that already carried its answers in
  `_vars`, or mapped them through `_env`, renders exactly what it did before; the stored answer is
  shadowed, not overwritten.
- A definition's `default` is the answer of last resort. The description a publisher writes says
  what the default does, and a template rendering an empty string instead would break that promise.
- Answers are laid in as stored. No path is resolved and no number is coerced at this point; the
  value is the string the user stored, the same string an `_env` mapping delivers. Changing the
  meaning of an answer by its declared type is a separate decision, not taken here.

### Two views of the answers

- The project's own templates render a merged view: one value per variable name. Two recipes may
  publish the same name (the shared rung exists for exactly that), and the first definition in
  lockfile order wins the merged view.
- A recipe's own compile targets render the merged view with that recipe's own answers laid over
  it, so the recipe-scoped rung can give one recipe a different answer without touching the other,
  and a recipe still sees the answers of the recipes it depends on, whose partials it may include.

### An unanswered required variable is reported, never fatal

- A required definition with no answer on any rung and no default is named in one warning before
  the build compiles, with the recipe that asks for it and `sous vars ask` as the way to answer. The
  build succeeds and the template renders an empty value. A missing answer is something to tell the
  user about, and a fresh clone must build; refusing would turn every unanswered local-scope
  question into a broken checkout. `--strict` does not change this, since it governs the compiler's
  own failures.
- A variable the project's config defines itself, in `_vars` or through `_env`, is not missing, so
  the warning is checked against the scope the templates actually render with.

### A rendered output depends on its variables

- The source hash that lets an unchanged output skip its write covered the assembled source only,
  so a changed answer, or a changed `_vars` value, with the same template left stale output in place
  until `--rebuild`. A `.tpl.` output's hash now covers its variable scope too. Verbatim copies are
  unaffected. Every rendered output re-renders once after the upgrade.

### The shell layer of the ladder at build time

- The build hands the ladder no pre-injection snapshot of the shell; it reads `process.env` at call
  time. The env files are loaded first-writer-wins in precedence order, so `process.env` already
  holds the right value for every name. The snapshot buys only the attribution of an answer to a
  layer, which `sous vars` reports and a build does not.

### Corrections to ADR 0001

- 0001 names the machine-written layers `500-repos.json`, `510-subscriptions.json` and
  `520-var-mappings.json`. They are `.jsonc`, with a header comment, edited by key so comments and
  formatting survive; the `.json` spelling is read as a fallback and migrated on the first write.
- 0001's context says sous compiled from the CLI's own `shared-prompts/` directory. That directory
  is gone; everything it held is published as recipes in the official repository.

## Consequences

- A recipe author writes `{{ variable }}` and it renders; the `_env` bridge is no longer part of
  consuming a recipe, and stays the way to reach an environment variable no recipe asks about.
- This repository's own answers moved out of `.sous/sous.config.js` into `.sous/.env` (shared
  scope, committed) and `.sous/.env.local` (local scope, ignored). Path-typed answers stored
  relative to the project root render relative, where the config used to render absolute paths.
- Every rendered output re-renders once after upgrading, because its source hash changed shape.
- Resolving a project's scope now reads the lockfile and each locked recipe's manifest. A build
  does so once and hands the result to every scope it assembles.
