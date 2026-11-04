# ADR 0023: The project's lockfile is the only lock

**Status:** Accepted, 2026-11-04.

This record supersedes the part of [ADR 0007](0007-frozen-index-dependencies.md) that makes a published
version's recorded dependency versions exact for every consumer. The rest of ADR 0007 stands: a published
entry is still frozen, and readers still keep fields they do not know. The process record is
[gh-220](https://github.com/sous-io/sous/issues/220).

## Context

A release records each dependency's exact version in `sous.index.json`, and the resolver asks for that
version instead of the range the manifest declares. ADR 0007 states the intent:

> "A consumer installing this version installs these versions rather than re-resolving the ranges its
> manifest declared, so a published version means one thing forever."
>
>   -- `indexVersionSchema`, doc comment on `dependencies`, quoted in ADR 0007

That makes the index a lockfile every subscriber inherits. Two recipes from one repository then conflict
whenever a shared recipe was released between their two releases, even when their declared ranges agree.
In gh-220, `omakase/house` 1.0.1 recorded `workflow/sub-agent-delegation` 1.1.1 and
`workflow/github-projects` 1.1.3 recorded 1.1.2, although every declared range allowed 1.1.2, so
`sous subscription update sous-recipes` refused to move `github-projects` at all. Package managers avoid
this: npm and Cargo ignore a dependency's own lockfile, and only the consuming project's lockfile pins.

A sibling named with no range had been read as "exactly the version released alongside me". No decision
record or ruling stood behind that reading; it was written while documenting gh-4.

The user ruled on each part below, in an agent session on 2026-11-04, walking the decisions one at a time.

## Decision

1. **No range means the same major.** A dependency the manifest names with no range means
   `^<that recipe's version at release>`. Ruling: "1", choosing "No range means `^<the sibling's version
   at release>`".
2. **The index records ranges.** A release records a range for each dependency (the declared range, or
   the one from rule 1) and no exact version. The project's lockfile is the only lock. A recipe that
   needs certainty declares a tighter range, or an exact one, in its manifest. Ruling: "1", choosing "The
   index records a range per dependency, and the project's lockfile is the only lock."
3. **Published exact versions are read as ranges.** A dependency entry that carries `version` was
   written before this record. It is read as `^<version>`, further limited by the range in its `declared`
   entry when there is one. Nothing is republished. Ruling: "1".
4. **A depends-only recipe may be pinned per holder.** A recipe every holder reaches through `depends`
   adds no files to the project, so two versions of it cannot collide. When no single version fits
   every holder, the lockfile pins it once per holder that does not fit, and that holder's includes and
   answers use its own pin. The store already keeps each version apart. Ruling: "1".
5. **Choosing a version several holders share.** For each recipe, every holder's range is collected.
   The version the lockfile pins is kept while it satisfies them all; `sous subscription update` instead
   takes the newest version that satisfies them all. A recipe some holder reaches through `subscribes`
   has exactly one version in the project, and each `depends` holder whose range allows that version
   shares it. A `depends` holder that does not fit the shared version gets its own pin, the newest its
   range allows; holders are not grouped to save downloads. Two `subscribes` holders that no version
   satisfies are reported as a conflict, naming each holder and its range. Ruling: "2", choosing the rule
   without grouping.
6. **Two definitions of one variable are combined.** When several recipes, or several versions of one
   recipe, define a variable of the same name, sous asks one question built from the strictest
   combination: secret if any is secret, `local` if any is local, required if any is required, and only
   the values every definition accepts (the shared `enum` options, the highest `min`, the lowest `max`,
   every `pattern`). A default is kept only when it passes the combination; the prompt and description
   are the first definition's, naming the other recipes. When no value can pass (different types, no
   shared `enum` option), each recipe is asked separately on its recipe-scoped name
   (`SOUS_VAR_<NAMESPACE>_<RECIPE>_<VARIABLE>`), and sous says why. A recipe that only reads another
   recipe's variable, through `depends`, is not a second definition. Ruling: "1".

Two details were filled in by the agent and are not rulings: an entry counts as written before this
record exactly when its dependency carries `version`, and a `depends` holder pinned on its own takes the
newest version its own range allows. (Agent suggestion; the user has not ruled on them.)

## Consequences

- `sous subscription update <repository>` and `sous subscription update <recipe>` reach the same answer
  for gh-220's case: `github-projects` 1.1.3 and `sub-agent-delegation` 1.1.2.
- A recipe can run with dependency versions it was never released against, inside the ranges it
  declared. That is the ordinary semver contract, and the project's lockfile keeps every build
  reproducible.
- The lockfile format gains per-holder pins for depends-only recipes, and include resolution and
  answers follow the holder's pin.
- A bundle such as `omakase/house` no longer needs a release every time a recipe it names releases.
- An older sous reading an index written under this record finds dependencies with `range` and no
  `version`, which its schema already accepts, and resolves those ranges.
