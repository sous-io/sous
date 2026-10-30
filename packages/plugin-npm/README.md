# @sous-io/plugin-npm

Lets sous detect npm and install plugins with it.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-npm/types";

const npm = ctx.entities.get("package-manager", "npm");
```

## Where things are

- `src/manager.ts`: the package manager.
- `src/node-modules.ts`: finding installed packages.

## Testing

```bash
pnpm --filter @sous-io/plugin-npm test
```
