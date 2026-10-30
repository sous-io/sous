# @sous-io/plugin-harnesses

Runs coding agents for a project: builds first, then starts the tool the user named in their config, or runs one with nobody at the keyboard.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous launch <tool>` | builds the outputs, then starts that tool; `--no-build` skips the build |
| `(hidden) `harness run-headless`` | runs a harness without a person and reads its transcript |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-harnesses/types";

await ctx.run("launch", { tool: "claude", noBuild: true });
```

## Where things are

- `src/launch.ts`: the `launch` intent.
- `src/run-headless.ts`: headless runs.
- `src/settings.ts`: the `tools` config key.
- `src/tool.ts`: turning a tool's settings into a command.

## Testing

```bash
pnpm --filter @sous-io/plugin-harnesses test
```
