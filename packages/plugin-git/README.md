# @sous-io/plugin-git

The one git runner.

- **Specified in:** S6, "Shared building blocks (git.runner)".
- **Capabilities (S7):** none of its own; every capability that reads a repository through git.
- **Depends on:** `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-git/types";`.
