# @sous-io/plugin-pnpm

A package-manager entity for pnpm.

- **Specified in:** S6, "Host and package-manager plugins".
- **Capabilities (S7):** C5.
- **Depends on:** `plugin-update`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-pnpm/types";`.
