# @sous-io/sous-plugin-build

Builds a project: compiles its outputs, removes the ones the config no longer produces, and can keep rebuilding while files change.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous build` | prepares recipes, compiles every target and prunes; `--watch` keeps building on changes |
| `sous compile` | compiles the targets only, without preparing or pruning |
| `sous prune` | removes outputs the config no longer produces |
| `sous clear` | deletes every file and directory sous wrote for the project |

`build` and `compile` return the result as data, and exit with code 1 when the build has errors. Run as the command itself, they report the "Command Variables" block first. `prune` and `clear` return one sentence saying how much was removed. Progress is reported while they run: a block for each output written, removed or not written (an unchanged one only at the `debug` level), then one line counting the files (`filesSummaryLine` in `src/report.ts`) before `Done.`.

## Using it from another plugin

```ts
import type {} from "@sous-io/sous-plugin-build/types";

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
pnpm --filter @sous-io/sous-plugin-build test
```
