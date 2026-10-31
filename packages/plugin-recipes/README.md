# @sous-io/plugin-recipes

Manages the recipes a project uses: which repositories it trusts, which recipes it subscribes to, the lockfile, and the local store of downloaded recipes.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous repo add|remove|trust|list|search|gc|link|unlink` | work with recipe repositories |
| `sous subscription add|remove|enable|disable|list|update` | choose which recipes the project uses (`sous subscribe` also works) |
| `sous recipe list|show|update` | browse and update recipes |
| `sous namespace list|show` | browse a repository's namespaces |
| `sous lock show|rebuild` | see or rebuild the lockfile |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-recipes/types";

const active = ctx.services.get("recipes.active").list();
await ctx.run("subscription.add", { ref: "workflow/task-files" });
```

## Where things are

- `src/part-a/`: subscriptions, trust, the lockfile and the store.
- `src/part-b/`: fetching, resolving, links and the core recipe.
- `src/part-a/intents/`, `src/part-b/index.ts`: the commands. Each intent returns `IntentOutputs`: the work is done by a data function, and a `*-outputs.ts` file beside it (and `src/part-a/outputs.ts`, the pieces they share) builds the Command Variables, tables, lists, notes and follow-up outputs that command shows. `toPlain()` of the outputs is the declared result in `types.ts`, an object (a list is `{ subscriptions: [...] }`, `{ repos: [...] }`, and so on).
- `src/types.ts`: every service and intent.

## Testing

```bash
pnpm --filter @sous-io/plugin-recipes test
```
