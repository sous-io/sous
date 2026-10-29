# @sous-io/plugin-init

Scaffolding a project's .sous/ (sous init).

- **Specified in:** S6, "Project setup and updates: plugin-init, plugin-update".
- **Capabilities (S7):** C46.
- **Depends on:** `plugin-build`, `plugin-config-files`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-init/types";`.
