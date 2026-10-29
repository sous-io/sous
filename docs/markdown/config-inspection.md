# Inspecting and Validating

## The validation pipeline

Every command builds and validates the config before it does its work, in this order:

1. The contributors build the config (any config file failure names the file; see
   [Layers and merging](config-layers.md)). Config expressions are evaluated inside each file's
   contributor.
2. The legacy-schema guard rejects the removed multi-project keys (`projects`,
   `defaultProject`) with a migration message.
3. The built config is checked against the schema of every config key. Each plugin registers the
   keys it owns, with their schema and defaults, so a key no loaded plugin registers is unknown.
   Unknown keys at ANY level are rejected with the full path and a typo hint; a target must have
   exactly one of `entryPoint`, `entryGlob` or `content`; `version`, when present, must be `1`
   (anything else fails as unsupported by this sous version). Validation runs after values
   resolve, so a value built from a variable is checked.
4. Variable resolution and substitution run as values are used; `sous config validate` runs them
   eagerly (below).

Validation applies to the BUILT config only. A `conf.d/` file on its own does not need to be a
complete config; it only needs to use known keys.

## The JSON Schema artifact

Sous ships `sous.config.schema.json` at the package root (generated from the same schema that
validates at load time).

?> This describes sous 0.2.x, where one fixed schema held every key. In 1.0 each plugin registers
its own keys ([S2](architecture/specifications/S2-config-building.md#plugins-add-config-keys)), so a
key added by a plugin the published artifact does not know may be flagged by an editor; how the
artifact covers plugin keys is not settled. A JSON config can bind it for editor autocompletion and external
tooling:

```json
{ "$schema": "./path/to/sous.config.schema.json" }
```

The `$schema` key is accepted at the top level and ignored by sous itself. A config written by
`sous init --format json` binds it to the same artifact as published on GitHub for the running
version, so an editor resolves it without a path into the installed package; point it at the
package-local copy instead when the editor should work offline.

## sous config show

Prints the full built config as pretty JSON, with config expressions evaluated: what sous will do on
this machine. Output is machine-readable by contract: the decorative header and any error text go to
stderr, so `sous config show | jq .` always receives either valid JSON or nothing. Colorized only
when stdout is a TTY.

- `--layers` shows each contributor's change, in order: for a config file, the expression as
  written, what it evaluated to and the values it read; for code, each builder operation it ran and
  the primitive patches it made. It ends with the result and the number of passes the config took to
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

`--layers` adds provenance: every contributor that changed the value at that path, in order, with
its change. This answers "which file or plugin set this?" directly:

```text
$ sous config get subscriptions."tool-usage/automated-browser-tasks".enabled --layers
conf.d/510-subscriptions.jsonc   (not set)
conf.d/610-mac.jsonc             { "$if": { "expr": "host.platform == 'darwin'", "then": false } }
                                 → false   (host.platform = "darwin")
result                           false     (settled after 1 pass)
```

`sous plugins show` lists every plugin with what it registered, wrapped or replaced, and
`--timings` on any command prints how long each stage and each contributor took.

## sous config validate

Runs the whole pipeline eagerly: discovery, the config build, legacy guard, schema, then FULL
variable resolution including compilation, tools and watch config. This surfaces the errors
schema validation alone cannot: variable cycles, undefined `${refs}`, and bad substitutions in
entry points and destinations. On success it prints a short summary (config file, config file count,
target count, tools) and exits 0; on failure it prints the `ConfigError` and exits non-zero.

All three commands honor the same config-locating flags and env vars as every other command
(`--config`/`-c`/`--sous-config`, `--sous-dir`, `--sous-confd`, `SOUS_CONFIG`, `SOUS_DIR`,
`SOUS_CONFD`); see [Discovery and overrides](config-discovery.md).
