# @sous-io/plugin-formats

Reads and writes sous's own files (lockfile, recipe and repository manifests, index files) and computes a recipe's content hash.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-formats/types";

const manifests = ctx.services.get("formats.manifests");
const { manifest } = await manifests.requireRecipe("./my-recipe");
```

## Where things are

- `src/parsers.ts`: one parser per file format.
- `src/manifests.ts`: finding and reading manifests.
- `src/recipe-hash.ts`: the content hash.
- `src/formats/`: the format definitions.

## Testing

```bash
pnpm --filter @sous-io/plugin-formats test
```
