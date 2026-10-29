# Layers and Merging

Sous builds one config for a project from many sources: the primary `sous.config.*` file, each
file in `conf.d/`, the config files recipes ship, the entries sous adds itself (the official
repository and the `core` subscription), and any plugin that changes the config. Each source is a
**contributor**: a named piece of code that changes the config through a builder object. Sous runs
the contributors in-process, in one loop, before any command does its work, and again after a
command that changed the config.

?> Before 1.0, a separate child process (the config kernel) loaded and merged the files, with no
way for plugins to take part. That process is gone. The design is in
[S2: Building the Config](architecture/specifications/S2-config-building.md).

## Config files are contributors

- `plugin-config-files` adds one contributor for the primary `sous.config.*` file, named
  `config-files.main`.
- `plugin-confd` adds one contributor per file directly inside `conf.d/` (non-recursive), named after
  the file: `confd/610-mac.jsonc`.
- Recipe config files, the built-in entries and the environment come in the same way, from the
  plugins that own them.

A `.json`, `.jsonc` or `.yaml` file is parsed; a `.js`, `.mjs` or `.ts` file is imported in
the sous process itself. A `.jsonc` file is JSON with comments: line comments, block comments and
trailing commas are all allowed in it. A file is read from disk once per build.

## Load order, and why your files win

The `conf.d/` files keep their order: they are sorted BYTEWISE by filename, and each one's
contributor runs after the file before it, the first one after the primary config:

```text
each pass:  plugins … → sous.config.* → confd/500-repos → confd/510-subscriptions → confd/610-mac
```

The sort is locale-independent and stable, but it is not numeric: `10-a.json` sorts before
`2-b.json` because the character `1` precedes `2`. Zero-pad numeric prefixes (`02-`, `10-`) when
ordering matters.

Your files land last. Each config file is applied as one merge at the root of the config, so its
contributor reads the whole config and re-runs whenever anything else changes it. Its change then
lands on top again. So when a plugin, or a recipe's config file, sets a key that your
`sous.config.*` or a `conf.d` file also sets, your value wins.

```js
// .sous/sous.config.js (excerpt)
export const config = {
  compilation: {
    includeSourceComments: false,
  },
};
```

```text
a plugin's contributor sets includeSourceComments = true, which changes the config
→ the sous.config.* contributor re-runs after it; its merge lands on top: false
result: false. In a project whose files don't set it: true.
```

## How the loop runs

1. Every contributor runs once. Each one is given the config made from every other contributor's
   latest change, without its own, so no contributor has to guard against applying itself twice.
2. Every read a contributor makes is recorded. A contributor runs again only when a key or entity it
   read has changed since its last run.
3. Plugins listed in the `plugins` key are loaded after each pass, and their contributors join the
   next pass.
4. The loop ends when nothing anyone read has changed and no new contributor or plugin appeared. A
   config that never settles (10 passes, for example) is a `ConfigError` naming the values that kept
   changing and the contributors they came from.
5. Validation runs last, after values resolve.

A config whose contributors read nothing that later changes settles in one pass.

## Merge semantics

A config file is merged key by key into the config the earlier contributors built:

- plain object + plain object: recurse
- array + array: CONCATENATE, existing items first, the file's second. No dedupe. Each contributor's
  latest change is applied once per pass, so a file that re-runs never doubles its own array items.
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
`configure(config)`, which is given the builder, like any plugin's contributor:

```js
// .sous/conf.d/620-no-diagrams.js
export function configure(config) {
  config.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
}
```

`configure` runs again whenever its contributor re-runs, so it must give the same result for the
same input. When a `.js` file changes on disk during watch mode, it is imported again.

The builder's operations, at least:

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

?> Sous 0.2.x passed `configure(currentConfig, builder)` a mutable config and a different builder
(`builder.merge`, `builder.loadConfig`, `builder.loadConfigs`, `builder.env`). The 1.0 contract is the
one above, from [S2](architecture/specifications/S2-config-building.md#config-files); whether the old
helpers survive is not settled there.

## Patches

Every change a contributor makes ends up as primitive operations, each called a patch:

| `op` | What it does |
| --- | --- |
| `setKey` | sets one key of an object |
| `deleteKey` | deletes one key of an object |
| `renameKey` | renames one key of an object |
| `setIndex` | sets one item of an array |
| `insertAt` | inserts one item into an array |
| `removeIndex` | removes one item from an array |

Every other builder operation is built from these. `removeWhere` above, for example, records one
`removeIndex` per matching item. `sous config show --layers` shows both: each operation a
contributor ran, and the patches it made.

### Patch files

A file of raw patches is a contributor too, in `conf.d/` or beside `sous.config.*`:

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
index 7 at that point. Use patch files for arrays only when you know the order the contributors run
in. Key and path operations have no such catch.

## Failure behavior

Any config file failure (a JSON/YAML parse error, an import error, a `configure` throw) halts sous
with a `ConfigError` naming the file. There is no warn-and-skip; a broken file never silently drops
out of the config.

## The managed 5xx band

`conf.d/500-*` through `conf.d/599-*` is reserved for files the sous CLI writes on your behalf.
They are `.jsonc`, and each one opens with a header comment saying what it holds. They are ordinary
contributors: no code treats one of them as special, and sous always reads the built config, never
one file on its own.

**Sous edits these files by key; you may edit them too.** A write rewrites only the bytes of the
entry that changes, so your comments, your key order and your formatting survive it, and repeated
edits produce minimal version-control diffs. Sous never edits a hand-written primary config or a
file outside the 5xx band. To override a managed value rather than change it in place, add a
higher-sorting file (for example `conf.d/600-overrides.json`), or a
[config expression](configuration.md#config-expressions) that switches it on some machines only.

Where a comment is impossible because a format really is strict JSON, the convention is a `//`
key, which sous ignores wherever it appears.
