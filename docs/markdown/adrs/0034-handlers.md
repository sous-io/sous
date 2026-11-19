# ADR 0034: Handlers

**Status:** Accepted, 2026-11-18.

The living answer is [S13: Handlers](../architecture/specifications/S13-handlers.md) and the user page
[Handlers](../handlers.md).

## Context

A recipe's content often depends on commands that may not be installed. A knowledge worker recipe
needs `git` and `jq`, and its scripts also call `pandoc`, `curl` and `jira`; without `jq` its hooks fail
on every agent action, with errors that do not point at the cause. The first idea was a list of required
commands in the manifest (gh-144). Recipes and plugins also need somewhere to put work that is an action
rather than a standing state: cleaning up when they are removed, and bringing a project in line after a
new version.

## Decision

Manifests point at exported functions for purposes, and plugins register the same functions:

> "I think we can do better. We allow manifests to point to exported functions for different purposes.
> purpose+file+handler ... those handlers get access to every Sous tool we can provide, including tools
> that check for commands in the path. Most or all 'purposes' should be able to point to multiple
> handlers that run in a predictable order."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

- Six purposes, fixed for now: `check`, `configure`, `beforeBuild`, `afterBuild`, `uninstall` and
  `migrate`. Each takes a list, run in a predictable order.
- A recipe lists `handlers` in its manifest, each a self-contained JavaScript file in the recipe and an
  exported function, run only from a trusted repository. A plugin calls
  `sous.handlers.add(purpose, { id, handle })` in `register`.
- A handler receives the full context a plugin receives, plus helpers with fixed names
  (`sous.report`, `sous.utils.system.isAppAvailable`, `sous.utils.file.*`, ...).
- A `check` error fails the build before anything is written, unless the person passes
  `--ignore-failed-checks`: "error fails by default, but users can push through it if they dare."
- `migrate` runs after a recipe moves to a new version, given `{ from, to }`: "we'll run it after a new
  version of the recipe is installed." Sous stores no history for it.
- `uninstall` runs only when a recipe is removed through sous.
- One built-in plugin owns all of it: `@sous-io/sous-plugin-handlers`. A manifest's handlers become
  config values (`recipes.handlers`) first, then `handler` entities (law L8).

## Consequences

- gh-144's "a missing command warns; it does not fail the build" no longer holds: the author picks the
  level.
- Every handler is timed under its id, so a slow or failing one is named.
- The plugin API grows one call, `sous.handlers.add`, and one type registry, `SousHandlerTypes`.
- Plugins installed from npm get no `migrate` call yet; adding one would need sous to remember which
  version of each plugin it loaded last.

Rejected: a list of required commands in the manifest; a handler receiving only the helpers (it would
limit what a recipe's code can do); only the full context with no helpers; attaching recipes' and plugins'
migrations to sous's own migration step.
