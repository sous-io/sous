# @sous-io/plugin-compiler

Compiling templates, includes, aliases, compilation settings, the built-in tags and filters, the state file, writing outputs, pruning.

- **Specified in:** S6, "Compiler: plugin-compiler".
- **Capabilities (S7):** C6, C58.
- **Depends on:** `plugin-liquid`, `plugin-refs`, `plugin-variables`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-compiler/types";`.
