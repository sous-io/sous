# @sous-io/plugin-update

Updates sous itself, and installs the npm plugins a recipe needs.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous update` | updates sous globally and in this project, with the package manager that installed each copy |
| `sous plugins install` | installs npm plugins through the project's package manager |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-update/types";

await ctx.run("update", { dryRun: true });
```

## Where things are

- `src/update.ts`, `src/plan.ts`: the update and its plan.
- `src/plugins-install.ts`: installing plugins.
- `src/scan.ts`: finding installed plugins.
- `src/registry.ts`: asking the npm registry for versions.

## Testing

```bash
pnpm --filter @sous-io/plugin-update test
```
