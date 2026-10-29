# @sous-io/plugin-liquid

A configured LiquidJS engine, and the Liquid tags and filters plugins add.

- **Specified in:** S6, "Shared building blocks (liquid.engine, liquid-tag, liquid-filter)".
- **Capabilities (S7):** C36.
- **Depends on:** `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-liquid/types";`.
