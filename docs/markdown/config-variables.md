# Variables

How `${var}` references resolve inside a sous config.

?> Template files use LiquidJS double-brace syntax instead; that is a different stage entirely.
This page is about the config side only.

## The scope chain

Later scopes override earlier ones:

```
auto-vars  ->  _env scope  ->  _vars  ->  compilation._vars  ->  target._vars  ->  output._vars
```

Nested `_vars` blocks (on `compilation`, on a target, on an output) resolve with their parent
scope inherited, so a target var may reference a top-level var, and an output var may override
both for that output only.

## Auto-vars

Always injected first, before `_env` and `_vars`:

| Variable | Value |
|----------|-------|
| `sousDir` | the discovered `.sous/` directory holding the active config |
| `sousConfDir` | the `conf.d/` drop-in directory for the active config |
| `sousConfigPath` | absolute path of the active primary config file |
| `sousRootPath` | absolute path of the sous CLI install directory |
| `sousVersion` | the sous CLI version string |
| `sousTemplatePath` | absolute path of the `.tpl.` file being rendered (render time only) |
| `sousTemplateDir` | directory of the `.tpl.` file being rendered (render time only) |

The `sous*` namespace is reserved: defining any var whose name starts with `sous` earns a
warning and risks colliding with a future auto-var.

## _env

The top-level-only `_env` block maps config var names to environment variable names:
`_env: { userHome: "HOME" }` makes `${userHome}` available everywhere. Values come from the real
shell environment, `.sous/.env.local`, or `.sous/.env` (first writer wins, in that order). A
mapped env var that is not set anywhere is a hard `ConfigError` telling you which file to define
it in.

## Fixpoint resolution

Each `_vars` block resolves by a fixpoint loop, not top-to-bottom: every round re-scans the
still-unresolved entries and finalizes any whose `${refs}` all resolve, repeating until a round
finalizes nothing. Declaration order therefore never matters; `{ file: "${root}/x", root:
"/data" }` resolves as readily as the reverse.

If entries remain unresolved when progress stops, that is a hard `ConfigError`. The message
separates:

- **Cycles**: entries that reference each other (members are named), and
- **Undefined references**: `${names}` defined nowhere (each is named along with the entries
  that need it),

and then lists the variables that ARE in scope. There is no silent fallthrough: an unresolved
`${var}` never survives into a value sous acts on. Entry points, destinations, prompt files and
similar action values additionally pass a strict substitution that fails on any leftover
reference.

## Path normalization

Absolute `entryPoint`, `entryGlob`, `globBase`, `destinationFile` and `destinationDir` values
are normalized after substitution, so the common `${sousDir}/..` idiom collapses to the real
parent directory. This matters: prune compares tracked outputs against `destinationDir` by
string prefix, and watch mode matches event paths against watched entries; both need the
normalized form.

## Special variables sous reads

Two ordinary `_vars` entries change sous's own behavior when present:

- `stateFilePath`: overrides where the build state file is written (default
  `<sousDir>/sous.state.json`)
- `pidFilePath`: overrides where the watch-mode PID file is written (default
  `<sousDir>/sous.pid`)
