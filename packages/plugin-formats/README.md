# @sous-io/plugin-formats

One parser per on-disk format, reading manifests, and the recipe content hash.

- **Specified in:** S6, "Shared building blocks (formats.*)".
- **Capabilities (S7):** C40 (the manifest's plugin entry).
- **Depends on:** `plugin-refs`.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-formats/types";`.
