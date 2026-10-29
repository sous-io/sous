# @sous-io/plugin-skills

Skills: where they come from, the skill-target entity, and the compilation targets for them.

- **Specified in:** S6, "Skills: plugin-skills".
- **Capabilities (S7):** C42, C57.
- **Depends on:** `plugin-compiler`, `plugin-recipes`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-skills/types";`.
