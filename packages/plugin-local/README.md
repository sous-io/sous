# @sous-io/plugin-local

A repository-host entity for a repository on disk.

- **Specified in:** S6, "Host and package-manager plugins".
- **Capabilities (S7):** none of its own.
- **Depends on:** `plugin-recipes`, `plugin-host`, `plugin-git`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-local/types";`.
