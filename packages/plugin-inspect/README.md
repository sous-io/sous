# @sous-io/plugin-inspect

Showing the engine's state: config show, config get, config validate, plugins show, timings.

- **Specified in:** S6, "Showing the engine's state: plugin-inspect".
- **Capabilities (S7):** C52, C53, C62, C78.
- **Depends on:** nothing.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-inspect/types";`.
