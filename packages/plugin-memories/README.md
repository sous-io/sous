# @sous-io/plugin-memories

Chooses which recipe memories reach the memory files agents read, such as `CLAUDE.md`.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-memories/types";

const memories = ctx.services.get("memories.selection").forTarget("claude");
```

## Where things are

- `src/selection.ts`: picks the memories.
- `src/targets.ts`: the compilation targets for memory files.
- `src/hash-name.ts`: the `#memories` name.
- `src/schemas.ts`: the `recipes.memories` config key.

## Testing

```bash
pnpm --filter @sous-io/plugin-memories test
```
