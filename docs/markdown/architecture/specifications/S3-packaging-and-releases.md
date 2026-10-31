# S3: Packaging and Releases

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G5 (boundaries obvious and enforceable), G7 (our tools use any combination of parts; the
plugin interface is the only outside promise), G8 (features for one agent tool are additions), G9
(very fast).

## What This Specifies

How the code is split into packages, what is published to npm, how versions work, and how breaking
changes are handled.

## The Refactor Happens in One Sweep

The refactor is done in one sweep, not one concern at a time. It ships as sous 1.0.0.

## A pnpm Monorepo

Sous becomes a pnpm workspace. Each concern gets its own package, created as part of moving that
concern into its owner. Four packages are not plugins; every other package is a built-in plugin
(see S6, concerns and owners):

```text
packages/
    core/                     the engine
    documents/                surgical JSON, JSONC and YAML editing; the config builder is built on it
    plugin-api/               the plugin interface (see "The Plugin Interface")
    sous/                     the published package: the bin, the built-in plugin list, the bundle
    plugin-<concern>/         one package per built-in plugin
```

S6 (concerns and owners), section "Packages", lists every package and what it holds.

A built-in plugin reaches another only through the engine: services, intents, events and entities,
looked up by name. At compile time it may import another plugin's types, and nothing else:

```ts
// Allowed: a type-only import of another plugin's published types.
import type {} from "@sous-io/plugin-compiler/types";

// Rejected: another package's code. The package's "exports" map lists only "." and "./types",
// so this fails to resolve.
import { StateFile } from "@sous-io/plugin-compiler/src/state-file.js";
```

Every package is kept, one per concern, even when it is small (ruled 2026-10-25).

## What Users Install

Users install one package, `@sous-io/sous`, which provides the `sous` command, as before the
refactor. The project-install hand-off keeps looking for `@sous-io/sous`.

## The MCP Server and the Claude Code Plugin

- The MCP server is part of the CLI: a `sous mcp` command in `@sous-io/sous`. It works for every agent
  tool that speaks MCP.
- The Sous-provided Claude Code plugin is its own thing. It stays thin and defers to the installed
  `sous`, with a project-level install taking precedence over a global one.

Decided for the plugin:

1. The plugin starts the server with `npx sous mcp`. When sous is installed in the project or
   globally, `npx` finds it and starts it quickly. When it is not, `npx` downloads sous, a one-time
   delay that is acceptable; with nothing installed there is no pinned version to conflict with. The
   docs recommend installing sous, and mention `--no` for users who want `npx` never to download.

    ```json
    {
        "mcpServers": {
            "sous": {
                "command": "npx",
                "args": ["sous", "mcp"]
            }
        }
    }
    ```

2. The plugin's hooks call tools on the running MCP server (`"type": "mcp_tool"`) instead of
   starting the CLI on every event, so they never pay the CLI's start-up time (G9, very fast), and
   each hook is one call into sous. Every hook's behavior exists as an MCP tool, built on the same services the
   CLI uses (L3, services never print, prompt or exit).

    ```json
    {
        "hooks": {
            "PostToolUse": [
                {
                    "type": "mcp_tool",
                    "server": "plugin:sous:sous",
                    "tool": "sous_build"
                }
            ]
        }
    }
    ```

3. The plugin declares the oldest sous it supports. `sous mcp` reports its version when the plugin
   connects, and the plugin shows a plain message when the project's sous is older:

    ```text
    Sous plugin: this project's sous is 1.1.0; the plugin needs 1.3.0 or newer.
    Update it with:  npm install -D @sous-io/sous@^1.3.0
    ```

## Bundling

- `core` and every built-in plugin are private and bundled into `@sous-io/sous` when it is
  published. `@sous-io/plugin-api` stays outside the bundle (see "The bundler"). Sous publishes
  compiled JavaScript, whatever language its source is written in.
- The list of bundled packages does not change within a major version.
- An internal package may also be published on its own at any time, without a major version, for
  example for a new first-party app. It stays in the bundle too.

```text
@sous-io/sous 2.4.0              bundles @sous-io/plugin-compiler     (always, through 2.x)
@sous-io/plugin-compiler 2.4.0   also on npm, for a first-party app   (added in 2.4)
```

### The bundler

Ruled 2026-10-25: esbuild bundles the published package, and `tsc` writes the `.d.ts` type files
`@sous-io/plugin-api` publishes. Plugins must share sous's copy of `@sous-io/plugin-api`, so it stays
outside the bundle. `tsc --noEmit` checks types in CI, since esbuild strips types without checking
them.

```js
// scripts/bundle.mjs
await esbuild.build({
    entryPoints: ["packages/sous/src/bin.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: "packages/sous/dist/bin.js",
    external: ["@sous-io/plugin-api"],
    splitting: false,
});
```

## Versions

Every published package shares one version, the version of `@sous-io/sous`. A package is republished
at that version even when it did not change.

## The Plugin Interface

The plugin interface is its own published package, `@sous-io/plugin-api`. It holds `definePlugin`,
the empty interfaces every plugin adds its own types to (`SousServices`, `SousIntents`,
`SousEvents`, `SousEntities`), the `Reporter` and `Prompter` interfaces, and the error classes. Each
plugin declares the types of its own services, intents, events and entities in its own package
(see S6, concerns and owners). A plugin depends on it, and declares `@sous-io/sous` as a peer
dependency, so the package manager warns when the project's sous is older than the plugin expects:

```jsonc
{
    "name": "sous-plugin-diagrams",
    "dependencies": {
        "@sous-io/plugin-api": "^2.3.0"
    },
    "peerDependencies": {
        "@sous-io/sous": "^2.3.0"
    }
}
```

Sous passes everything a plugin uses into `register(sous)` and each `ctx`, so a plugin imports only
types and `definePlugin` from `@sous-io/plugin-api`. A second copy of that package in a project then
does no harm (suggested by an agent).

## Breaking Changes

- Before 1.0.0, breaking changes are allowed freely, with no migration guide.
- From 1.0.0, a breaking change to `@sous-io/plugin-api` requires a major version of sous.

## The Source Is TypeScript

Ruled 2026-10-29: sous's source stays TypeScript. Plugins see each other's services, intents, events
and entities with full types through TypeScript declaration merging (see S1, the engine), which
would otherwise mean writing `.d.ts` files by hand. The bundler compiles it ahead of time, so users run plain JavaScript,
and plugin authors may write their plugins in either language.

## Open Questions

1. How the published package exposes its entry points.

## Changes

None yet.
