# @sous-io/plugin-compiler

Compiling templates, includes, aliases, compilation settings, the built-in tags and filters, the state file, writing outputs, pruning.

- **Specified in:** S6, "Compiler: plugin-compiler".
- **Capabilities (S7):** C6, C58; the transforms skill targets name (C42); the built-in tags and
  filter as `liquid-tag`/`liquid-filter` entities (C36); the `compilation` and `_aliases` keys with
  their schema defaults (C4, C71).
- **Depends on:** `plugin-liquid`, `plugin-refs`, `plugin-variables`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-compiler/types";`.

## What it does

- `compiler.compile` (internal) expands every target in `compilation.targets` (an `entryPoint`, an
  `entryGlob`, or a `content` template string with an `id`), resolves include lines and
  `{% render %}` paths (`@`, `~`, `#`, aliases, globs, `${var}`), renders `.tpl.` files and `content`
  as Liquid, applies `compilation-transform` entities, and writes every output through
  `compiler.writer`. Errors are listed in the result, never thrown, so every target compiles.
- `compiler.writer` is the one way a build output is written. A file sous did not write is
  overwritten and taken over, unless `compilation.overwriteUntracked` is `false` (C58).
- `compiler.state` reads the state file (`_vars.stateFilePath`, else `compilation.stateFile`, default
  `${sousDir}/sous.state.json`): every file written, with its target and origin (`filesFrom`).
- `compiler.prune` (internal) removes outputs no target produces any more, or, with `all`, every
  output and the state file. Linked checkouts and the recipe store are never touched. A file a plugin
  wrote through the writer itself (no target, an `origin.plugin`) is left by a prune.
