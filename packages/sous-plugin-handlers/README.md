# @sous-io/sous-plugin-handlers

Runs handlers: functions a recipe or a plugin provides for a purpose (`check`, `configure`,
`beforeBuild`, `afterBuild`, `uninstall`, `migrate`). It defines the `handler` entity kind, the
helpers a handler receives as `sous`, and one internal intent per purpose (`handlers.check`,
`handlers.beforeBuild`, `handlers.afterBuild`, `handlers.uninstall`, `handlers.migrate`).
`configure` handlers run inside the `handlers/configure` contributor.

It adds no commands.

## Using it from another plugin

```ts
import { checksFailedError, runHandlerPurpose } from "@sous-io/sous-plugin-handlers";

const checks = await runHandlerPurpose(ctx, "check", { ignoreFailedChecks: input.ignoreFailedChecks });

if (checks.failed) {
    throw checksFailedError(checks);
}
```

## Where things are

- `src/run.ts`: the order handlers run in, and running one purpose.
- `src/tools.ts`: what a handler receives.
- `src/system.ts`: the `handlers.system` service (`isAppAvailable`, `appVersion`).
- `src/recipes.ts`: a recipe manifest's `handlers`, as `recipes.handlers` values and `handler` entities.
- `src/configure.ts`: the `handlers/configure` contributor.
- `src/lifecycle.ts`: when `migrate`, `uninstall` and `check` (on subscribing) run.

## Testing

```bash
corepack pnpm --filter @sous-io/sous-plugin-handlers test
```
