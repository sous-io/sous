# @sous-io/plugin-yarn

Lets sous detect Yarn (including Plug'n'Play) and install plugins with it.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-yarn/types";

const yarn = ctx.entities.get("package-manager", "yarn");
```

## Where things are

- `src/manager.ts`: the package manager.
- `src/pnp.ts`: finding plugins in a Plug'n'Play install.
- `src/node-modules.ts`: finding installed packages.

## Testing

```bash
pnpm --filter @sous-io/plugin-yarn test
```
