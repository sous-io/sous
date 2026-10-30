# @sous-io/plugin-refs

Understands the short names users type for things (a recipe, a repository, a `#` name) and works out what they mean.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-refs/types";

const resolver = ctx.services.get("refs.resolver");
const { refs } = await resolver.resolve({ input: "task-files", kinds: ["recipe"] });
const picked = await ctx.services.get("refs.picker").pick(refs, { search: "task-files" }, ctx);
```

## Where things are

- `src/parser/`: splits what a user typed into readings.
- `src/resolver.ts`: looks readings up.
- `src/picker.ts`: asks the user when several match.
- `src/locations/`: repository addresses.

## Testing

```bash
pnpm --filter @sous-io/plugin-refs test
```
