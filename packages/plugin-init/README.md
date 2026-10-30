# @sous-io/plugin-init

Sets a folder up as a sous project: writes `.sous/` with a starter config, then runs the first build.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous init [directory]` | creates `.sous/`; `--no-build` skips the first build, `--dry-run` writes nothing |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-init/types";

await ctx.run("init", { dryRun: true });
```

## Where things are

- `src/init.ts`: the `init` intent.
- `src/scaffold.ts`, `src/templates.ts`: the files it writes.
- `src/package-json.ts`: the `package.json` change.

## Testing

```bash
pnpm --filter @sous-io/plugin-init test
```
