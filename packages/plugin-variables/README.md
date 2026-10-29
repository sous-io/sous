# @sous-io/plugin-variables

${var} substitution, _vars resolution, auto-variables, variable names and secrets.

- **Specified in:** S6, "Shared building blocks (variables.*, variable-source)".
- **Capabilities (S7):** none of its own; S2 "Variable scopes".
- **Depends on:** `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-variables/types";`.
