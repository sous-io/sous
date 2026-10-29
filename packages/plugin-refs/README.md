# @sous-io/plugin-refs

Parsing and resolving refs, picking among matches, # names, repository locations and identity.

- **Specified in:** S6, "Shared building blocks (refs.*, hash-name)".
- **Capabilities (S7):** C46 (--accept-first answers the pick).
- **Depends on:** `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-refs/types";`.
