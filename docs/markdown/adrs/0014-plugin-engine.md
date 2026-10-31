# ADR 0014: A small engine, and everything else a plugin

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The details are in
[the engine specification](../architecture/specifications/S1-engine.md), with what each plugin owns
in [Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) and the package
layout in [Packaging and Releases](../architecture/specifications/S3-packaging-and-releases.md).
Where this record and those files disagree, they win. It amends [ADR 0001](0001-repositories.md)
(repository providers), [ADR 0011](0011-self-update.md) (package managers) and
[ADR 0013](0013-one-ref-resolver.md) (how the ref services are wired together), as the notes at the
top of those records say.

## Context

Before 1.0, sous is one TypeScript program, compiled by tsx on every run. Several things are
implemented twice (the `${var}` substitution and the way the project root is found, for example),
and features import each other in cycles.

Nothing outside the package can extend sous: the Liquid tags and filters, the repository
providers, the agent tools and the package managers are fixed in the code. And it is slow:
`sous --help` took about a second, mostly from compiling TypeScript and importing every command.

The maintainer wanted a plugin system, with the CLI and the MCP server as plugins too:

> "if the CLI and MCP can be plugins, I'd prefer that, too."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

> "we want versatility... always...."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

## Decision

- **Core is the engine only.** It loads plugins, builds the config, runs the operations users and
  plugins ask for, passes events between plugins, and holds shared services and the things sous
  knows about. It also stops and reports loops (plugins that keep undoing each other, or an
  operation that keeps calling itself) and warns when a step goes over its time budget.
- **A plugin extends sous only through five kinds of things the engine knows**:
  - a **contributor**, code that adds to the config while it is built
    ([ADR 0015](0015-config-from-contributors.md));
  - an **intent**, one named operation a user or plugin asks for, such as a build
    ([ADR 0016](0016-intents-and-front-ends.md));
  - an **event**, a notice any plugin may send or listen for;
  - a **service**, a shared object that does work, such as the git runner;
  - an **entity**, a described thing sous knows about, of a kind some plugin defines, such as an
    agent tool sous can launch or a repository host.
- **Everything else is a plugin**, including the CLI and the MCP server. Built-in plugins load
  unless the config disables them. Support for Claude Code is built in; every other agent tool is a
  plugin installed separately.
- **Every concern has exactly one owner**, and other code asks that owner. No old code path is kept
  beside its new owner.
- **Plugins reach each other only through the engine**, by name. A plugin may import another
  plugin's types and nothing else, and declares the plugins it needs, with version ranges; sous
  stops with a message when one is missing.
- **The plugins to load are an ordinary config key**, `plugins`, read while the config is built.
  There is no separate bootstrap config and no separate discovery step.
- **Services never print, prompt or exit.** They report and ask through objects the front end that
  started the operation supplies, so the same code works in the CLI, over MCP or in a GUI.
- **The code becomes a pnpm monorepo**, one package per concern, bundled into the one published
  package, `@sous-io/sous`, which ships compiled JavaScript. The plugin interface,
  `@sous-io/plugin-api`, is published on its own and is the only interface sous promises to keep
  stable for code outside the monorepo.
- **Sous ships this as 1.0.0.** From then on, a breaking change to `@sous-io/plugin-api` needs a
  new major version.

## Consequences

- A plugin from npm, or one a recipe ships ([ADR 0017](0017-recipes-ship-plugins.md)), can add a
  command, a Liquid tag or filter, a repository host, an agent tool or a config key, and can wrap
  or replace any service.
- `sous plugins show` lists every plugin and what it added, wrapped or replaced; `--timings` shows
  how long each step of a run took.
- Two plugins replacing the same service is an error unless the config picks one, and sous then
  warns on every run.
- Tests can run many engines in one process, since no project state lives in module-level
  variables.
- The refactor is done in one sweep, removing the duplicate implementations and import cycles that
  [Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) lists.
