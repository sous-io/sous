# Layers, Merging, and the configure() Contract

Every config source (the primary file plus each `conf.d/` layer) is loaded by ONE
subprocess, the config kernel, which merges everything into a single cumulative config
and returns it as plain JSON.

## Load order

1. The primary `sous.config.*` file.
2. Every `*.js|mjs|json|yaml` file directly inside `conf.d/` (non-recursive), sorted
   BYTEWISE by filename. The sort is locale-independent and per-machine stable, but it is
   not numeric: `10-a.json` sorts before `2-b.json` because the character `1` precedes
   `2`. Zero-pad numeric prefixes (`02-`, `10-`) when ordering matters.

## JSON forcing

Each layer's contribution passes through a JSON round-trip BEFORE merging:

- Functions and `undefined` values are dropped.
- `RegExp` becomes `{}`; `Date` becomes its ISO string.
- The final merged config is round-tripped once more on the way out.

Write configs as plain data; behavior belongs in `configure()` (below), which runs inside
the kernel before serialization.

## Deep merge semantics

Applied key by key when a later layer meets the cumulative config:

- plain object + plain object: recurse.
- array + array: CONCATENATE, cumulative first, layer second. No dedupe; loading the same
  fragment twice duplicates its array entries. There is no declarative way to remove or
  replace an array entry; use `configure()` and mutate directly when you need that.
- anything else (scalar, mixed types, null): the later layer replaces.
- An own `__proto__`, `constructor`, or `prototype` key in layer data is skipped
  (prototype-pollution guard).

A layer whose own object contains `projects` or `defaultProject` (the legacy multi-project
schema) fails immediately, naming that file.

## The JS/MJS layer contract

A `.js` or `.mjs` layer may export a config object, a configure function, or both:

- **Object**: `export const config = {...}`, or a default export that is a non-function
  object. Merged first.
- **Function**: `export function configure(currentConfig, builder)`, or a default export
  that is a function. Runs AFTER the object (if any) merges. It may be async and is
  awaited. It may mutate `currentConfig` by reference freely. A returned object is merged
  after it resolves, UNLESS the return value IS `currentConfig` itself (the
  mutate-and-return-for-chaining idiom), which is skipped so arrays are not duplicated by
  a self-merge.

## The builder

`configure` receives a builder with:

- `builder.config`: the live cumulative config (same object as `currentConfig`).
- `builder.sousDir`, `builder.confDir`: resolved directories.
- `builder.currentFile`: absolute path of the layer being loaded.
- `builder.env(name, fallback)`: read an environment variable (env files are already
  loaded at this point).
- `builder.merge(obj)`: JSON-force `obj` and deep-merge it into the cumulative config.
- `builder.loadConfig(path)`: load another file (any supported extension) under the FULL
  layer contract, including its own nested `configure`. Async.
- `builder.loadConfigs(globPattern)`: glob, sort matches bytewise, and load each. Async.

Builder path arguments resolve BEFORE variable resolution, so user `_vars` do not exist
yet. Only the auto-vars may appear in them: `${sousDir}`, `${sousConfDir}`,
`${sousRootPath}`, `${sousVersion}`. Any other `${name}` in a builder path is a hard error
listing the allowed names. Relative paths resolve against the directory of
`builder.currentFile`. Load cycles (a file loading itself, directly or indirectly) are
detected and reported.

## Failure behavior

Any layer failure (JSON/YAML parse error, import error, a `configure` throw, a load cycle,
the legacy schema) halts the whole load with an error NAMING THE LAYER FILE. There is no
warn-and-skip; a broken layer never silently drops out of the merge.

## The managed 5xx layer band

`conf.d/500-*` through `conf.d/599-*` is reserved for layers the sous CLI writes on your
behalf (for example, a future `sous repo add` maintaining `conf.d/500-repos.json`).
Machine-written layers are stable, pretty-printed JSON so repeated edits produce minimal
version-control diffs. Sous never edits a hand-written primary config or a layer outside
the 5xx band, and you should not hand-edit files inside it. To override a managed value,
add a higher-sorting layer (for example `conf.d/600-overrides.json`).
