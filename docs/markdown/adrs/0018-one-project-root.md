# ADR 0018: One project root, which sous sets

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The details are in
[Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) (its section on the
published package, `sous`), with the one-project-per-process rule in
[the engine specification](../architecture/specifications/S1-engine.md). Where this record and those
files disagree, they win. It amends [ADR 0002](0002-recipe-answers-in-templates.md), which left
path answers waiting on a declared project root.

## Context

Before 1.0, sous has no formal project root. `projectRoot` is only a convention: a config writes
`projectRoot: "${sousDir}/.."` into `_vars` by hand, and `sous init` writes it too. Several other
places in the code work the root out on their own, and they can disagree.

## Decision

- **The project root is the directory that holds the `.sous/` directory the config file was found
  in.** When `--config` names a file outside any `.sous/`, the root is the parent of the directory
  holding that file, as `sousDir` is already defined. A project cannot put its root anywhere else.
- **Sous sets `projectRoot` itself**, as one of the variables it fills in automatically, so every
  existing `${projectRoot}` and `{{ projectRoot }}` keeps working with nothing written in the
  config.
- **Setting `projectRoot` in any `_vars` is an error** saying that sous sets it.
- **Every sous process serves exactly one project**, the one found from its working directory, for
  its whole life. This holds for a CLI run, for watch mode and for `sous mcp`.
- **Plugins read the project's paths from the engine** (`ctx.project`), never from
  `process.cwd()`.

## Consequences

- A config or recipe config layer that still sets `projectRoot` fails to load until the line is
  removed. `sous init` no longer writes it.
- The separate ways of finding the root are removed.
- An agent session started at a monorepo's root uses the root's sous, even while the agent edits a
  subfolder that has its own `.sous/`.
