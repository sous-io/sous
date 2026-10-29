# Layers and Merging

Sous builds one config for a project from many sources: the primary `sous.config.*` file, each
file in `conf.d/`, the config files recipes ship, the entries sous adds itself (the official
repository and the `core` subscription), and any plugin that changes the config. Sous combines
them all before any command does its work, and again after a command that changed the config.

## Which files are read

- The primary `sous.config.*` file in `.sous/`.
- Every file directly inside `conf.d/` (not its subdirectories).

A `.json`, `.jsonc` or `.yaml` file is parsed; a `.js`, `.mjs` or `.ts` file is imported in
the sous process itself. A `.jsonc` file is JSON with comments: line comments, block comments and
trailing commas are all allowed in it. A file is read from disk once per build.

## Load order, and why your files win

The `conf.d/` files are applied in order after the primary config, sorted BYTEWISE by filename:

```text
plugins and recipes → sous.config.* → conf.d/500-repos → conf.d/510-subscriptions → conf.d/610-mac
```

The sort is locale-independent and stable, but it is not numeric: `10-a.json` sorts before
`2-b.json` because the character `1` precedes `2`. Zero-pad numeric prefixes (`02-`, `10-`) when
ordering matters.

Your files land last. Whenever a plugin or a recipe's config file changes the config, sous applies
your `sous.config.*` and `conf.d` files again on top of it. So when a plugin or a recipe sets a key
that one of your files also sets, your value wins:

```js
// .sous/sous.config.js (excerpt)
export const config = {
  compilation: {
    includeSourceComments: false,
  },
};
```

If a plugin sets `compilation.includeSourceComments` to `true`, the result is still `false`. In a
project whose files do not set it, the result is `true`.

Sous repeats this until nothing changes. A file that is applied again never doubles its own array
items. A config that never settles (two files that keep changing a value the other reads, for
example) stops sous with a `ConfigError` naming the values that kept changing and where each change
came from. Validation runs last, after variables resolve.

## Merge semantics

A config file is merged key by key into the config built so far:

- plain object + plain object: recurse
- array + array: CONCATENATE, existing items first, the file's second. Duplicates are kept.
- anything else (scalar, mixed types, null): the later file replaces
- an own `__proto__`, `constructor`, or `prototype` key in file data is skipped

To remove or replace an array item without code, write a [patch file](#patch-files).

## Plain JSON data

The config is always plain JSON data, so `sous config show` can print it exactly. Every value passes
through a JSON round-trip: functions and `undefined` values are dropped, and a regular expression is
written as a string `/.../`. [Config expressions](configuration.md#config-expressions) rely on
`undefined` values being dropped.

## JavaScript and TypeScript files

A `.js`, `.mjs` or `.ts` config file may export plain data (`export const config = {...}`, or a
default export that is an object), which is merged like a JSON file. It may also export
`configure(config)`, which is given a builder object for changing the config:

```js
// .sous/conf.d/620-no-diagrams.js
export function configure(config) {
  config.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
}
```

`configure` runs again whenever sous applies the file again, so it must give the same result for
the same input. When a `.js` file changes on disk during watch mode, it is imported again.

Some of the builder's operations (the full list, with each one's documentation, is the `DocumentNode`
type in `packages/plugin-api/src/node.ts`):

```js
const node = config.atPath("compilation.targets");

// Inspecting
node.exists();
node.type();                   // "object" | "array" | "string" | "number" | "boolean" | "null"
node.isArray();
node.isObject();
node.get();
node.valueOr(fallback);

// Objects and values
node.set(value);
node.delete();
node.rename("newKey");
node.merge(object);            // key by key; arrays joined
node.replace(object);          // whole
config.atPath("tools").keys();

// Arrays
node.append(item);
node.prepend(item);
node.insertAt(2, item);
node.removeAt(2);
node.removeWhere((target) => target.id === "diagrams");
node.upsertWhere((target) => target.id === "diagrams", item);   // replace the match, or append
node.findWhere((target) => target.id === "diagrams");           // a node for the match, to edit in place
node.atIndex(0);
node.move(from, to);
node.dedupe();

// The whole config
config.root().merge(data);
```

?> A `configure(currentConfig, builder)` written for sous 0.2.x, which changes `currentConfig` in
place and calls the old builder (`builder.merge`, `builder.loadConfig`, `builder.loadConfigs`,
`builder.env`), keeps working. Sous records what it changed like any other change.

## Patches

Every change to the config, from a file, a recipe or a plugin, ends up as primitive operations,
each called a patch:

| `op` | What it does |
| --- | --- |
| `setKey` | sets one key of an object |
| `deleteKey` | deletes one key of an object |
| `renameKey` | renames one key of an object |
| `setIndex` | sets one item of an array |
| `insertAt` | inserts one item into an array |
| `removeIndex` | removes one item from an array |

Every other builder operation is built from these. `removeWhere` above, for example, records one
`removeIndex` per matching item. `sous config show --layers` shows both: each operation a file or
plugin ran, and the patches it made.

### Patch files

A file of raw patches can sit in `conf.d/` or beside `sous.config.*`:

- A `.patch.json` file holds one patch, unless its top-level object has a single key, `$patches`,
  holding an array: then each item is a patch.
- A `.patch.jsonl` file holds one patch per line, so a tool or an agent can add a line without
  parsing the file.

```jsonc
// .sous/conf.d/720-my-special-thing.patch.json: several patches, so a single $patches key
{
    "$patches": [
        { "op": "setKey", "path": "compilation", "key": "overwriteUntracked", "value": false },
        { "op": "deleteKey", "path": "tools", "key": "codex" }
    ]
}
```

```jsonl
// .sous/conf.d/721-my-list-of-things.patch.jsonl: one patch per line
{"op": "insertAt", "path": "compilation.targets", "index": 0, "value": {"id": "first", "entryPoint": "a.tpl.md"}}
{"op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop"}
```

!> An index written in a patch file is never recomputed: `removeIndex 7` removes whatever is at
index 7 at that point. Use patch files for arrays only when you know the order the files, recipes and
plugins before it apply in. Key and path operations have no such catch.

## Failure behavior

Any config file failure (a JSON/YAML parse error, an import error, a `configure` throw) halts sous
with a `ConfigError` naming the file. There is no warn-and-skip; a broken file never silently drops
out of the config.

## The managed 5xx layer band

`conf.d/500-*` through `conf.d/599-*` is reserved for files the sous CLI writes on your behalf.
They are `.jsonc`, and each one opens with a header comment saying what it holds. They are ordinary
config files, merged like any other: sous always reads the built config, never one file on its own.

**Sous edits these files by key; you may edit them too.** A write rewrites only the bytes of the
entry that changes, so your comments, your key order and your formatting survive it, and repeated
edits produce minimal version-control diffs. Sous never edits a hand-written primary config or a
file outside the 5xx band. To override a managed value rather than change it in place, add a
higher-sorting file (for example `conf.d/600-overrides.json`), or a
[config expression](configuration.md#config-expressions) that switches it on some machines only.

Where a comment is impossible because a format really is strict JSON, the convention is a `//`
key, which sous ignores wherever it appears.
