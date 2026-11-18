# @sous-io/sous-plugin-memories

Compiles the one memories file each coding tool reads into every session (for Claude Code, `.claude/rules/SOUS-MEMORIES.md`) from `.sous/MEMORIES.tpl.md`, or from the default source when that file does not exist, and chooses which recipe memories `#memories` lists.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/sous-plugin-memories/types";

const memories = ctx.services.get("memories.selection").forTarget("claude-code");
```

## Where things are

- `src/selection.ts`: picks the memories.
- `src/targets.ts`: the compilation target for each memory target, and the transform that leaves out an empty file.
- `src/hash-name.ts`: the `#memories` name.
- `src/schemas.ts`: the `recipes.memories` config key.

## Testing

```bash
pnpm --filter @sous-io/sous-plugin-memories test
```
