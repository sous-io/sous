# @sous-io/plugin-liquid

Provides the Liquid template engine that sous uses for templates and config expressions, and lets plugins add tags and filters.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-liquid/types";

const liquid = ctx.services.get("liquid.engine").create();
const text = await liquid.parseAndRender("Hello {{ name }}", { name: "sous" });
```

To see what each top-level Liquid section of a template printed, render a marked copy of it once
and cut the output apart:

```ts
const regions = ctx.services.get("liquid.regions");
const marked = regions.mark(source);
const { output, regions: sections, segments } = regions.split(await liquid.parseAndRender(marked.source, vars), marked);
```

## Where things are

- `src/engine.ts`: builds the engine from the registered tags and filters.
- `src/entity-schemas.ts`: what a tag or filter entity looks like.
- `src/regions.ts`: finds a template's top-level Liquid sections and cuts a render's output into them.

## Testing

```bash
pnpm --filter @sous-io/plugin-liquid test
```
