# ADR 0014: A small engine, and everything else a plugin

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The source of truth is
[S1: The Engine](../architecture/specifications/S1-engine.md), with the plugin list in
[S6: Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) and the package
layout in [S3: Packaging and Releases](../architecture/specifications/S3-packaging-and-releases.md).
Where this record and those files disagree, they win. It amends ADR 0001 (providers), ADR 0013 (the
ref services' container) and ADR 0011 (package managers), as their notes say.

## Context

Before 1.0, sous is one TypeScript program run through tsx. Its concerns are spread across
`src/lib/`, `src/services/` and `src/commands/`, with several concerns implemented twice (the
`${var}` substitution, the auto-variables list, the git runner, the project root) and import cycles
between features (vars and refs, repos and the compiler, config and the features above it). Nothing
outside the package can extend it: the Liquid tags and filters, the repository providers, the agent
tool defaults and the package managers are fixed lists. `--help` took about a second, mostly from
compiling TypeScript on every run and importing every command module.

The maintainer wanted a plugin system, with the CLI and MCP as plugins too:

> "if the CLI and MCP can be plugins, I'd prefer that, too."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

> "we want versatility... always...."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

## Decision

- **Core is the engine only.** It loads plugins, builds the config from contributors, schedules
  chains of intents, carries events, holds services with their lifetimes, and holds entities. It
  also finds loops and times everything against a budget.
- **The engine knows five kinds of things**: contributors (build the config, ADR 0015), intents (the
  steps a user or plugin asks for, ADR 0016), events (any plugin may fire or listen), services
  (shared objects that do work, each `singleton`, `config` or `factory`), and entities (things sous
  knows about, of a kind a plugin defines, such as `harness`, `skill-target` or `repository-host`).
- **Everything else is a plugin**, built in and loaded unless disabled: the CLI, MCP, config files,
  recipes, the compiler, skills, memories, harnesses, the repository hosts (GitHub, GitLab, local),
  the package managers (npm, pnpm, Yarn) and Claude Code. Codex and every other agent tool is a
  separately installed plugin.
- **Every concern has exactly one owner** (a service, an intent or an entity kind), and other code
  asks the owner. No old code path survives beside its new owner.
- **Plugins reach each other only through the engine**, by name. At compile time a plugin may
  import another plugin's types and nothing else; `dependsOn` declares what it needs, with version
  ranges, and sous stops with a message when a needed plugin is missing.
- **The plugins to load are an ordinary config key** (`plugins`: `discover`, `load`, `disabled`,
  `options`), read inside the config build. There is no bootstrap config, no `"sous"` key in
  `package.json` and no separate discovery step.
- **Services never print, prompt or exit.** They report through the chain's `Reporter` and ask
  through its `Prompter`, which the front end supplies.
- **The code becomes a pnpm monorepo**, one package per concern, bundled by esbuild into the one
  published package, `@sous-io/sous`, which ships compiled JavaScript. The plugin interface,
  `@sous-io/plugin-api`, is published on its own and is the only promise sous makes outside the
  monorepo.
- **Sous ships this as 1.0.0.** From then on, a breaking change to `@sous-io/plugin-api` needs a
  major version.

## Consequences

- A plugin from npm, or one a recipe ships (ADR 0017), can add a command, a Liquid tag or filter, a
  repository host, an agent tool, a config key, or wrap or replace any service.
- `sous plugins show` lists every plugin and everything it registered, wrapped or replaced, and
  `--timings` prints every timing of a run.
- Two plugins replacing the same service is an error, unless the config picks one
  (`services.replace."<name>"`); sous then warns on every run.
- Tests can run many engines in one process, since no project state lives in module-level
  variables.
- The refactor is done in one sweep, and the duplicate implementations and import cycles listed in
  S6 are removed with it.
