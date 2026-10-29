# @sous-io/plugin-recipe-answers

Recipe variable definitions, the answer ladder, asking for answers, answer files and variable mappings.

- **Specified in:** S6, "Recipe answers: plugin-recipe-answers".
- **Capabilities (S7):** C46.
- **Depends on:** `plugin-recipes`, `plugin-confd`, `plugin-config-files`, `plugin-formats`, `plugin-refs`, `plugin-variables`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-recipe-answers/types";`.
