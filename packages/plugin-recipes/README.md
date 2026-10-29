# @sous-io/plugin-recipes

Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.

- **Specified in:** S6, "Recipes: plugin-recipes".
- **Capabilities (S7):** C39, C40, C48, C59, C60.
- **Depends on:** `plugin-confd`, `plugin-formats`, `plugin-refs`, `plugin-variables`, `plugin-git`, `plugin-compiler`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-recipes/types";`.
