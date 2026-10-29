# @sous-io/plugin-host

The machine sous runs on: processes, HTTP, globs and paths, sous home, self-describing directories, the .gitignore block, package identity.

- **Specified in:** S6, "The machine: plugin-host".
- **Capabilities (S7):** C44 (pointer files).
- **Depends on:** nothing.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-host/types";`.
