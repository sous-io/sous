# Command Reference

Every command the `sous` CLI ships, with its arguments, its own flags and one example. The same text is in your
terminal: `sous <command> --help`, or `sous help <command>`. Flags that mean the same thing everywhere are
explained once, below, and only named under the commands that take them.

## Flags that locate the configuration

| Flag | What it does |
|------|--------------|
| `-c, --config <path>` | A sous config file, or a directory holding one. Overrides `.sous/` discovery |
| `--sous-config <path>` | Alias of `--config` |
| `--sous-dir <path>` | The `.sous` directory to use, overriding walk-up discovery |
| `--sous-confd <path>` | The `conf.d/` drop-in layer directory, overriding `<sousDir>/conf.d` |

Every command that works on a project takes these four. `SOUS_CONFIG`, `SOUS_DIR` and `SOUS_CONFD` do the same;
a flag beats its variable, and both beat walk-up discovery. See [Discovery and overrides](config-discovery.md).

?> `repo init`, `repo release` and `repo submit` take none of these. They run inside a recipe repository, which
has no `.sous/` directory to discover. All three still take `--non-interactive`.

## Flags that answer questions

| Flag | What it does |
|------|--------------|
| `-y, --yes` | Answer yes to every confirmation the command would ask. `-f` and `--force` are the same flag, and so is `--trust` on the commands that trust a repository |
| `--non-interactive` | Never ask anything. A run that would have prompted fails instead, naming the question and the flag that would have answered it |
| `--dry-run` | Print what the command would do, and write, download and ask nothing |
| `-h, --help` | Print this command's help and exit |

`sous clear` spells its confirmation `-f, --force` first, with `-y` and `--yes` as aliases of it, and is the one
exception to the rule above: without `-f` it asks even under `--non-interactive` or `CI`, so pass `-f` whenever
you script it. `sous repo init --force` is not a confirmation; it overwrites a repository that already exists.

Sous asks only when it is attached to a terminal in both directions, was not passed `--non-interactive`, and is
not under a `CI` variable set to anything but `0`, `false`, `no` or `off`. Piping output, redirecting it to a
file and running in CI therefore do what the flag does: a run that needs an answer fails, saying why.

Help has four spellings. `sous --help` prints the root screen; `sous repo add --help`, `sous repo add -h` and
`sous help repo add` all print that one command's. `sous help` alone lists the topics and commands, and
`sous --version` prints the version, platform and Node build.

Every topic answers to both spellings of its name: `repo` and `repos`, `subscription` and `subscriptions`,
`namespace` and `namespaces`, `recipe` and `recipes`, `lock` and `locks`, `vars` and `var`, `config` and
`configs`. Three commands also answer to one word: `sous search`, `sous subscribe` and `sous unsubscribe`.

## Top-level commands

### `sous build`
Compiles this project's outputs, then removes the ones its config no longer produces. It is compile plus prune,
and the command you want almost always. Takes `--dry-run`.

- `--no-prune`, `--no-compile`: skip one half of the run.
- `--rebuild`: ignore cached hashes and reprocess every output.
- `--strict`: fail on any compilation error rather than reporting it and continuing.
- `-w, --watch`: rebuild on every change to a source file, a config layer or a linked checkout.

Example: `sous build --rebuild`

### `sous compile`
Compiles markdown templates into output files, and prunes nothing. Takes `--rebuild`, `--strict`, `--dry-run`
and `-w, --watch`, each meaning what it means on `build`. Example: `sous compile --strict`

### `sous prune`
Removes output files no longer in the current config. Takes `--dry-run` only. Example: `sous prune --dry-run`

### `sous clear`
Deletes every file and directory sous has written for the project, and asks first; `-f, --force` answers that
confirmation ahead of time. Example: `sous clear --force`

### `sous launch TOOL...`
Builds this project's outputs, then starts a coding agent configured under `tools` in its config. `--no-build`
launches without building; `--continuous` restarts the agent whenever it exits.

Any argument `launch` does not recognize is forwarded to the tool; a flag that collides with one of sous's own
goes after a bare `--`: `sous launch claude --resume`, `sous launch claude -- -c`.

Example: `sous launch claude --continuous`

### `sous search TEXT`
Searches the recipes every trusted repository publishes, by name or description; reads the cached indexes only,
so it works offline. `--limit <n>` sets how many matches to show, defaulting to 25. Also spelled
`sous repo search`. Example: `sous search task --limit 50`

### `sous help [COMMAND]`
Prints the help for sous, or for one command or topic. Works from any directory, including one with no config
above it. Example: `sous help repo add`

## config

Inspects the merged configuration. `show` and `get` write machine-readable output to standard out and route the
header and any error block to standard error, so a pipeline survives a broken config. See
[Inspecting and validating](config-inspection.md).

### `sous config show`
Prints the merged config (every `conf.d` layer merged, before variable resolution) as JSON.
Example: `sous config show | jq .compilation`

### `sous config get PATH`
Prints one value by dot-path, with `[n]` for array indices; a scalar prints raw, and an object or array prints
as pretty JSON. `--layers` adds one `old -> new` line per config layer that changed the value.
Example: `sous config get compilation.targets[0].entryPoint --layers`

### `sous config validate`
Validates the merged config: the schema first, then full variable resolution, which is what surfaces reference
cycles and undefined `${var}` references. Example: `sous config validate`

## repo

Manages the recipe repositories this project trusts; see [Consuming recipes](repositories-consuming.md).

### `sous repo add URL`
Adds a repository to this project, which is also how you trust it, and fetches its index so its recipes are
listable. `URL` is the repository's address, or the path of one on this machine. Takes `--dry-run`.

- `--name <name>`: set the short name refs will use. Defaults to the URL's last segment.
- `--provider github|gitlab|local`: name the provider, for a host the URL does not give away.
- `-y, --yes`: answer the trust question ahead of time (also `-f`, `--force`, `--trust`).

Example: `sous repo add https://github.com/sous-io/sous-recipes --name recipes`

### `sous repo remove REPO`
Stops trusting a repository, named by the short name this project records, and removes everything it brought in.
It first prints what goes with it: the entry, the subscriptions that resolve into it, the recipes those alone
held, the files the next build prunes, and the linked checkout if one points at it. Takes `-y, --yes`,
`--dry-run` and `--no-build` (remove without rebuilding). Example: `sous repo remove my-recipes --dry-run`

### `sous repo list`
Lists the repositories this project trusts, with the provider, where the entry came from, whether it is linked,
how many recipes it publishes (`not fetched` until its index has been downloaded) and its URL. `--verbose` adds
the namespaces each one publishes, on a line under its row.

```term
$ sous repo list
  Repository    Provider  Origin    Linked      Recipes  URL
  ------------  --------  --------  ------  -----------  ---------------------------------------
  sous-recipes  github    built in  no      not fetched  https://github.com/sous-io/sous-recipes
```

### `sous repo search TEXT`
Same command as `sous search`, under its own topic; takes `--limit <n>`. Example: `sous repo search browser`

### `sous repo gc`
Collects the machine-wide recipe store down to its size cap. `--max-bytes <n>` collects to that cap instead of
the one the config sets; `--dry-run` prints what it would evict. Example: `sous repo gc --max-bytes 268435456`

### `sous repo link REPO [PATH]`
Points a repository at a working copy on this machine instead of a published version. A name or URL on its own
clones it into `.sous/repos` and links the clone; a name or URL with a `PATH` links the checkout at that path; a
path alone links that checkout where it is, adding the repository first if needed. Takes `--dry-run`.

- `--global`: link for every project on this machine, sharing one checkout.
- `-y, --yes`: answer the trust question a not-yet-added repository raises (also `--trust`).

Example: `sous repo link sous-recipes ~/Projects/sous-recipes`

### `sous repo unlink REPO`
Stops reading a repository from a working copy and goes back to published versions; `REPO` is the short name as
it appears in `sous.links.json` (see [File formats](repositories-file-formats.md)). `--global` removes the
machine-wide link, not this project's; `--dry-run` prints what changes. Example: `sous repo unlink sous-recipes`

### `sous repo init [DIRECTORY]`
Creates a new recipe repository in a directory, defaulting to the current one; `--dry-run` prints the files it
would write. See [Authoring a repository](repositories-authoring.md).

- `--name <name>`: set the short name for the repository. Defaults to the directory's own name.
- `--namespace <name>`: name the one namespace to declare. Defaults to the repository's name.
- `--force`: write the scaffold over a repository that already exists.

Example: `sous repo init ./my-recipes --name team-recipes --namespace workflow`

### `sous repo release`
Publishes new versions of this repository's recipes: bump, regenerate the index, commit and tag. It plans first
and asks once, and it refuses to run until git has a commit identity in the repository (`git config user.name`
and `git config user.email`), because it commits and cuts annotated tags. Takes `-y, --yes` and `--dry-run`.

- `--namespace <ns>`, `--recipe <ns/name>`: narrow the run. Both repeat.
- `--bump patch|minor|major|prerelease`: how far to raise a changed version. Defaults to a patch step.
- `--no-bump`: raise nothing; a changed recipe that was never raised is then an error.
- `--include-unchanged`: release every recipe in scope, changed or not.
- `--tag`, `--push`: tag even on a non-default branch, and push the commit and this run's tags.
- `--check`: only validate, and fail when the committed index is out of date.
- `--ci`: the merge preset. Never bump, never ask, and fail on anything unbumped. It still needs `--yes` to
  accept the plan it prints, so a merge job runs `sous repo release --ci --yes --push`.

Example: `sous repo release --recipe workflow/task-files --bump minor --push`

### `sous repo submit`
Proposes this repository's committed changes to its maintainers. `--title <text>` defaults to the last commit's
subject and `--body <text>` to a summary sous writes; `--draft` opens the proposal as a draft, and `--dry-run`
prints the plan without sending anything. Example: `sous repo submit --title "Add a linting recipe" --draft`

## subscription

Manages which recipes this project subscribes to. `REF` is `namespace` or `namespace/recipe`, either of them
optionally carrying an `@<range>` and a `repo:` qualifier; see
[Refs](repositories-file-formats.md#refs-how-anything-is-named).

### `sous subscription add REF`
Subscribes this project to a recipe, or to a whole namespace of them, then builds the project so the recipe's
files are on disk when the command returns. Also spelled `sous subscribe`. Takes `-y, --yes`, `--no-build`, and
`--dry-run`, which also prints the questions of every recipe this machine already holds; a recipe not held here
yet is named instead, because a dry run downloads nothing.

- `--prerelease`: let prerelease versions take part in range matching.
- `--always-pull`: install a newer in-range version whenever one exists, rather than holding the lock.
- `--accept-first`: when a one-word ref matches several things, take the first one listed.
- `--answer <name>=<value>`: answer one question ahead of time. Repeat it for each answer.
- `--answers-file <path>`: read the same pairs from a YAML or JSON file. An `--answer` wins over the file.

Example: `sous subscription add workflow/task-files@^1.2.0 --answer apiUrl=https://api.example.com`

### `sous subscription remove REF`
Removes a subscription and everything only it brought in, then rebuilds so those files are gone. Also spelled
`sous unsubscribe`. Takes `--dry-run` and `--no-build`. Example: `sous subscription remove workflow/task-files`

### `sous subscription list`
Lists the subscriptions this project declares, switched-off ones included, with the range each resolves within,
the versions the lockfile pins, where it came from and whether it is on. Reads the config and the lockfile only.
Example: `sous subscription list`

## namespace

`namespace` reads the cached indexes and the lockfile, so it works offline. A trusted repository whose index has
never been fetched is named at the end of a listing, not left out.

### `sous namespace list`
Lists every namespace the trusted repositories publish, how many recipes each holds, and how much of it this
project subscribes to: all of it, some recipes, or none. Example: `sous namespace list`

### `sous namespace show REF`
Shows one namespace and every recipe in it, with the latest published version, the version this project pins,
and whether it is subscribed. `REF` is a namespace, optionally written as `repository:namespace`.
Example: `sous namespace show sous-recipes:core`

## recipe

Browses the recipes the trusted repositories publish; like `namespace`, it works offline.

### `sous recipe list`
Lists the recipes the trusted repositories publish, across every namespace, with the same per-recipe columns
`namespace show` prints. Example: `sous recipe list`

### `sous recipe show REF`
Describes one recipe completely: its repository and location, every published version, its dependencies as
declared and as resolved at release time, the questions it asks with the environment variable each answer is
stored under, and the directories its files are written into. `REF` is `namespace/recipe`, a recipe name alone,
or either with a `repository:` qualifier. Example: `sous recipe show sous-recipes:core/about-sous`

## lock

Inspects and repairs this project's lockfile; both commands work from what is on disk and fetch nothing.

### `sous lock show`
Prints what `.sous/sous.lock.json` pins: the recipe, the version, the repository it came from, and who holds it
(this project, or the recipes that require it). Example: `sous lock show`

### `sous lock rebuild`
Recomputes the whole lockfile from the subscriptions the config declares and the cached indexes, starting from
empty, so an entry nothing holds any more is dropped rather than carried through: the repair for a file that
drifted through a hand edit or a bad merge. It asks nothing, grants no trust and downloads nothing. Takes
`--dry-run`. Example: `sous lock rebuild --dry-run`

## vars

Inspects the variables this project's recipes define, and the answers they hold. `NAME` is a bare variable name
or a full `namespace/recipe.name` key. Bare `sous vars` is shorthand for `vars list` and `sous vars <name>` for
`vars show <name>`; a variable named `list`, `show` or `ask` is reached the long way, as `sous vars show list`.
See [Recipe variables](repositories-variables.md).

### `sous vars list`
Lists every variable this project's recipes define, with the environment variable that answered each one and
where the value came from. `--file <path>` reads the definitions from a standalone definitions file instead.
Example: `sous vars list --file ./questions.yaml`

### `sous vars show NAME`
Shows everything about one variable, including every environment variable on the resolution ladder and which
rung answered; takes `--file <path>`. Example: `sous vars show workflow/task-files.apiUrl`

### `sous vars ask [NAME]`
Asks the variables this project's recipes define and stores the answers in the `.sous` env files. `NAME` is a
variable, an environment variable name, a recipe, a namespace or a repository; anything larger than a variable
asks every question it publishes. Takes `--file <path>` and `--dry-run`.

- `--repo <name>`, `--namespace <name>`, `--var <name>`: narrow the run. `--var` repeats.
- `--all`: ask every variable again, including the ones already answered.
- `--accept-first`: take the first candidate when a name means more than one thing.
- `--answer <name>=<value>`, `--answers-file <path>`: as on `subscription add`.

Example: `sous vars ask --namespace workflow --var apiUrl`

## Exit behavior and error shape

A command that succeeds exits `0`. A command line sous could not parse (a missing argument, an unknown flag, a
value outside a flag's options) exits `2`. Every other failure exits `1`. A broken config halts sous rather than
producing output built on a guess. Compilation is the one place sous reports a failure and carries on;
`--strict` on `build` and `compile` turns those reports into a failed run.

A failure prints one error block, in plain language, and nothing else; a usage mistake gets the command's own
help under it, on standard error. An error sous raises names the cause and the cure:

```term
$ sous subscription add workflow --non-interactive
  Error: Sous has to ask which 'workflow' you meant, and it is not running where it can ask.
    Why: the '--non-interactive' flag was passed.
    'workflow' matched 2 things:
      sous-recipes:workflow (the whole namespace 'workflow' in the repository 'sous-recipes')
      qa:workflow (the whole namespace 'workflow' in the repository 'qa')
    Answer it ahead of time: write the full reference (for example 'sous-recipes:workflow'), or
      pass '--accept-first' to take the first candidate listed above.
```

No expected failure prints a stack trace. A failure sous did not expect prints the message and one more sentence
asking you to set `SOUS_DEBUG=1` and run the command again. Set `SOUS_DEBUG` to anything but `0`, `false`, `no`
or `off` and every reported failure prints its stack to standard error underneath the message:
`SOUS_DEBUG=1 sous build`. Nothing else changes when it is set.

Every listing fits itself to the terminal it runs in: columns shrink, descriptions wrap, and a path or URL is
cut in the middle so the host and the last segment both survive. On a terminal too narrow, the least important
columns step aside and a line under the table names them; nothing is hidden when the output is not a terminal.
