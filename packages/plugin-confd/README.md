# @sous-io/plugin-confd

The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.

- **Specified in:** S6, "Config files: plugin-config-files and plugin-confd".
- **Capabilities (S7):** C59, C70, C77.
- **Depends on:** `plugin-config-files`, `plugin-expressions`, `plugin-variables`, `plugin-host`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-confd/types";`.
