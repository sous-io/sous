# ADR 0018: One project root, which sous sets

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The source of truth is
[S6: Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) ("The published
package: `sous`"), with the one-project-per-process rule in
[S1: The Engine](../architecture/specifications/S1-engine.md) ("The Shape"). Where this record and
those files disagree, they win. It amends [ADR 0002](0002-recipe-answers-in-templates.md), which
left path answers waiting on a declared project root.

## Context

Before 1.0, sous has no formal project root. `projectRoot` is a convention: a config writes
`projectRoot: "${sousDir}/.."` into `_vars` by hand, and `sous init`'s scaffold writes it too. Seven
other places in the code work the root out on their own (the `#project` name, recipe targets, the
project label, `launch`'s `process.cwd()` fallback, the state file's default, and the self-update's
project lookup), and they can disagree.

## Decision

- **The project root is the directory that holds the `.sous/` directory the config file was found
  in.** When `--config` names a file outside any `.sous/`, the root is the parent of the directory
  holding that file, as `sousDir` is defined today. A project cannot set its root anywhere else.
- **Sous publishes the root as the auto-variable `projectRoot`**, so every existing
  `${projectRoot}` and `{{ projectRoot }}` keeps working with nothing written in the config.
- **Setting `projectRoot` in any `_vars` is an error** saying that sous sets it.
- **Every sous process serves exactly one project**, the one found from its working directory, for
  its whole life; this holds for a CLI run, for watch mode and for `sous mcp`.
- **Every plugin reads the project through `ctx.project`** (`root`, `sousDir`, `configPath`,
  `confDir`), never through `process.cwd()`.

## Consequences

- A config or a recipe config layer that still sets `projectRoot` fails to load until the line is
  removed. `sous init` no longer writes it.
- The seven separate definitions of the root are removed.
- A session started at a monorepo's root gets the root's sous, even while the agent edits a
  subfolder that has its own `.sous/`.
