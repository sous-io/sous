# Inspecting and Validating

## The validation pipeline

Every command validates the config on load, in this order:

1. The kernel merges all layers (any layer failure names the file).
2. The legacy-schema guard rejects the removed multi-project keys (`projects`,
   `defaultProject`) with a migration message.
3. A strict schema validates the merged result: unknown keys at ANY level are rejected with the
   full path and a typo hint; a target must have exactly one of `entryPoint` / `entryGlob`;
   `version`, when present, must be `1` (anything else fails as unsupported by this sous
   version).
4. Variable resolution and substitution run as values are used; `xcv config validate` runs them
   eagerly (below).

Validation applies to the MERGED config only. A `conf.d/` fragment on its own does not need to
be a complete config; it only needs to use schema-known keys.

## The JSON Schema artifact

Sous ships `sous.config.schema.json` at the package root (generated from the same schema that
validates at load time). A JSON config can bind it for editor autocompletion and external
tooling:

```json
{ "$schema": "./path/to/sous.config.schema.json" }
```

The `$schema` key is accepted at the top level and ignored by sous itself.

## xcv config show

Prints the full merged config as pretty JSON: the config as written, after layer merging but
BEFORE variable resolution. Output is machine-readable by contract: the decorative header and
any error text go to stderr, so `xcv config show | jq .` always receives either valid JSON or
nothing. Colorized only when stdout is a TTY.

## xcv config get

Prints one value by dot-path, with `[n]` for array indices:

```bash
xcv config get name
xcv config get compilation.targets[0].entryPoint
```

Scalars print raw (no quotes); objects and arrays print as pretty JSON. A missing path exits
non-zero with a message on stderr.

`--layers` adds provenance: for each loaded layer whose cumulative merge CHANGED the value at
that path, one line prints the layer file and the old and new values, starting from `(unset)`.
This answers "which file set this?" directly:

```bash
xcv config get tools.claude.command --layers
```

## xcv config validate

Runs the whole pipeline eagerly: discovery, kernel merge, legacy guard, schema, then FULL
variable resolution including compilation, tools and watch config. This surfaces the errors
schema validation alone cannot: variable cycles, undefined `${refs}`, and bad substitutions in
entry points and destinations. On success it prints a short summary (config file, layer count,
target count, tools) and exits 0; on failure it prints the `ConfigError` and exits non-zero.

All three commands honor the same config-locating flags and env vars as every other command
(`--config`/`-c`/`--sous-config`, `--sous-dir`, `--sous-confd`, `SOUS_CONFIG`, `SOUS_DIR`,
`SOUS_CONFD`); see [Discovery and overrides](config-discovery.md).
