# @sous-io/plugin-harnesses

The harness entity, launching a harness, headless runs, and the tools settings.

- **Specified in:** S6, "Harnesses: plugin-harnesses".
- **Capabilities (S7):** C41, C56.
- **Depends on:** `plugin-build`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-harnesses/types";`.
