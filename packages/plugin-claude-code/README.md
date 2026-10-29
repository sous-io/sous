# @sous-io/plugin-claude-code

Everything sous knows about Claude Code: its harness, skill-target and memory-target entities.

- **Specified in:** S6, "Host and package-manager plugins (plugin-claude-code)".
- **Capabilities (S7):** C41, C42, C43, C56.
- **Depends on:** `plugin-skills`, `plugin-memories`, `plugin-harnesses`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-claude-code/types";`.
