# @sous-io/sous-plugin-pnpm

Lets sous detect pnpm and install plugins with it.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/sous-plugin-pnpm/types";

const pnpm = ctx.entities.get("package-manager", "pnpm");
```

## Where things are

- `src/manager.ts`: the package manager.
- `src/index.ts`: registration.

## Testing

```bash
pnpm --filter @sous-io/sous-plugin-pnpm test
```
