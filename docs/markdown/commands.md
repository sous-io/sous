# Command Reference

What each `sous` command is for, the flags you will reach for most, and an example. This page does not list
every flag: the full, current list for any command is in your terminal, with `sous <command> --help` or
`sous help <command>`.

Plugins can add commands of their own. They appear in `sous --help` beside the built-in ones, and every command
is also a tool that `sous mcp` offers an agent.

## Flags that locate the configuration

Every command that works on a project takes `-c, --config <path>` (also `--sous-config`), `--sous-dir <path>`
and `--sous-confd <path>`. They point sous at a config file, a `.sous/` directory or a `conf.d/` directory
instead of the one walk-up discovery would find. The environment variables `SOUS_CONFIG`, `SOUS_DIR` and
`SOUS_CONFD` do the same; a flag beats its variable. See [Discovery and overrides](config-discovery.md).

?> `repo init`, `repo release` and `repo submit` take none of these. They run inside a recipe repository, which
has no `.sous/` directory to discover. `repo submit` may also be run from a project, which it finds by walking up
from the working directory.

## Flags that answer questions

- `-y, --yes` answers yes to every confirmation the command would ask. `-f`, `--force` and, on the commands that
  trust a repository, `--trust` are the same flag.
- `--non-interactive` never asks anything. A run that would have asked fails instead, naming the question and
  the flag that would have answered it.
- `--dry-run` prints what the command would do, and writes, downloads and asks nothing.

Sous asks a question only when it can. Piping output, redirecting it to a file and running in CI therefore do
what `--non-interactive` does; see [When sous cannot ask](repositories-consuming.md#when-sous-cannot-ask).

!> `sous clear` is the exception: without `-f` it asks even under `--non-interactive` or in CI, so pass `-f`
whenever you script it. And `sous repo init --force` is not a confirmation; it overwrites a repository that
already exists.

## Flags that control output

- `--log-level <level>` shows messages at that level and above (`debug` through `emergency`); `--debug` is the
  same as `--log-level debug`.
- `--timings` prints how long each step of the run took.
- `--json`, on the commands that print a listing or a report, prints it as JSON instead.

Sous warns on standard error when a step takes longer than its time budget, so the warning never mixes with
`--json` output. The `budgets` config key changes a budget, and `false` turns its warning off.

`sous --version` prints the version (`v1.2.3`); add `--verbose` for where it is installed, the platform and
the Node build.

## Flags that browse

The commands that show published versions (`recipe list` and `show`, `namespace list` and `show`, `repo list`,
`search` and `subscription list`) read only the cached repository indexes by default, so they work offline and
fast. Two flags change that, and they combine:

- `--latest` (also `--remote`) reads each repository's index from upstream instead of the cache, without
  writing it to the cache. A repository that cannot be reached is shown from the cache and named as not
  checked.
- `--installed` shows only what this project has installed, at the version its lockfile pins.

`sous recipe list --installed --latest` shows each installed recipe beside upstream's newest version: the
out-of-date view.

## Spellings

Every topic answers to both spellings of its name (`repo` and `repos`, `subscription` and `subscriptions`, and
so on), and `sous search`, `sous subscribe` and `sous unsubscribe` are one-word forms of `repo search`,
`subscription add` and `subscription remove`.

## Top-level commands

### `sous init [DIRECTORY]`

Sets a project up for sous, then runs the first build. It writes a commented `sous.config.js`, a starter prompt
at `.sous/memories/AGENTS.tpl.md` that compiles to `AGENTS.md` at the project root, the `.sous/.env` and
`.sous/.env.local.example` files, and the sous block in `.sous/.gitignore`. A project with a `package.json` also
gains `@sous-io/sous` as a devDependency at the running version; run your package manager's install afterwards.

The starter prompt holds one line, `@#memories/**/*.md`, which includes every memory your subscribed recipes
publish. Agent plugins can add more places for memories (the built-in Claude Code plugin adds `CLAUDE.md`).

A project whose `.sous/` already holds a config is left untouched. `--format jsonc` (also spelled `--format json`) writes `sous.config.jsonc`, a commented JSON config bound
to the published schema; `--format js` is the default. `--no-build` skips the first build.

```bash
sous init
sous init --format jsonc --name "My Project"
```

### `sous build`

Compiles the project's outputs, then removes the ones the config no longer produces. It is the command you want
almost always. `-w, --watch` rebuilds on every change to a source file, a config file or a linked checkout;
`--rebuild` ignores cached hashes and reprocesses everything; `--strict` makes compile warnings fail the build.

Before it compiles, a build prepares the project's recipes: it pins any new subscription, restores whatever this
machine's recipe store is missing, and lists each recipe that has a newer version within its range (it moves no
pin; see [Moving to newer versions](repositories-consuming.md#moving-to-newer-versions)). The other commands
that build (`init`, `launch`, `prune`, `subscription add` and the like) run this same build.

A build compiles only the recipes whose subscriptions are switched on on this machine. Each one it skips gets a
line saying why:

```text
$ sous build
Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc).
Pruned 4 outputs it had written.
```

A compile error (a missing or circular include, a template that fails to render, a file sous cannot read) fails
the build, but only after every target is compiled and every error listed. An output whose target had an error is
not written, so the copy from the last good build stays in place. A build also warns about every recipe memory
that no output includes; see [Recipe memories](repositories-consuming.md#recipe-memories).

```bash
sous build
sous build --watch
```

### `sous compile`, `sous prune`, `sous clear`

The pieces of a build, run on their own:

- `sous compile` compiles and prunes nothing. It does not prepare the recipes first.
- `sous prune` removes the outputs no longer in the config.
- `sous clear` deletes every file and directory sous has written for the project, after asking.

```bash
sous prune --dry-run
sous clear --force
```

### `sous launch TOOL...`

Builds the project, then starts a coding agent: one an agent plugin provides (the built-in Claude Code plugin
provides `claude`), or one configured under `tools` in the config. A failed build starts nothing.
`--continuous` restarts the agent whenever it exits, and `--no-build` skips the build.

Arguments `launch` does not recognize are passed to the agent. Put one that clashes with a sous flag after a
bare `--`:

```bash
sous launch claude --resume
sous launch claude -- -c
```

### `sous search TEXT`

Searches the recipes every trusted repository publishes, by name or description. Also spelled
`sous repo search`.

```bash
sous search task
```

### `sous update`

Updates sous itself: the global install, the project's own install, or both, each through the package manager
that installed it. It prints every plan and asks before each install. By default each install moves to the
newest version in its current major; `--major` goes past it and `--version <version|range|tag>` picks one, a
downgrade included. See [Updating](README.md#updating).

```bash
sous update --dry-run
sous update --version next
```

### `sous mcp`

Starts an MCP server for the project, for any agent tool that speaks MCP. Its tools are the same commands the
CLI runs, so an agent can do through it anything you can at a terminal, and a question a command would ask is
asked through the agent tool instead. The server keeps serving the project it started in, even when the agent
changes directories. In an agent tool's MCP settings:

```json
{
    "mcpServers": {
        "sous": {
            "command": "npx",
            "args": ["sous", "mcp"]
        }
    }
}
```

### `sous plugins show`

Lists every plugin loaded for the project and what each one adds or replaces. Use it to find out which plugin
provides a command, a config key or an agent's targets.

```bash
sous plugins show
```

### `sous help [COMMAND]`

Prints the help for sous, or for one command or topic. It works from any directory, including one with no
config above it.

```bash
sous help repo add
```

## config

Inspects the built configuration; see [Inspecting and validating](config-inspection.md).

- `sous config show` prints the built config as JSON, with config expressions evaluated: what sous will do on
  this machine. `--layers` shows each change in order and what made it.
- `sous config get PATH` prints one value by dot-path. `--layers` shows every file, recipe or plugin that
  changed it.
- `sous config validate` checks the config against its schema, then resolves every variable, which is what
  finds circular and undefined `${var}` references.

```bash
sous config show | jq .compilation
sous config get compilation.targets[0].entryPoint --layers
```

## repo

Manages the recipe repositories the project trusts; see [Repositories](repositories.md) and
[Consuming recipes](repositories-consuming.md).

### `sous repo add URL`, `sous repo remove REPO`, `sous repo list`

- `repo add` trusts a repository and fetches its index, so its recipes are listable. `URL` is its address or a
  path on this machine; `--name` sets the short name refs use, and `--provider` names the host when the URL does
  not give it away (see the [provider reference](repositories-providers.md)).
- `repo remove` stops trusting a repository and removes everything it brought in, after listing what goes.
- `repo list` lists the trusted repositories; `--verbose` adds the namespaces each publishes.

```bash
sous repo add https://github.com/sous-io/sous-recipes --name recipes
sous repo remove recipes --dry-run
```

### `sous repo gc`

Shrinks this machine's recipe store down to its size limit.

```bash
sous repo gc --dry-run
```

### `sous repo link REPO [PATH]`, `sous repo unlink REPO`

`repo link` makes the project read a repository from a working copy instead of a published version, so you can
edit recipes in place; see [Edit a repository in place](repositories-authoring.md#edit-a-repository-in-place). A
name or URL alone clones the repository into `.sous/repos`; with a `PATH`, or a path alone, it links that
checkout. `--global` links it for every project on this machine, and `--branch`, `--create-branch` or
`--generate-branch` choose the branch to work on.

`repo unlink` goes back to the versions the lockfile pins and rebuilds. `--update` also moves the pins to the
newest versions their ranges allow, and `--remove` deletes a checkout sous cloned.

```bash
sous repo link sous-recipes ~/Projects/sous-recipes
sous repo link sous-recipes --generate-branch --latest
sous repo unlink sous-recipes --update
```

### `sous repo contribute REF`

Starts a change to a recipe repository, and finishes it with `--finish`, by running `repo link`, `repo submit`
and `repo unlink` for you. `REF` names a repository, or a namespace or recipe in it. Also spelled
`sous repo contrib`. See [Contributing a change](repositories-contributing.md).

```bash
sous repo contribute workflow/task-files
sous repo contribute workflow/task-files --finish --title "Clarify the resume steps" --body "The resume steps skipped the task file."
```

### `sous repo init [DIRECTORY]`

Creates a new recipe repository. See [Authoring a repository](repositories-authoring.md).

```bash
sous repo init ./my-recipes --name team-recipes --namespace workflow
```

### `sous repo release`

Publishes new versions of the repository's recipes: raises their versions, regenerates the index, commits and
tags. It plans first and asks once, and it needs a git commit identity (`user.name` and `user.email`) in the
repository. `--check` only validates, and `--ci` is the setting for a merge job.

```bash
sous repo release --recipe workflow/task-files --bump minor --push
sous repo release --ci --yes --push
```

### `sous repo submit [REPO]`

Proposes a repository's changes to its maintainers and follows the proposal through: it opens one, updates it
when there is more to send, and reports where it stands. Run in a project, `REPO` names a linked repository.
`--status` only reports.

```bash
sous repo submit --title "Add a linting recipe" --body "Adds lint rules for shell scripts." --draft
```

## subscription

Manages which recipes the project subscribes to. `REF` is `namespace` or `namespace/recipe`, optionally with an
`@<range>` and a `repo:` prefix; see [Refs](repositories-file-formats.md#refs-how-anything-is-named).

- `subscription add` (or `sous subscribe`) subscribes, then builds so the recipe's files are on disk. Answer a
  recipe's questions ahead of time with `--answer <name>=<value>` or `--answers-file <path>`, and let it install
  the sous plugins it requires with `--install-plugins`.
- `subscription remove` (or `sous unsubscribe`) removes a subscription and everything only it brought in.
- `subscription update [REF]` moves the lockfile's pins to the newest versions their ranges allow, then
  rebuilds. See [Moving to newer versions](repositories-consuming.md#moving-to-newer-versions).
- `subscription disable REF` and `subscription enable REF` switch a subscription off or back on in
  `conf.d/510-subscriptions.jsonc`, leaving the rest of that file as it is.
- `subscription list` lists the subscriptions, switched-off ones included, with their pins and latest versions.

```bash
sous subscribe workflow/task-files@^1.2.0 --answer apiUrl=https://api.example.com
sous subscription disable tool-usage/automated-browser-tasks
sous subscription update
```

## namespace and recipe

Browse what the trusted repositories publish, offline.

- `namespace list` lists every namespace and how much of it the project subscribes to.
- `namespace show REF` lists one namespace's recipes, with their latest and pinned versions.
- `recipe list` lists every recipe, across every namespace.
- `recipe show REF` describes one recipe completely: its versions, dependencies, the questions it asks and where
  its files go, even before anything installs it.

```bash
sous namespace show sous-recipes:core
sous recipe show omakase/house
```

## lock

Inspects and repairs the project's lockfile, `.sous/sous.lock.json`, without fetching anything.

- `lock show` prints what the lockfile pins, and why each recipe is there.
- `lock rebuild` recomputes the lockfile from scratch from the subscriptions and the cached indexes: the repair
  for a lockfile damaged by a hand edit or a bad merge.

```bash
sous lock rebuild --dry-run
```

## vars

Inspects the questions the project's recipes ask, and the answers they hold; see
[Recipe variables](repositories-variables.md). `sous vars` alone is `vars list`.

- `vars list` lists every variable, with where its value came from.
- `vars show NAME` shows everything about one variable.
- `vars ask [NAME]` asks the questions and stores the answers in the `.sous` env files. `--env-file .env` or
  `--env-file .env.local` stores every answer of the run in that one file (committed, or this machine only); a
  secret or machine-specific variable headed for the committed `.env` is warned about and needs a yes (`--yes`).

```bash
sous vars show workflow/task-files.apiUrl
sous vars ask --namespace workflow
```

## Exit codes and errors

A command that succeeds exits `0`, a command line sous could not parse exits `2`, and every other failure exits
`1`. A broken config stops sous rather than producing output built on a guess.

A failure prints one error block that names the cause and the fix:

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

Two environment variables change how any command runs:

- `SOUS_DEBUG=1` prints the stack trace under every failure, and announces every hand-off to a project's own
  install of sous.
- `SOUS_NO_DELEGATE=1` runs the copy of sous you invoked, even inside a project that installs its own; see
  [Installing](README.md#installing).

For what a repository error is telling you, see [Repositories troubleshooting](repositories-troubleshooting.md).
