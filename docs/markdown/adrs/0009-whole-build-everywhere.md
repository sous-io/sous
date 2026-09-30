# ADR 0009: One whole build, everywhere

**Status:** Accepted, 2026-09-29.

This record amends [ADR 0001](0001-repositories.md) in one place: what a project's own templates may
address through the `~` sigil. It also records two decisions about the build itself that no earlier
record covers: which commands prepare a project's recipes before compiling, and what a compile error
does to a build. The living answers are the `sous build` entry and "Exit behavior and error shape" in
the [command reference](../commands.md), and
[Including recipe files in your own templates](../repositories.md#including-recipe-files-in-your-own-templates).
The process records are [gh-125](https://github.com/sous-io/sous/issues/125),
[gh-126](https://github.com/sous-io/sous/issues/126) and
[gh-127](https://github.com/sous-io/sous/issues/127).

## Context

Three problems surfaced together while this repository was switched to subscribe to the
`omakase/house` set instead of the recipes the set covers (sous-io/sous-recipes#12).

- **Only two commands prepared the recipes.** `sous build` and `sous init` seeded the core recipe,
  locked new subscriptions, restored the store and checked upstream before compiling. `launch`,
  `prune`, `repo remove`, `repo unlink`, `subscription add`, `subscription remove` and
  `subscription update` compiled (or pruned) without that step, so a pinned recipe missing from the
  store was silently left out of their output.
- **A project template could include only from its direct subscriptions.** A set's members are
  pinned and active through the set's `subscribes`, but the project does not subscribe to them
  itself, so every `@~` include of a member's file from this repository's root instructions failed:
  12 errors across six recipes.
- **Those errors did not fail the build.** A failed include left an empty line, the output was
  written anyway, and the build exited `0`. `--strict` was the only way to fail, and it exited the
  process in the middle of the build, before the other targets compiled and before the state file
  was saved.

The user approved each plan in an agent session on 2026-09-29. For gh-125:

> "it works, next"
>
>   -- **the user** in an agent session (2026-09-29; recorded in gh-125, "Decision")

For gh-126 and gh-127, each time choosing option 1 of the plan the issue records:

> "1"
>
>   -- **the user** in an agent session (2026-09-29; recorded in gh-126 and gh-127, "Decision")

## Decision

- **One build path.** Every command that builds (`build`, `init`, `launch`, `prune`, `repo remove`,
  `repo unlink`, `subscription add`, `subscription remove`, `subscription update`) runs one function,
  `runProjectBuild` (`src/lib/build-service.ts`). It announces linked repositories, prepares the
  recipes (seed, lock, restore, upstream check, newer-version report) and then compiles and prunes,
  so every command prints what `sous build` prints. `prune` runs it with the compile step off,
  because what counts as current depends on the recipes the lockfile pins. A dry run prepares
  nothing, because preparing writes the lockfile and the store, and neither does a partial rebuild
  in watch mode, whose config did not change.
- **A project template may include from any recipe the lockfile pins**, whatever holds it: the
  project, a set's `subscribes`, or another recipe's `depends`. Including a library's file adds
  nothing the library registers itself, so a `depends`-only recipe still contributes no targets,
  config, tags or hooks of its own. Includes from inside a recipe keep ADR 0001's rule: only that
  recipe's own `depends` and `subscribes`.
- **An include of a recipe the lockfile does not pin names what used to bring it in**, when that can
  be read without the network: a switched-off subscription to it or its namespace, or another
  published version of a pinned recipe that declared it, directly or through recipes that are no
  longer pinned either, read from the cached indexes.
- **Any compile error fails the build.** A missing or circular include, a template that fails to
  render, or a file sous cannot read is recorded; every target is still compiled and every error
  listed; an output whose target had an error is not written, so its previous copy and its state
  entry stay; and the build exits `1`, from `sous build`, `sous compile` and every command on the
  shared path. `launch` does not start the tool after a failed build.
- **`--strict` turns compile warnings into errors, and nothing else.** The warnings are a `.tpl.`
  source copied without being rendered and a git branch the runtime context could not read. Nothing
  in the compiler calls `process.exit`, so watch mode reports a failed rebuild and keeps watching.

## Consequences

- A project's output is the same whichever building command produced it, and a fresh clone is
  restored by any of them.
- `sous build --no-compile` now prepares the recipes before it prunes, where it used to skip that
  step.
- CI and scripts can rely on the exit code: a build that exits `0` compiled everything it was asked
  to. A project whose build used to finish with reported errors now fails until they are fixed.
- A project template can come to depend on a library it never asked for by name; if the set or
  recipe holding the library drops it, the build fails with an error naming what dropped it, and
  subscribing to the library directly brings it back.
- `src/test/integration/whole-build.test.ts` holds all three decisions end to end: each building
  command restoring a recipe missing from the store, a template including from a set member and a
  `depends`-only library, a set update that drops a member, and a failed build keeping the last good
  output.
