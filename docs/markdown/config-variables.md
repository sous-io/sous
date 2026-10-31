# Variables

How `${var}` references resolve inside a sous config.

?> Template files use LiquidJS double-brace syntax instead; that is a different stage entirely.
This page is about the config side only.

## The scope chain

Later scopes override earlier ones:

```
auto-vars  ->  recipe answers  ->  _env scope  ->  _vars  ->  compilation._vars  ->  target._vars  ->  output._vars
```

`_vars` may be set at four levels, each inheriting the levels above it, inner values winning:

```text
root _vars
└── compilation._vars
    └── compilation.targets[]._vars
        └── targets[].outputs[]._vars
```

So a target var may reference a top-level var, and an output var may override both for that output
only. A [config expression](configuration.md#config-expressions) sees the `_vars` of every level
that contains it, and no others; an expression under `subscriptions`, `repos` or any other top-level
key sees only the root `_vars`. Recipe outputs also get a scope per recipe, holding that recipe's
answers (see [Recipe variables](repositories-variables.md)).

## Auto-vars

Always injected first, before `_env` and `_vars`:

| Variable | Value |
|----------|-------|
| `projectRoot` | the project root: the directory that holds `.sous/` (see [The project root](config-discovery.md#the-project-root)) |
| `sousDir` | the discovered `.sous/` directory holding the active config |
| `sousConfDir` | the `conf.d/` drop-in directory for the active config |
| `sousConfigPath` | absolute path of the active primary config file |
| `sousRootPath` | absolute path of the sous CLI install directory |
| `sousVersion` | the sous CLI version string |
| `sousTemplatePath` | absolute path of the `.tpl.` file being rendered (render time only) |
| `sousTemplateDir` | directory of the `.tpl.` file being rendered (render time only) |

!> Sous sets `projectRoot`. Setting it in any `_vars` block is an error saying so. A config that
wrote `projectRoot: "${sousDir}/.."` before 1.0 drops that line; every `${projectRoot}` keeps
working.

The `sous*` namespace is reserved: defining any var whose name starts with `sous` earns a
warning and risks colliding with a future auto-var.

## _env

The top-level-only `_env` block maps config var names to environment variable names:
`_env: { userHome: "HOME" }` makes `${userHome}` available everywhere. Values come from the real
shell environment, `.sous/.env.local`, or `.sous/.env` (first writer wins, in that order). A
mapped env var that is not set anywhere is a hard `ConfigError` telling you which file to define
it in.

## Variables set in a later file

A [config expression](configuration.md#config-expressions) always sees a variable's final value,
even when a later file sets it. Sous notes every variable an expression reads, and when that
variable's value changes, it applies the file again
([Layers and merging](config-layers.md#load-order-and-why-your-files-win)):

```text
Files: sous.config (machineRole: laptop) → 610-browser ($if machineRole == 'laptop') → 700-ci (machineRole: ci)

610-browser reads machineRole → "laptop" → enabled: true; 700-ci then sets "ci"
610-browser is applied again: machineRole is now "ci" → enabled: false
nothing it read changed → done
```

A variable still unknown when the config settles is an error naming it.

## Variables that refer to other variables

A variable may refer to others in the same `_vars` block, in any order. Sous resolves every entry
whose `${refs}` are all known, then tries the rest again, until nothing more resolves. Declaration
order therefore never matters; `{ file: "${root}/x", root:
"/data" }` resolves as readily as the reverse.

If entries remain unresolved at the end, that is a hard `ConfigError`. The message
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
are normalized after substitution, so a path such as `${sousDir}/../docs` collapses to the real
directory. This matters: prune compares tracked outputs against `destinationDir` by
string prefix, and watch mode matches event paths against watched entries; both need the
normalized form.

## Special variables sous reads

Two ordinary `_vars` entries change sous's own behavior when present:

- `stateFilePath`: overrides where the build state file is written (default
  `<sousDir>/sous.state.json`)
- `pidFilePath`: overrides where the watch-mode PID file is written (default
  `<sousDir>/sous.pid`)
