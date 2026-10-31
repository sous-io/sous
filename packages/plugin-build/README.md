# @sous-io/plugin-build

Builds a project: compiles its outputs, removes the ones the config no longer produces, and can keep rebuilding while files change.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous build` | prepares recipes, compiles every target and prunes; `--watch` keeps building on changes |
| `sous compile` | compiles the targets only, without preparing or pruning |
| `sous prune` | removes outputs the config no longer produces |
| `sous clear` | deletes every file and directory sous wrote for the project |

`build` and `compile` return the "Command Variables" block, then the result as data, and exit with code 1 when the build has errors. `prune` and `clear` return one sentence saying how much was removed. Progress (targets, removed files, the lockfile) is reported while they run.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-build/types";

// Intents return outputs; a calling intent reads the last output's plain object.
const result = (await ctx.run("build", { dryRun: true })).toPlain();   // BuildResult, including `watching`
```

## Where things are

- `src/index.ts`: registers the intents, services and config keys.
- `src/build.ts`, `src/prepare.ts`: the build and its preparation step.
- `src/watch/`: watch mode.
- `src/pid.ts`, `src/runtime-context.ts`: the PID file and the runtime context file.

## Testing

```bash
pnpm --filter @sous-io/plugin-build test
```
