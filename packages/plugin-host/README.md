# @sous-io/plugin-host

Gives plugins the machine sous runs on: starting programs, HTTP, file globs, sous's home folder, the `.gitignore` block and the package's own identity.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-host/types";

const { stdout } = await ctx.services.get("host.processes").run("node", ["--version"]);
const isTs = ctx.services.get("host.globs").isMatch("src/a.ts", "**/*.ts");
```

## Where things are

- `src/processes.ts`, `src/http.ts`: running programs and HTTP.
- `src/globs.ts`: glob matching and path checks.
- `src/sous-home.ts`, `src/gitignore.ts`: the home folder and `.gitignore` block.
- `src/directories.ts`: folders that explain themselves to an agent.

## Testing

```bash
pnpm --filter @sous-io/plugin-host test
```
