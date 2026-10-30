# @sous-io/plugin-local

Lets sous read a recipe repository that is a folder on this machine, with no network.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-local/types";

const local = ctx.entities.get("repository-host", "local");
```

## Where things are

- `src/host.ts`: the repository host.
- `src/paths.ts`: reading a folder path as a location.
- `src/repo-directory.ts`: checking a folder is a recipe repository.

## Testing

```bash
pnpm --filter @sous-io/plugin-local test
```
