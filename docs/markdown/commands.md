# Command Reference

Every command the `sous` CLI ships, with its arguments and its own flags. Run any of them with
`--help` for the same information in your terminal.

## The flags every project command shares

These four locate the configuration and are accepted by every command that works on a project.
They are listed once here rather than repeated in every table below.

| Flag | What it does |
|------|--------------|
| `-c, --config <path>` | Path to a sous config file, or to a directory holding one. Overrides `.sous/` discovery |
| `--sous-config <path>` | Alias of `--config` |
| `--sous-dir <path>` | Path to the `.sous` directory to use, overriding walk-up discovery |
| `--sous-confd <path>` | Path to the `conf.d/` drop-in layer directory, overriding `<sousDir>/conf.d` |

The environment variables `SOUS_CONFIG`, `SOUS_DIR` and `SOUS_CONFD` do the same jobs; a flag
beats the matching variable, and both beat walk-up discovery.
[Discovery and overrides](config-discovery.md) covers the precedence in full.

?> Three commands take none of these, because they run inside a recipe repository rather than
inside a project: `sous repo init`, `sous repo release` and `sous repo submit`. A recipe
repository has no `.sous/` directory to discover.

## Building

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous build` | none | `--no-prune`, `--no-compile`, `--rebuild`, `--dry-run`, `--strict`, `-w, --watch` |
| `sous compile` | none | `--strict`, `--rebuild`, `--dry-run`, `-w, --watch` |
| `sous prune` | none | `--dry-run` |
| `sous clear` | none | `-f, --force` |
| `sous launch` | `TOOL...` | `--no-build`, `--continuous` |

`build` is compile plus prune, and is the command you want almost always. `--rebuild` ignores
cached hashes and reprocesses every output; `--strict` fails on the first compilation error
rather than reporting and continuing; `--watch` rebuilds on every change to a source file, a
config layer, or a linked recipe checkout.

`clear` deletes every file and directory sous has written for the project, and asks first unless
you pass `--force`. Neither `prune` nor `clear` ever reaches into a linked checkout or the
machine-wide recipe store.

`launch` builds and then spawns a coding agent configured under `tools` in your config. Any
argument it does not recognize is forwarded to the tool. A flag that collides with one of sous's
own goes after a bare `--`, which forwards everything following it verbatim:

```bash
sous launch claude --resume
sous launch claude -- -c
```

## Inspecting the configuration

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous config show` | none | none |
| `sous config get` | `PATH` | `--layers` |
| `sous config validate` | none | none |

`show` and `get` write machine-readable output to standard output, with the decorative header and
any error block routed to standard error, so `sous config show | jq` works even when the config is
broken. `PATH` is a dot-path with `[n]` for array indices, such as
`compilation.targets[0].entryPoint`, and `--layers` prints one `old -> new` line per config layer
that changed the value. `validate` runs the resolvers that schema validation alone cannot,
surfacing reference cycles and undefined `${var}` references.

See [Inspecting and validating](config-inspection.md).

## Repositories

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous repo add` | `URL` | `--name <name>`, `--provider github\|gitlab\|file`, `--trust`, `--dry-run` |
| `sous repo list` | none | none |
| `sous repo search` | `TEXT` | `--limit <n>` (default 25) |
| `sous repo gc` | none | `--max-bytes <n>`, `--dry-run` |
| `sous repo link` | `REPO` `[PATH]` | `--global`, `--dry-run` |
| `sous repo unlink` | `REPO` | `--global`, `--dry-run` |
| `sous subscribe` | `REF` | `--prerelease`, `--always-pull`, `--trust`, `--dry-run` |
| `sous unsubscribe` | `REF` | `--dry-run` |

`repo add` is the trust ceremony; it asks inline, and `--trust` is how a run with no terminal
acknowledges instead. `URL` may be an address or an absolute path to a repository on this
machine. `list` and `search` read only what is already cached, so both work offline and neither
downloads anything.

`REF` is a ref: `namespace`, `namespace/recipe`, either with an `@<range>`, and optionally
qualified with `repo:`. See
[Refs: how anything is named](repositories-file-formats.md#refs-how-anything-is-named).

`repo link` with no `PATH` clones the repository into `.sous/repos/<owner>/<name>`, or into
`$SOUS_HOME/repos/<owner>/<name>` with `--global`; with a `PATH` it links an existing checkout
and clones nothing.

## Authoring a repository

These three run inside a recipe repository and take none of the config-locating flags.

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous repo init` | `[DIRECTORY]` | `--name <name>`, `--namespace <name>`, `--force`, `--dry-run` |
| `sous repo release` | none | `--check`, `--bump patch\|minor\|major\|prerelease`, `--recipe <ns/name>`, `--tag`, `--push`, `--dry-run` |
| `sous repo submit` | none | `--title <text>`, `--body <text>`, `--draft`, `--dry-run` |

`--check` cannot be combined with `--tag` or `--bump`, and `--push` only has an effect alongside
`--tag`. See [Authoring a repository](repositories-authoring.md).

## Variables

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous vars` | `[NAME]` | `--file <path>` |
| `sous vars ask` | `[NAME]` | `--all`, `--file <path>`, `--dry-run` |

`sous vars` with no argument lists every variable in play; with a name it shows that one in full,
including every environment variable on the resolution ladder. `NAME` is a bare variable name or
a full `namespace/recipe.name` key. `--file` reads definitions from a standalone definitions file
instead of the project's subscribed recipes.

See [Recipe variables](repositories-variables.md).

## Exit behavior

Every command exits non-zero on a configuration problem and prints a plain-language error block
naming the file at fault. There is no warn-and-continue: a broken config halts sous rather than
producing output built on a guess.
