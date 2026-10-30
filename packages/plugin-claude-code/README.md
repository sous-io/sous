# @sous-io/plugin-claude-code

Teaches sous about Claude Code: where its skills and memory files go, and how to run it.

It adds no commands. `sous launch claude` works because of it.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-claude-code/types";

const harness = ctx.entities.get("harness", "claude");
```

## Where things are

- `src/harness.ts`: the Claude Code harness.
- `src/targets.ts`: the skill and memory targets it adds to the config.
- `src/transcript.ts`: reading a headless run's output.

## Testing

```bash
pnpm --filter @sous-io/plugin-claude-code test
```
