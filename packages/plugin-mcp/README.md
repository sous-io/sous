# @sous-io/plugin-mcp

The sous mcp front end: tools generated from intents, MCP logging and elicitation.

- **Specified in:** S6, "Front ends: plugin-cli, plugin-mcp".
- **Capabilities (S7):** C8, C16, C45, C46.
- **Depends on:** nothing.
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-mcp/types";`.
