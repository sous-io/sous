# @sous-io/plugin-inspect

Shows what sous is doing, so a user can check why the config or a build came out the way it did.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous config show [--layers] [--raw]` | the built config; `--layers` lists each change and who made it; `--raw` prints each file as written |
| `sous config get <path>` | one value from the built config |
| `sous config validate` | checks the built config against every config key's schema |
| `sous plugins show [name]` | every plugin, what it registered, and which plugin loaded it |
| `sous timings show` | every timing of the run and its budget |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-inspect/types";

const { layers } = (await ctx.run("config.show", { layers: true })).toPlain();
```

## Where things are

- `src/types.ts`: every intent's input and result types.
- `src/index.ts`: registers the intents.
- `src/handlers.ts`: what each intent does; each returns outputs, and `plugins.show` and `timings.show` declare `{ plugins }` and `{ timings }`.
- `src/outputs.ts`: what people see: the config as data, layers as a tree or a table, the validation result, plugins and timings.
- `src/raw.ts`, `src/redact.ts`: raw file output, and hiding secrets.

## Testing

```bash
pnpm --filter @sous-io/plugin-inspect test
```
