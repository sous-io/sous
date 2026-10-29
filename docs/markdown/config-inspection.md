# Inspecting and Validating

## The validation pipeline

Every command builds and validates the config before it does its work, in this order:

1. Sous builds the config from every file, recipe and plugin (any config file failure names the
   file; see [Layers and merging](config-layers.md)). Config expressions are evaluated as each file
   is applied.
2. A check for the old config format rejects the removed multi-project keys (`projects`,
   `defaultProject`) with a migration message.
3. The built config is checked against the schema of every config key. Each plugin declares the
   keys it reads, with their schema and defaults, so a key no loaded plugin declares is unknown.
   Unknown keys at ANY level are rejected with the full path and a typo hint; a target must have
   exactly one of `entryPoint`, `entryGlob` or `content`; `version`, when present, must be `1`
   (anything else fails as unsupported by this sous version). Validation runs after values
   resolve, so a value built from a variable is checked.
4. Variable resolution and substitution run as values are used; `sous config validate` runs them
   eagerly (below).

Validation applies to the BUILT config only. A `conf.d/` file on its own does not need to be a
complete config; it only needs to use known keys.

## The JSON Schema artifact

Sous ships `sous.config.schema.json` at the package root, for editor autocompletion and external
tooling. A JSON config can bind it:

```json
{ "$schema": "./path/to/sous.config.schema.json" }
```

The `$schema` key is accepted at the top level and ignored by sous itself. A config written by
`sous init --format json` binds it to the same artifact as published on GitHub for the running
version, so an editor resolves it without a path into the installed package; point it at the
package-local copy instead when the editor should work offline.

?> Because each plugin declares its own config keys, the published schema file may not know a key
that a plugin adds. An editor may flag such a key even though sous accepts it; `sous config validate`
is the check that counts.

## sous config show

Prints the full built config as pretty JSON, with config expressions evaluated: what sous will do on
this machine. Output is machine-readable by contract: the decorative header and any error text go to
stderr, so `sous config show | jq .` always receives either valid JSON or nothing. Colorized only
when stdout is a TTY.

- `--layers` shows each change, in order, and what made it (a file, a recipe or a plugin): for a
  config file, the expression as written, what it evaluated to and the values it read; for code,
  each builder operation it ran and the primitive patches it made
  ([Patches](config-layers.md#patches) explains both). It ends with the result and the number of passes the config took to
  settle.
- `--raw` prints each config file as written, in order.

```text
confd/620-no-diagrams.js
  removeWhere compilation.targets                  ← a builder operation
    removeIndex compilation.targets[7]             ← a primitive patch
```

## sous config get

Prints one value by dot-path, with `[n]` for array indices:

```bash
sous config get name
sous config get compilation.targets[0].entryPoint
```

Scalars print raw (no quotes); objects and arrays print as pretty JSON. A missing path exits
non-zero with a message on stderr.

`--layers` adds where the value came from: every file, recipe or plugin that changed the value at
that path, in order, with its change. This answers "which file or plugin set this?" directly:

```text
$ sous config get subscriptions."tool-usage/automated-browser-tasks".enabled --layers
conf.d/510-subscriptions.jsonc   (not set)
conf.d/610-mac.jsonc             { "$if": { "expr": "host.platform == 'darwin'", "then": false } }
                                 → false   (host.platform = "darwin")
result                           false     (settled after 1 pass)
```

`sous plugins show` lists every plugin and what it adds or replaces, and `--timings` on any command
prints how long each step took, each config file included.

## sous config validate

Runs every check above at once: discovery, the config build, the old-format check, schema, then FULL
variable resolution including compilation, tools and watch config. This surfaces the errors
schema validation alone cannot: variable cycles, undefined `${refs}`, and bad substitutions in
entry points and destinations. On success it prints a short summary of the config and exits 0; on failure it prints the `ConfigError` and exits non-zero.

All three commands honor the same config-locating flags and env vars as every other command; see
[Discovery and overrides](config-discovery.md).
