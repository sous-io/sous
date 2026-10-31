# @sous-io/documents

Edits JSON, JSONC and YAML files one key at a time, so a change touches only what it names and leaves the user's comments, spacing and other keys alone.

Every edit is a primitive patch (set, remove, append, and so on) at a path. A list of patches is a patch set, which can be applied to a document, saved as a `.patch.json` file, and read back.

## Using it from code

```ts
import { parseDocument } from "@sous-io/documents";

const doc = parseDocument('{ "name": "demo" } // keep this comment', "jsonc");

doc.atPath(["name"]).set("other");
console.log(doc.toString()); // the comment and the layout are untouched
```

The same node operations work on plain values, which is how the engine builds the config, so a plugin's config contributor and a file edit read alike.

## Where things are

- `src/node.ts`: the operations on one place in a document.
- `src/text-document.ts`, `src/value-document.ts`: documents backed by file text, and by plain values.
- `src/jsonc-text.ts`, `src/yaml-text.ts`: the format-specific editing.
- `src/patch-set.ts`, `src/apply.ts`, `src/serialize.ts`: patch sets, applying them, and the patch file format.

## Testing

```bash
pnpm --filter @sous-io/documents test
```
