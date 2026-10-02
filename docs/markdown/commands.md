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
has no `.sous/` directory to discover. All three still take `--non-interactive`. `repo submit` may also be run
from a project, which it finds by walking up from the working directory.

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

Sous asks a question only when it can; piping output, redirecting it to a file and running in CI therefore do
what `--non-interactive` does, and a run that needs an answer fails saying why. The exact conditions are listed
under [When sous cannot ask](repositories-consuming.md#when-sous-cannot-ask).

Help has four spellings. `sous --help` prints the root screen; `sous repo add --help`, `sous repo add -h` and
`sous help repo add` all print that one command's. `sous help` alone lists the topics and commands, and
`sous --version` prints the version alone, as `v1.2.3`; `sous --version --verbose` adds the package name, where
it is installed, the platform and the Node build under it.

## Flags that browse

Every command that shows published versions takes the same two flags: `sous recipe list`, `sous recipe show`,
`sous namespace list`, `sous namespace show`, `sous repo list`, `sous repo search` (and `sous search`) and
`sous subscription list`. The flags combine.

| Flag | What it does |
|------|--------------|
| `--latest` | Read each repository's index from upstream instead of the cache. `--remote` is the same flag. What it fetches is never written to the cache; a repository that cannot be reached is shown from the cache and named as not checked |
| `--installed` | Show only what this project has installed, at the version its lockfile pins. A recipe whose repository is linked is marked `linked`, because builds read it from the checkout rather than the pinned version |

Without either flag a browsing command reads only the cached indexes, so it works offline and fast.
`sous recipe list --installed --latest` is the out-of-date view: each installed recipe with upstream's newest
version beside the installed one. With `--installed`, `recipe show` and `namespace show` look the reference up
among installed recipes only, and a reference to something published but not installed is an error saying so.

Every topic answers to both spellings of its name: `repo` and `repos`, `subscription` and `subscriptions`,
`namespace` and `namespaces`, `recipe` and `recipes`, `lock` and `locks`, `vars` and `var`, `config` and
`configs`. Three commands also answer to one word: `sous search`, `sous subscribe` and `sous unsubscribe`.

## Top-level commands

### `sous init [DIRECTORY]`
Sets a project up for sous: writes its `.sous/` directory, then runs the first build. It is the one command that
runs before a config exists, and the starting point for a project that has never used sous. It writes a commented
primary config, a starter prompt at `.sous/memories/AGENTS.tpl.md` that the config compiles to `AGENTS.md` at the
project root (it holds the one line, `@#memories/**/*.md`, that includes every memory your subscribed recipes publish), `.sous/.env` and `.sous/.env.local.example`, and the sous-managed block in `.sous/.gitignore`. A
project that has a `package.json` also gains `@sous-io/sous` in its `devDependencies`, at exactly the running
version, unless it already depends on it; nothing is installed, so run your package manager's install afterwards.
The first build compiles the starter prompt and the `core` skills, and pins them in `.sous/sous.lock.json`.

A project whose `.sous/` already holds a primary config is refused, and nothing is written. Setting up a directory
inside a project that is already set up is a question rather than an error, since a subproject may want its own
instructions; `-y, --yes` answers it ahead of time, and a run with no terminal fails naming that flag.

- `DIRECTORY`: the project directory to set up; the current one by default. `--sous-dir` and `SOUS_DIR` also say
  where, when no directory is given.
- `--format <js|json>`: which config to write, `js` by default. The JSON config carries `$schema`, bound to the
  schema artifact published for the running sous version.
- `--name <name>`: the display name written into the config; the directory's own name by default.
- `--no-build`: write the setup without running the first build.
- `--dry-run`: print the files that would be written without writing them.

Example: `sous init --format json`

### `sous build`
Compiles this project's outputs, then removes the ones its config no longer produces. It is compile plus prune,
and the command you want almost always. Takes `--dry-run`.

- `--no-prune`, `--no-compile`: skip one half of the run.
- `--rebuild`: ignore cached hashes and reprocess every output.
- `--strict`: treat compile warnings as errors (a `.tpl.` file copied without being rendered, a git branch the
  runtime context could not read).
- `-w, --watch`: rebuild on every change to a source file, a config layer or a linked checkout.

Before it compiles, a build prepares the project's recipes: it seeds the core recipe, pins any subscription the
lockfile does not pin yet, restores whatever the store on this machine is missing, and checks upstream for the
repositories that ask for newer versions. Every command that builds (`init`, `build`, `launch`, `prune`,
`repo remove`, `repo unlink`, `subscription add`, `subscription remove`, `subscription update`) runs this same
build, so each one prints the same things.

A compile error (a missing or circular include, a line that looks like an include but cannot be read as one, a
template that fails to render, a file sous cannot read) fails the build. Every target is still compiled and every error is listed, then the build exits `1`. An output whose
target had an error is not written, so the copy from the last good build stays in place.

A build also warns about every memory an active recipe publishes that no output includes, naming the line to add
(`@#memories/**/*.md`) and the `recipes.memories.exclude` opt-out; see
[Recipe memories](repositories-consuming.md#recipe-memories).

A build also lists each recipe this project uses that has a newer version within the range
declared for it, beside the version pinned. It moves no pin; only always-pull moves one. The build reads upstream
for this at most once per freshness window (`store.freshnessSeconds`, five minutes by default), gives a
repository three seconds to answer, and otherwise answers from the cached index without a word about the
failed check.

Example: `sous build --rebuild`

### `sous compile`
Compiles markdown templates into output files, and prunes nothing. Takes `--rebuild`, `--strict`, `--dry-run`
and `-w, --watch`, each meaning what it means on `build`, and exits `1` after a compile error the way `build`
does. It does not prepare the recipes first. Example: `sous compile --strict`

### `sous prune`
Removes output files no longer in the current config. It prepares the recipes first, as `build` does, because
what counts as current depends on the recipes the lockfile pins. Takes `--dry-run` only. Example:
`sous prune --dry-run`

### `sous clear`
Deletes every file and directory sous has written for the project, and asks first; `-f, --force` answers that
confirmation ahead of time. Example: `sous clear --force`

### `sous launch TOOL...`
Builds this project's outputs, then starts a coding agent configured under `tools` in its config. A build that
fails starts nothing and exits `1`. `--no-build` launches without building; `--continuous` restarts the agent
whenever it exits.

Any argument `launch` does not recognize is forwarded to the tool; a flag that collides with one of sous's own
goes after a bare `--`: `sous launch claude --resume`, `sous launch claude -- -c`.

Example: `sous launch claude --continuous`

### `sous search TEXT`
Searches the recipes every trusted repository publishes, by name or description; reads the cached indexes only,
so it works offline. `--limit <n>` sets how many matches to show, defaulting to 25. Takes the
[browsing flags](#flags-that-browse): `--latest` searches the indexes upstream serves, and `--installed` searches
only installed recipes and adds an Installed column. Also spelled `sous repo search`.
Example: `sous search task --limit 50`

### `sous update`
Updates sous itself: the global install, this project's own install, or both, each through the package manager
that installed it. It works outside a project too, and it always runs in the copy you invoked, never handed off
to the project's own. Every plan is printed before anything is installed, and each install asks its own
question. After a project update the new copy builds the project, so the lockfile pins the core recipe at the new
version. A project config this copy cannot load is one warning, not a stop. Takes `-y, --yes` and `--dry-run`
(which also prints the command each install would run). See [Updating](README.md#updating).

- `--major`: install the newest published version, whatever its major. By default each install moves to the
  newest version in its current major, and never down.
- `--version <version|range|tag>`: install exactly this version, the newest in this range, or the one this
  dist-tag names. This is how you downgrade.
- `--prerelease`, `--no-prerelease`: count prerelease versions as candidates, or not. On by default when the
  installed version is a prerelease. `--pre` is the same flag.
- `--global`, `--project`: update only that install.
- `--no-build`: update the project install without building the project afterwards.

`--major` and `--version` exclude each other, and so do `--global` and `--project`.

Example: `sous update --version next --dry-run`

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

Manages the recipe repositories this project trusts; see [Repositories](repositories.md) for the model and
[Consuming recipes](repositories-consuming.md) for the workflow.

### `sous repo add URL`
Adds a repository to this project, which is also how you trust it, and fetches its index so its recipes are
listable. `URL` is the repository's address, or the path of one on this machine. Takes `--dry-run`.

- `--name <name>`: set the short name refs will use. Defaults to the URL's last segment. (`sous repo link` on
  a path instead takes the name that checkout's own manifest suggests.)
- `--provider github|gitlab|local`: name the provider, for a host the URL does not give away; each provider's
  behaviour is in the [provider reference](repositories-providers.md).
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
the namespaces each one publishes, on a line under its row. Takes the [browsing flags](#flags-that-browse):
`--installed` keeps only the repositories something is installed from and names each installed recipe and
version on a line under its row.

```term
$ sous repo list
  Repository    Provider  Origin    Linked      Recipes  URL
  ------------  --------  --------  ------  -----------  ---------------------------------------
  sous-recipes  github    built in  no      not fetched  https://github.com/sous-io/sous-recipes
```

### `sous repo search TEXT`
Same command as `sous search`, under its own topic; takes `--limit <n>` and the
[browsing flags](#flags-that-browse). Example: `sous repo search browser --installed`

### `sous repo gc`
Collects the machine-wide recipe store down to its size cap. `--max-bytes <n>` collects to that cap instead of
the one the config sets; `--dry-run` prints what it would evict. Example: `sous repo gc --max-bytes 268435456`

### `sous repo link REPO [PATH]`
Points a repository at a working copy on this machine instead of a published version; see
[Edit a repository in place](repositories-authoring.md#edit-a-repository-in-place). A name or URL on its own
clones it into `.sous/repos` and links the clone; a name or URL with a `PATH` links the checkout at that path; a
path alone links that checkout where it is, adding the repository first if needed. Takes `--dry-run`.

A checkout that was already on disk is fetched (a fetch changes none of its files or branches) and compared with
upstream: its branch, whether that branch is merged into the default branch, and how many commits it is behind.
When upstream cannot be reached within a few seconds, a warning gives git's reason and says since when the
checkout may have diverged, and the link is still recorded. Nothing else changes the checkout unless a flag
asks for it; git carries out each step, and a step git refuses stops the command with git's own message.

- `--global`: link for every project on this machine, sharing one checkout. Changing that checkout's branch
  says it affects every project that links it.
- `--branch <name>`: switch to an existing branch, fetching it from upstream first when it is not local.
- `--create-branch <name>`: create a new branch and switch to it; git refuses a name that already exists.
- `--generate-branch`: the same, with the generated name `sous/edit-<YYYYMMDD>-<HHMM>`, which is printed.
- `--from <branch>`: the base of the new branch, fetched first. Defaults to the repository's default branch,
  not whatever is checked out, and needs `--create-branch` or `--generate-branch`.
- `--latest`: make the branch being worked from (the `--branch` target, the `--from` base, or else the default
  branch) match upstream's, leaving every other branch alone. What that would discard (uncommitted changes and
  local commits upstream lacks) is listed first, with one question; it fails when the fetch fails.
- `-y, --yes`: answer the trust question a not-yet-added repository raises and the question `--latest` asks
  (also `-f`, `--force`, `--trust`).

`--branch`, `--create-branch` and `--generate-branch` exclude each other; each flag works on a checkout linked
by path, too.

Example: `sous repo link sous-recipes ~/Projects/sous-recipes`, or `sous repo link sous-recipes
--generate-branch --latest --yes`

### `sous repo unlink REPO`
Stops reading a repository from a working copy, goes back to the versions the lockfile pins, and rebuilds the
project; `REPO` is the short name as it appears in `sous.links.json` (see
[File formats](repositories-file-formats.md)). On its own it also fetches the repository's index, with a short
timeout, and reports any newer published version the ranges allow, without moving anything; when the index
cannot be fetched in time it says it could not check. The checkout stays where it is unless `--remove` is passed.
Takes `--dry-run`, `--no-build`, `--answer` and `--answers-file`.

- `--global`: remove the machine-wide link, not this project's.
- `--update`: move this repository's pins to the newest versions their ranges allow before rebuilding. It runs
  the same code as `sous subscription update REPO`.
- `--remove`: delete the checkout as well, but only one sous cloned itself; a checkout linked by path is refused
  with an error. Uncommitted changes, commits no remote has and stashes are listed first and asked about.
- `-y, --yes`: answer every question this command asks: deleting a checkout that holds work, the update plan,
  and the trust question for a repository a newer version needs (also `--force`, `--trust`).

Example: `sous repo unlink sous-recipes --update`

### `sous repo contribute REF`
Starts a contribution to a recipe repository, or finishes one with `--finish`, by running `sous repo link`,
`sous repo submit` and `sous repo unlink` in order; see [Contributing a change](repositories-contributing.md).
`REF` names a repository, or a namespace or recipe, in which case the repository that publishes it is used.
Each step runs the real command with the flags below passed through, prints as it runs, and a failure names the
step that failed and the steps that completed. `--dry-run` prints each step and runs none. Also spelled
`sous repo contrib`.

Starting runs `sous repo link REPO --latest --generate-branch`:

- `--create-branch <name>`: start on a new branch with this name instead of a generated one.
- `--branch <name>`: work on an existing branch instead of a new one (when finishing, the branch to submit).
- `--from <branch>`: the base of the new branch; defaults to the repository's default branch.
- `--global`: the machine-wide link, sharing one checkout (when finishing, too).

Finishing looks for work no proposal carries yet (uncommitted changes, commits never pushed, or pushed commits
with no open proposal), asks whether to submit it with `sous repo submit REPO`, then runs
`sous repo unlink REPO --update`. With nothing to submit, the submit step is skipped without asking.

- `--submit`, `--no-submit`: submit without asking, or finish without submitting.
- `--title <text>`, `--body <text>`, `--draft`, `--commit`: passed through to `sous repo submit`.
- `--remove`: passed through to `sous repo unlink`, deleting the checkout sous cloned.
- `-y, --yes`: passed through to every step, and submits without asking (also `-f`, `--force`).
- `--accept-first`: when `REF` matches several things, take the first one listed.

Example: `sous repo contribute workflow/task-files`, then `sous repo contribute workflow/task-files --finish
--title "Clarify the resume steps" --body "The resume steps skipped the task file."`

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
- `--check`: only validate. It fails on a problem the release would refuse, and on a change to a recipe that
  takes no proposals (see [`submissions`](repositories-file-formats.md#the-submissions-block)), and reports,
  without failing, how merging would rewrite the committed index.
- `--ci`: the merge preset. Never bump, never ask, and fail on anything unbumped. It still needs `--yes` to
  accept the plan it prints, so a merge job runs `sous repo release --ci --yes --push`.

Example: `sous repo release --recipe workflow/task-files --bump minor --push`

### `sous repo submit [REPO]`
Proposes a recipe repository's changes to its maintainers, and follows the proposal through: it opens one,
updates it when there is more to send, reports where it stands, and starts the next one once it was merged. Run
inside a recipe repository it works there; run inside a project, `REPO` names a linked repository and the
submission runs in its checkout (with no `REPO`, the only linked repository is used, and several are a
question). Takes `-y, --yes` and `--dry-run`.

- `--title <text>`, `--body <text>`: the proposal's title and description. Both are required for a new
  proposal, and asked for at a terminal when missing; on an open proposal they are optional and replace its own.
  The body is followed by a changelog sous generates.
- `--branch <name>`: work with this branch instead of the one checked out. A branch that does not exist is
  created from the current commit.
- `--status`: only report where the branch's proposal stands; nothing is checked, written or sent.
- `--commit`: commit uncommitted changes for you, after listing them and asking once, with the title, the
  description and the changelog as the message.
- `--draft`: open a new proposal as a draft.

Example: `sous repo submit --title "Add a linting recipe" --body "Adds lint rules for shell scripts." --draft`

## subscription

Manages which recipes this project subscribes to. `REF` is `namespace` or `namespace/recipe`, either of them
optionally carrying an `@<range>` and a `repo:` qualifier; see
[Refs](repositories-file-formats.md#refs-how-anything-is-named).

### `sous subscription add REF`
Subscribes this project to a recipe, or to a whole namespace of them, then builds the project so the recipe's
files are on disk when the command returns. Also spelled `sous subscribe`. Takes `-y, --yes`, `--no-build`, and
`--dry-run`, which also prints every question the recipes would ask. A dry run downloads nothing, so a recipe
not on this machine is described from its repository's index; one whose index entry predates the release that
began recording questions there is named instead.

- `--prerelease`: let prerelease versions take part in range matching.
- `--always-pull`: install a newer in-range version whenever one exists, rather than holding the lock.
- `--accept-first`: when a one-word ref matches several things, take the first one listed.
- `--answer <name>=<value>`: answer one question ahead of time. Repeat it for each answer.
- `--answers-file <path>`: read the same pairs from a YAML or JSON file. An `--answer` wins over the file.

Example: `sous subscription add workflow/task-files@^1.2.0 --answer apiUrl=https://api.example.com`

### `sous subscription remove REF`
Removes a subscription and everything only it brought in, then rebuilds so those files are gone. Also spelled
`sous unsubscribe`. Takes `--dry-run` and `--no-build`. Example: `sous subscription remove workflow/task-files`

### `sous subscription update [REF]`
Moves the lockfile's pins to the newest published versions their ranges allow, then rebuilds the project. With
no `REF` it covers every subscription; a `REF` naming a repository, a namespace or a recipe narrows it, and
everything outside it stays where it is pinned. It fetches every trusted repository's index first, never widens
a range, moves dependencies with the closure, and changes only the lockfile, never the subscriptions. It prints
the plan and asks once; with nothing to update it says so and asks nothing. See
[Moving to newer versions](repositories-consuming.md#moving-to-newer-versions). Takes `--no-build`, `--answer`
and `--answers-file`, and `--dry-run`, which fetches the indexes but downloads no recipe and writes nothing.

- `-y, --yes`: accept the plan, and trust any repository a newer version needs (also `--force`, `--trust`).
- `--accept-first`: when `REF` matches several things, take the first one listed.

Example: `sous subscription update workflow/task-files`

### `sous subscription list`
Lists the subscriptions this project declares, switched-off ones included, with the range each resolves within,
the versions the lockfile pins, the latest version each of those recipes has published, where it came from and
whether it is on. Reads the config, the lockfile and the cached indexes only. Takes the
[browsing flags](#flags-that-browse): `--latest` reads the latest versions from upstream, and `--installed` keeps
only the subscriptions that have pinned something. Example: `sous subscription list --latest`

## namespace

`namespace` reads the cached indexes and the lockfile, so it works offline. A trusted repository whose index has
never been fetched is named at the end of a listing, not left out. Both commands take the
[browsing flags](#flags-that-browse); with `--installed` the recipe count is the number installed. The core version this installation of sous
ships is listed even while the cached index does not publish it yet.

### `sous namespace list`
Lists every namespace the trusted repositories publish, how many recipes each holds, and how much of it this
project subscribes to: all of it, some recipes, or none. Example: `sous namespace list`

### `sous namespace show REF`
Shows one namespace and every recipe in it, with the latest published version, the version this project pins,
and whether it is subscribed. `REF` is a namespace, optionally written as `repository:namespace`.
Example: `sous namespace show sous-recipes:core`

## recipe

Browses the recipes the trusted repositories publish; like `namespace`, it works offline, and both commands take
the [browsing flags](#flags-that-browse).

### `sous recipe list`
Lists the recipes the trusted repositories publish, across every namespace, with the same per-recipe columns
`namespace show` prints. Example: `sous recipe list --installed --latest`

### `sous recipe show REF`
Describes one recipe completely: its repository and location, every published version, its dependencies (the
manifest entry bringing each one in, such as a whole namespace, whether it is a co-subscription or a build
dependency, and the version it was released against), every recipe a subscription to it would install, every
question that would ask, laid out as `sous subscription add --dry-run` lays them out, and the directories its
files are written into. Everything but the files comes from the index, so a recipe nothing has installed yet
is described in full, offline. `REF` is `namespace/recipe`, a recipe name alone, or either with a
`repository:` qualifier. Example: `sous recipe show omakase/house`

## lock

Inspects and repairs this project's lockfile; both commands work from what is on disk and fetch nothing.

### `sous lock show`
Prints what `.sous/sous.lock.json` pins: the recipe, the version, the repository it came from, and who holds it
(this project, or the recipes that require it). Example: `sous lock show`

### `sous lock rebuild`
Recomputes the whole lockfile from the subscriptions the config declares and the cached indexes, starting from
empty, so an entry nothing holds any more is dropped rather than carried through: the repair for a file that
drifted through a hand edit or a bad merge. It asks nothing, grants no trust and downloads nothing. The core
version this installation of sous ships resolves even when the cached index has not published it yet, exactly
as it does in a build. To move pins to versions published since the last fetch, use `sous subscription update`.
Takes `--dry-run`. Example: `sous lock rebuild --dry-run`

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
producing output built on a guess. A build with a compile error carries on long enough to compile every target
and list every error, then exits `1`, leaving the last good copy of each output that had an error;
`--strict` on `build` and `compile` makes compile warnings fail the run too.

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
`SOUS_DEBUG=1 sous build`. The one other thing it changes is that every hand-off to a project's own install
announces itself in full, not only one between different versions; `--verbose` does the same.

`SOUS_NO_DELEGATE` is the other environment variable every command reads. Set it the same way and the copy of
sous you invoked runs the command, even inside a project that installs its own `@sous-io/sous`; see
[Installing](README.md#installing) for the hand-off it switches off.

Every listing fits itself to the terminal it runs in: columns shrink, descriptions wrap, and a path or URL is
cut in the middle so the host and the last segment both survive. On a terminal too narrow, the least important
columns step aside and a line under the table names them; nothing is hidden when the output is not a terminal.

For what a particular repository error is telling you, and how to clear it, see
[Repositories troubleshooting](repositories-troubleshooting.md).
