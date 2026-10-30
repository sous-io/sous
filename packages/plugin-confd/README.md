# @sous-io/plugin-confd

Reads a project's `conf.d` files as config layers, and lets other plugins edit the managed ones.

It adds no commands. The managed layer names (such as `520-var-mappings.jsonc`) are listed in `src/types.ts`.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-confd/types";

const managed = ctx.services.get("confd.managed");
await managed.set("520-var-mappings.jsonc", "varMappings.MY_VAR", "workflow/x.name");
```

## Where things are

- `src/files.ts`: finds and orders the files, one config layer per file.
- `src/managed.ts`: edits to the files sous manages.
- `src/index.ts`: registers the layers and services.

## Testing

```bash
pnpm --filter @sous-io/plugin-confd test
```
