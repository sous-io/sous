# @sous-io/plugin-memories

Memories: selecting them, the memory-target entity, the compilation targets for them, the #memories name.

- **Specified in:** S6, "Memories: plugin-memories".
- **Capabilities (S7):** C43, C44.
- **Depends on:** `plugin-compiler`, `plugin-recipes`, `plugin-refs`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-memories/types";`.
