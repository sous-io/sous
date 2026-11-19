## How Sous Is Built

Sous is a small engine plus plugins. The engine (`packages/sous-lib-core`) only builds the config and runs
plugins; everything a user sees (commands, recipes, templates, compiling, updating) is a plugin that
registers config contributors, intents, services, entities and event listeners. A built-in plugin
and a plugin a user installs use the same interface.

The repository is a pnpm workspace. Every package is in `packages/`; run `ls packages` for the list.

- `packages/sous-plugin-api`: the plugin interface (`definePlugin`, the types, the error classes). The
  only package outside plugins depend on, and published on its own. Never put engine code here.
- `packages/sous-lib-core`: the engine. It knows no plugin by name.
- `packages/sous-lib-documents`: surgical JSON, JSONC and YAML editing, used by core and by plugins that edit
  config files.
- `packages/sous-plugin-cli`: the command line, generated from the intents plugins register.
  `packages/sous-plugin-mcp` does the same for an MCP server.
- `packages/sous-plugin-<name>`: one plugin per concern (recipes, compiler, build, variables, and so on).
  A plugin's `src/types.ts` is its contract: what other plugins may call. Other plugins import it
  type-only (`import type {} from "@sous-io/sous-plugin-<name>/types"`).
- `packages/sous`: the published `@sous-io/sous`. It lists the built-in plugins in
  `src/built-ins.ts`, starts the engine with them and hands the command line to the CLI. Its bundle
  (`packages/sous/dist`) is what ships.
- `packages/sous-lib-repository-hosts`: code shared by the GitHub, GitLab and local host plugins.

Rules for working here:

- Read `docs/markdown/architecture/laws.md` before changing anything. The architecture documents in
  `docs/markdown/architecture/` (goals, the specifications in `specifications/`) are the source of
  truth for how sous is built; where an older document, ADR or issue disagrees, they win.
- A plugin talks to another plugin only through that plugin's `types.ts`, never by importing its
  source. Core and sous-plugin-api never name a plugin.
- A new command is a new intent in a plugin, not code in the CLI.
- Changes to old tests are recorded in `docs/markdown/architecture/test-changes.md`.
- A significant change updates every document that describes the behavior, in the same change:
  `docs/markdown/`, the core skills in `recipes/core/sous-skills/`, help text and examples, and the
  specifications. Search for them while planning the change; never leave them for later, and never
  offer the user a later change for them. The user, 2026-11-15: "when we make any significant
  change to shit like this, we will find and update the associated documentation, immediately.
  Why would fucking wait, ever?"

## Build, Run and Test

```bash
pnpm install
./bin/sous <command>      # runs sous from this checkout; rebuilds the bundle first when sources changed
pnpm build                # build sous-plugin-api, then the sous bundle
pnpm typecheck            # tsc --noEmit in every package
pnpm test                 # every package's tests (vitest)
pnpm --filter @sous-io/sous-plugin-<name> test            # one package
pnpm --filter @sous-io/sous-plugin-<name> exec vitest run <file>   # one file
pnpm sous:build           # sous builds this repository's own agent files (this file included)
```

Unit tests sit beside the code as `src/**/*.spec.ts`; tests that run several modules together are
in a package's `test/` directory. Requires Node 22 or later; TypeScript is strict ESM.

## Documentation

- `docs/markdown/`: the sous.io website pages, for users of sous. The `about-sous-documentation`
  skill says how to write them. `.sous/prompts/docs-site/CLAUDE.tpl.md` is the source of
  `docs/CLAUDE.md`.
- `docs/markdown/architecture/`: the architecture documents, for people changing sous.
- Each package has a `README.md` saying what it does, how to use it from code, where things are
  and how to test it. Keep them short and point at the code for details, so they do not go stale.

## Publishing

Published as `@sous-io/sous` (npm org `sous-io`), public, Apache-2.0. `packages/sous/package.json`
has the `files` list of what ships.
