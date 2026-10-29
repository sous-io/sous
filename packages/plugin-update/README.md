# @sous-io/plugin-update

Updating sous itself, installing plugins a recipe requires, the package-manager entity, scanning for installed plugins.

- **Specified in:** S6, "Project setup and updates: plugin-init, plugin-update".
- **Capabilities (S7):** C5, C47.
- **Depends on:** `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-update/types";`.
