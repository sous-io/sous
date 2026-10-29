# @sous-io/plugin-config-files

sous.config.* as a contributor, config.set, and the .env files.

- **Specified in:** S6, "Config files: plugin-config-files and plugin-confd".
- **Capabilities (S7):** C1, C70, C74, C77.
- **Depends on:** `plugin-expressions`, `plugin-variables`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-config-files/types";`.
