# @sous-io/plugin-variables

Fills in `${var}` references in config and recipe text, and hides secret values when they are shown.

It adds no commands. To read variables while a config is being built, use `scopeIn(config, ...)` so the config re-runs when a variable changes; see `src/types.ts`.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-variables/types";

const vars = ctx.services.get("variables.resolver");
const text = vars.substitute("Hello ${name}", vars.scope());
```

## Where things are

- `src/resolver.ts`, `src/substitute.ts`: substitution.
- `src/scope.ts`: which variables are visible where.
- `src/auto.ts`: variables sous provides itself.
- `src/secrets.ts`: hiding secrets.

## Testing

```bash
pnpm --filter @sous-io/plugin-variables test
```
