# @sous-io/plugin-git

Runs git for the rest of sous, so every plugin shares one way to call it.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-git/types";

const git = ctx.services.get("git.runner");
const branch = await git.currentBranch(process.cwd());
```

## Where things are

- `src/runner.ts`: the runner and its helpers.
- `src/errors.ts`: the error a failed git call raises.
- `src/types.ts`: the service's methods.

## Testing

```bash
pnpm --filter @sous-io/plugin-git test
```
