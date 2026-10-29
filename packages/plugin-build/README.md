# @sous-io/plugin-build

The build, compile, prune and clear intents, preparing for a build, watch mode, the PID file, the runtime context file.

- **Specified in:** S6, "Build: plugin-build".
- **Capabilities (S7):** C13 (build.watch).
- **Depends on:** `plugin-compiler`, `plugin-recipes`, `plugin-recipe-answers`, `plugin-git`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-build/types";`.
