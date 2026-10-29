# @sous-io/plugin-authoring

Releasing, submitting and contributing to recipe repositories, and scaffolding one.

- **Specified in:** S6, "Authoring: plugin-authoring".
- **Capabilities (S7):** C46.
- **Depends on:** `plugin-recipes`, `plugin-formats`, `plugin-refs`, `plugin-variables`, `plugin-git`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-authoring/types";`.
