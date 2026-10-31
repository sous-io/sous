# @sous-io/plugin-mcp

Lets AI agents use sous directly over MCP: each intent becomes a tool. A tool call returns the intent's outputs: their text as the text content and `outputs.toPlain()` as the structured result.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous mcp` | serves this project's intents as MCP tools; `mcp.include` and `mcp.exclude` in the config choose which |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-mcp/types";

const tools = ctx.services.get("mcp.tools").list();
```

## Where things are

- `src/tools.ts`: turns intents into tools.
- `src/server.ts`: the MCP server.
- `src/reporter.ts`, `src/prompter.ts`: log messages, progress and questions sent to the agent.

## Testing

```bash
pnpm --filter @sous-io/plugin-mcp test
```
