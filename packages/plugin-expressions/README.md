# @sous-io/plugin-expressions

Config expressions (S5) and the expression languages plugins add.

- **Specified in:** S6, "Shared building blocks (expressions.evaluator, expression-language)".
- **Capabilities (S7):** C36, C54, C55.
- **Depends on:** `plugin-liquid`, `plugin-variables`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-expressions/types";`.
