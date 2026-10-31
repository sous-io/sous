# @sous-io/plugin-config-files

Reads `sous.config.*` and the `.env` files, and writes single values back into the config file. `sous.config.*` and the patch files beside it apply at apply order 89900, after every plugin's contributor and before the `conf.d` files.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous config set <path> <value>` | sets one value in a config file, keeping the rest of the file as written |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-config-files/types";

await ctx.run("config.set", { path: "compilation.includeSourceComments", value: "true" });
```

## Where things are

- `src/loader.ts`: reads each config file format.
- `src/set.ts`: the `config.set` intent; its output is one sentence saying what changed.
- `src/env/`: the `.env` files.
- `src/index.ts`: registers the layer, services and keys.

## Testing

```bash
pnpm --filter @sous-io/plugin-config-files test
```
