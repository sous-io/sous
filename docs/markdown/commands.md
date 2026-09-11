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

## Flags common to many commands

A few flags mean the same thing wherever they appear, so the tables below name them without
explaining them again.

| Flag | What it does |
|------|--------------|
| `-y, --yes` | Answers yes to every confirmation the command would ask. `--force` and `-f` are the same flag; so is `--trust` on the commands that trust a repository |
| `--non-interactive` | The opposite instruction: never ask anything. A run that would have prompted fails instead, naming the question and the flag that would have answered it |
| `--dry-run` | Prints what the command would do and writes, downloads and asks nothing |
| `-h, --help` | Prints the command's own help and exits |

`sous clear` is the one command whose primary spelling is `--force` rather than `--yes`, because
that is the spelling it has always had; `-y` and `--yes` are aliases of it there and behave
identically. `sous repo init --force` is a different flag with a different meaning (overwrite an
existing repository), and it is not a confirmation.

Help is available in four forms, all of which draw the same screen:

```bash
sous --help
sous repo add --help
sous repo add -h
sous help repo add
```

`sous help` on its own lists the topics and commands, and `sous help <topic>` lists one topic's
commands.

## Singular and plural

Every topic answers to both spellings of its name, so nothing hinges on remembering which one
sous prefers: `repo` and `repos`, `subscription` and `subscriptions`, `var` and `vars`, `config`
and `configs`. The tables below print the spelling `sous --help` shows; the other one runs
exactly the same command.

## Building

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous build` | none | `--no-prune`, `--no-compile`, `--rebuild`, `--dry-run`, `--strict`, `-w, --watch` |
| `sous compile` | none | `--strict`, `--rebuild`, `--dry-run`, `-w, --watch` |
| `sous prune` | none | `--dry-run` |
| `sous clear` | none | `-f, --force` (also `-y, --yes`) |
| `sous launch` | `TOOL...` | `--no-build`, `--continuous` |

`build` is compile plus prune, and is the command you want almost always. `--rebuild` ignores
cached hashes and reprocesses every output; `--strict` fails on the first compilation error
rather than reporting and continuing; `--watch` rebuilds on every change to a source file, a
config layer, or a linked recipe checkout.

`clear` deletes every file and directory sous has written for the project, and asks first unless
you pass `--force` (or `-y`, or `--yes`). Neither `prune` nor `clear` ever reaches into a linked checkout or the
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
| `sous repo add` | `URL` | `--name <name>`, `--provider github\|gitlab\|file`, `-y, --yes` (also `--trust`), `--dry-run` |
| `sous repo list` | none | `--verbose` |
| `sous repo search` | `TEXT` | `--limit <n>` (default 25) |
| `sous repo gc` | none | `--max-bytes <n>`, `--dry-run` |
| `sous repo link` | `REPO` `[PATH]` | `--global`, `-y, --yes` (also `--trust`), `--dry-run` |
| `sous repo unlink` | `REPO` | `--global`, `--dry-run` |

`repo add` is the trust ceremony; it asks inline, and the confirmation flag is how a run with no
terminal acknowledges instead. `--trust` is the spelling the ceremony reads best with, and it is
the same flag as `-y`, `--yes`, `-f` and `--force`. `URL` may be an address or an absolute path to a repository on this
machine. `list` and `search` read only what is already cached, so both work offline and neither
downloads anything.

`repo search` is also a top-level `sous search`, because searching is how you find something to
subscribe to before you know what any of it is called.

## Subscriptions

| Command | Arguments | Own flags |
|---------|-----------|-----------|
| `sous subscription list` | none | none |
| `sous subscription add` | `REF` | `--prerelease`, `--always-pull`, `-y, --yes` (also `--trust`), `--accept-first`, `--answer <name>=<value>`, `--answers-file <path>`, `--dry-run` |
| `sous subscription remove` | `REF` | `--dry-run` |

`sous subscribe` and `sous unsubscribe` are the original spellings of `subscription add` and
`subscription remove`, and both still work.

`REF` is a ref: `namespace`, `namespace/recipe`, either with an `@<range>`, and optionally
qualified with `repo:`. See
[Refs: how anything is named](repositories-file-formats.md#refs-how-anything-is-named).

`subscription add --dry-run` installs nothing and, after the plan, prints every question the
recipes would ask: what each variable is for, where its answer would be stored, and whether
anything answers it already. `--answer <name>=<value>`, repeated, answers those questions ahead of
time, and `--answers-file <path>` reads the same pairs from a YAML or JSON file; together they are
how a run with no terminal subscribes to a recipe that asks questions. See
[Answering questions ahead of time](repositories-consuming.md#answering-questions-ahead-of-time).

`subscription list` reads the config and the lockfile only, so it works offline. It reports every
subscription the project declares, switched-off ones included, with the range it resolves within,
the versions the lockfile pins for it, where it came from, and whether it is on.

Removing the `core` subscription sous provides itself records `core: { enabled: false }` in the
managed subscriptions layer rather than deleting an entry, because the default would otherwise
come back on the next run. Adding it back clears the opt-out. Either way the `sous-recipes`
repository stays trusted and keeps appearing in `repo list` as built in.

`repo link` with no `PATH` clones the repository into `.sous/repos/<owner>/<name>`, or into
`$SOUS_HOME/repos/<owner>/<name>` with `--global`; with a `PATH` it links an existing checkout
and clones nothing. `REPO` is normally the short name of a repository this project has already
added. Naming one by URL instead runs the same trust ceremony `repo add` runs, since a linked
repository's recipes are read with no version, lockfile or hash check; it asks inline, and
`--trust` (or any other spelling of the confirmation flag) acknowledges instead for a run with no
terminal.

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
| `sous vars list` | none | `--file <path>` |
| `sous vars show` | `NAME` | `--file <path>` |
| `sous vars ask` | `[NAME]` | `--all`, `--file <path>`, `--answer <name>=<value>`, `--answers-file <path>`, `--dry-run` |

`vars list` prints every variable in play, with the environment variable that answered each one
and where the value came from. `vars show` prints one variable in full, including every
environment variable on the resolution ladder and which rung answered. `NAME` is a bare variable
name or a full `namespace/recipe.name` key. `--file` reads definitions from a standalone
definitions file instead of the project's subscribed recipes. `--answer` and `--answers-file`
answer questions ahead of time, exactly as they do on `subscription add`.

Bare `sous vars` is shorthand for `vars list`, and `sous vars <name>` for `vars show <name>`. A
variable whose name is also a subcommand name (`list`, `show` or `ask`) has to be reached the
long way, as `sous vars show list`.

See [Recipe variables](repositories-variables.md).

## Tables and terminal width

Every listing sous prints fits itself to the terminal it is running in. Columns shrink toward
their minimums, a long description wraps onto more lines, and a path or a URL is cut in the
middle so the host and the last segment both survive. On a terminal too narrow to hold
everything, the columns that matter least step aside, and one line under the table names them:
`Hidden at this width: URL. Widen the terminal to see it.` Nothing is hidden when the output is
not a terminal (a pipe, a file, a CI log), which is laid out at a fixed width instead, so a
recorded run always shows every column.

`sous repo list --verbose` adds the namespaces each repository publishes, on a dim line under
that repository's row.

## Exit behavior

Every command exits non-zero on a configuration problem and prints a plain-language error block
naming the file at fault. There is no warn-and-continue: a broken config halts sous rather than
producing output built on a guess.
