# @sous-io/plugin-recipe-answers

Recipe variable definitions, the answer ladder, asking for answers, answer files and variable mappings.

- **Specified in:** S6, "Recipe answers: plugin-recipe-answers"; S2, "Variable scopes" and "Recipe answers".
- **Capabilities (S7):** C46 (every question answered by `--answer`/`--answers-file`).
- **Depends on:** `plugin-recipes`, `plugin-confd`, `plugin-config-files`, `plugin-formats`, `plugin-refs`, `plugin-variables`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-recipe-answers/types";`.

| What | Where |
| --- | --- |
| `recipe-answers.definitions` (config) | `src/definitions.ts`, from `active-recipe` entities or `--file` |
| `recipe-answers.ladder` (config) | `src/ladder.ts`, built in `src/sources.ts` |
| `recipe-answers.answers` (config) and the `variable-source` entity `recipe-answers` | `src/answers.ts`, `src/variable-source.ts` |
| `recipe-answers.preanswers` (factory) | `src/preanswers.ts` |
| `recipe-answers.mappings` (config), `conf.d/520-var-mappings.jsonc` via `confd.managed` | `src/mappings.ts` |
| `recipe-answers.validator` (singleton), time-limited patterns | `src/validate.ts`, `src/safe-regex.ts` |
| `ref-lookup` entities `recipe-answers.variables`, `recipe-answers.env-vars` (opt-in, tag `variables`) | `src/lookups.ts`, `src/matching.ts` |
| `vars.ask`, `vars.list` (also `sous vars [name]`), `vars.show`, `vars.map` | `src/intents.ts`, `src/ask.ts`, `src/selection.ts` |
| `varMappings` config key | `src/index.ts` |
