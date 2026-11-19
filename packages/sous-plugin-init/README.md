# @sous-io/sous-plugin-init

Sets a folder up as a sous project: writes `.sous/` with a starter config, then runs the first build.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous init [directory]` | creates `.sous/`; `--no-build` skips the first build, `--dry-run` writes nothing |
| `sous init hooks [directory]` | installs the git hooks that build Sous's output in a new worktree; `--pull-hooks` adds `post-merge` and `post-rewrite` |

## Using it from another plugin

```ts
import type {} from "@sous-io/sous-plugin-init/types";

await ctx.run("init", { dryRun: true });
```

## Where things are

- `src/init.ts`: the `init` intent. It reports each file as it writes it, then returns the first build's outputs and a "What was set up" block.
- `src/scaffold.ts`, `src/templates.ts`: the files it writes.
- `src/package-json.ts`: the `package.json` change.

## Testing

```bash
pnpm --filter @sous-io/sous-plugin-init test
```
