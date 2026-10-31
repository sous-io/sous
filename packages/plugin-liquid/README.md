# @sous-io/plugin-liquid

Provides the Liquid template engine that sous uses for templates and config expressions, and lets plugins add tags and filters.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-liquid/types";

const liquid = ctx.services.get("liquid.engine").create();
const text = await liquid.parseAndRender("Hello {{ name }}", { name: "sous" });
```

## Where things are

- `src/engine.ts`: builds the engine from the registered tags and filters.
- `src/entity-schemas.ts`: what a tag or filter entity looks like.

## Testing

```bash
pnpm --filter @sous-io/plugin-liquid test
```
