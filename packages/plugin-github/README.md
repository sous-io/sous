# @sous-io/plugin-github

A repository-host entity for GitHub: reading indexes, the token, proposing changes, the CI workflow.

- **Specified in:** S6, "Host and package-manager plugins".
- **Capabilities (S7):** S4 read strategies and token sources.
- **Depends on:** `plugin-recipes`, `plugin-host`, `plugin-git`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-github/types";`.
- **Built on:** `@sous-io/repository-hosts` (shared URL parsing, token sources, read strategies).
  `recipes.index-cache` tries the strategies in order and remembers what worked.
