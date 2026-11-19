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

?> `repo init`, `repo release` and `repo submit` take none of these. They work on a recipe repository, which
they find by its `sous.repo.yaml`, not through a project's config. (A recipe repository is also a sous project,
with a `.sous/` of its own, but these commands do not locate the repository through it.) `repo submit` may also be run from a project, which it
finds by walking up from the working directory.

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

Sous reports, at the `debug` level, when a step takes longer than its time budget, so the report shows only
with `--debug` or `--log-level debug`. It goes to standard error, so it never mixes with `--json` output. Time
spent waiting for you to answer a question does not count. The `budgets` config key changes a budget, and
`false` turns its report off.

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

Some topics and commands also have a short form. A topic's short form reaches every command under it, and the
short forms combine: `sous ns ls` is `sous namespace list`.

| Short form | Stands for | Example |
|---|---|---|
| `ns` | `namespace` | `sous ns show core` |
| `sub` | `subscription` | `sous sub add workflow/task-files` |
| `rc` | `recipe` | `sous rc show omakase/house` |
| `cfg` | `config` | `sous cfg get compilation` |
| `ls` | `list`, in `namespace`, `recipe`, `repo`, `subscription` and `vars` | `sous repo ls` |
| `rm` | `remove`, in `repo` and `subscription` | `sous sub rm workflow/task-files` |

Every command's `--help` lists the other spellings it answers to, under ALIASES.

## Top-level commands

### `sous init [DIRECTORY]`

Sets a project up for sous: it imports the project's existing agent files into a new `.sous/` directory, offers
the git hooks, then runs the first build. Sous owns all of a project's agent configuration from then on. What a
build writes (the memories file, such as `.claude/rules/SOUS-MEMORIES.md` for Claude Code, and `.claude/skills/`)
is build output, so edit the sources under `.sous/` and run `sous build` after cloning.

It writes:

- `.sous/sous.config.jsonc`, the primary config: JSON with comments that explain each block, and a `$schema`
  pointing at the config schema published with the running version, so an editor completes and checks it. Its
  one target compiles the project's own skills; it compiles no `AGENTS.md` or `CLAUDE.md`. A project may still
  write a `sous.config.js` by hand instead.
- `.sous/MEMORIES.tpl.md`, the source of the memories file each coding-tool plugin compiles. It holds the two
  default lines under a comment saying what each includes:

  ```markdown
  @memories/**/*.md
  @#memories/**/*.md
  ```

  The first includes the project's own memories, every markdown file under `.sous/memories/`; the second, every
  memory the subscribed recipes publish. Removing a line removes that part, and moving a line changes the order.
- `.sous/memories/project.tpl.md`, a starter memory with generic text to replace ("Describe the project here: what
  it is, how it is built, and how it is tested."), when there was nothing to import. In a recipe repository (one
  with a `sous.repo.yaml`) it says instead that the repository is a Sous Repo, and names the core skills.
- `.sous/.env`, `.sous/.env.local.example`, and the sous block in `.sous/.gitignore` (which ignores, among
  others, `backups/`).
- `.sous/sous.lock.json` with `migratedVersion` set to the running version, so a new project has no migrations
  pending.
- Once, a sous block in the project's own `.gitignore`, listing what the builds write outside `.sous/`:

  ```text
  # >>> sous managed (do not edit between these markers)
  /.claude/rules/SOUS-MEMORIES.md
  /.claude/skills/
  /.claude/agents/
  /AGENTS.override.md
  # <<< sous managed
  ```

  No build keeps this block current. A project that commits its own skills or agents removes that line.

A project with a `package.json` also gains `@sous-io/sous` as a devDependency at the running version.

What init imports, before the first build:

- **The instructions.** A root `CLAUDE.md` or `AGENTS.md` is copied to `.sous/memories/imported/` as plain `.md`,
  so Liquid never touches it. A file that is a symlink to the other, holds the same text, or only points at the
  other (at most 3 non-blank lines and 400 characters, naming the other file) is skipped. No build writes the
  root files any more, so both are then backed up and removed, imported or skipped: a coding tool that read
  them beside the memories file would read the same instructions twice.
- **The files they include.** A line holding only `@path.md` includes that file, and init follows those lines
  through every included file. Each file is moved (the default), copied, or left where it is. A moved or copied
  file goes to `.sous/includes/<its path from the project root>`, outside `memories/`, so it appears only where
  its include line is. A README, and a file outside the project, always stay where they are; a file included by
  a file that stays is copied rather than moved. Every `@` reference in a copied file is rewritten to work from
  its new place, and an include that names a missing file becomes an HTML comment, with a warning.
- **The skills.** Every folder in `.claude/skills/` moves to `.sous/skills/`. The config always has a target
  that compiles `.sous/skills/` into `.claude/skills/`, and init writes `SKILLS_ROOT=.sous/skills` into
  `.sous/.env`, so a skill the `create-skill` skill writes later is compiled too. Until the folder exists the
  target compiles nothing, without a warning. A project skill with the same name as a recipe skill wins, and
  the build warns that the recipe's copy was not written.

Everything init moves is backed up first, to `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/<path>`, which git ignores.
Git stops tracking the root `CLAUDE.md`, `AGENTS.md` and each moved skill folder (`git rm -r --cached`).
`.claude/agents/`, `.claude/commands/` and `.claude/settings.json` are left alone.

What happens to the included files is one question, asked once after init lists them: move them, copy them,
leave them, or choose for each file. `--move-includes`, `--copy-includes` and `--leave-includes` answer it ahead
of time, one at a time, and `--yes` accepts the default, move. A run with no terminal and none of these flags
fails, naming them. `--dry-run` plans with the default and asks nothing.

In a project with a `.git` folder, init asks whether to install the git hooks, which
[`sous init hooks`](#sous-init-hooks-directory) describes, and then whether to add the ones that run after a pull.
`--hooks` and `--no-hooks` answer the first question, `--pull-hooks` and `--no-pull-hooks` the second, and `--yes`
installs the hooks without the pull ones. With a `package.json`, the hooks run the package manager's install,
and init then offers to run it (`--install`, `--no-install`; `--yes` runs it). That install runs `sous build`
through the package script, so init skips its own build; when the install is declined, init builds by itself.
`--no-build` also leaves the install out, unless `--install` asks for it.

A project whose `.sous/` already holds a config is left untouched. `--no-build` skips the first build.

```bash
sous init
sous init --name "My Project"
sous init --copy-includes
sous init --yes --pull-hooks
sous init --no-hooks
sous init --dry-run
```

### `sous init hooks [DIRECTORY]`

Installs the git hooks that give a new worktree, and each checked-out branch, Sous's output. Sous's output is
git-ignored, so a new worktree starts without it; git runs `post-checkout` whenever a worktree is created or a
branch is checked out, whoever runs git (a person, Claude Code, the Claude Desktop app, an IDE).

```text
git worktree add / git checkout <branch>
  -> .husky/post-checkout runs `pnpm install`
     -> pnpm runs the "prepare" script
        -> sous build
```

- **With a `package.json`:** Husky is added as a dev dependency, and `.husky/post-checkout` runs the package
  manager's install (`npm install`, `pnpm install` or `yarn install`, by the manager sous detects) on every
  branch checkout. The script the manager runs after an install runs Husky and `sous build`: `prepare` for npm
  and pnpm, `postinstall` for Yarn, whose newer versions skip `prepare` on install. A script already under that
  name keeps what it has, and Sous's part runs after it. The guard `|| exit 0` means a missing `sous` command (an
  install without dev dependencies) or a failed build prints its error and does not fail the install. At the
  end, sous offers to run the install, which installs Husky and so turns the hooks on (`--install`,
  `--no-install`; `--yes` runs it). Since sous has just added Husky to `package.json`, that install may update the
  lockfile even where the manager would freeze it in CI (`pnpm install --no-frozen-lockfile`,
  `yarn install --no-immutable` for Yarn 2 and later); the hook itself runs the plain install. Sous does not look for other hook managers: installing Husky points git at
  `.husky/`, so another manager's hooks stop running until the project sorts that out.
- **Without one:** the repository's own `post-checkout` hook (in `.git/hooks/`, or wherever `core.hooksPath`
  points) runs `sous build` directly, and does nothing when there is no `sous` command.

`post-checkout` is installed by default. Sous asks whether to add `post-merge` (after a pull that merges) and
`post-rewrite` (after a rebase, including a pull set to rebase); `--pull-hooks` and `--no-pull-hooks` answer, and
`--yes` leaves them out. Each hook prints a failure and exits 0, so git carries on.

The hook for pnpm, `.husky/post-checkout`:

```sh
# >>> sous managed: init hooks (do not edit between these markers)
# After a checkout, install the dependencies; the "prepare" script then runs `sous build`, so the
# files Sous writes match this checkout. A failure is printed, and git carries on.
if [ "$3" = "1" ]; then
  pnpm install || echo "sous: 'pnpm install' failed after a checkout; git carried on." >&2
fi
# <<< sous managed: init hooks
```

And the script it adds to a `package.json` that had none:

```json
{
  "scripts": {
    "prepare": "husky && sous build || exit 0"
  }
}
```

A hook file that already exists keeps its lines and gains Sous's block after them; running the command again
replaces the block and changes nothing else. Installing the hooks is a one-time action: no build puts them back,
since a project may change them.

Only a project whose `.sous/` is at the top of its git repository is supported, since the hook, the install and
the build all run there. Anywhere else (a project in a folder of a monorepo, say) the command stops, says why,
and prints the lines to add by hand. `--dry-run` shows the files and the install command and changes nothing.

```bash
sous init hooks
sous init hooks --pull-hooks
sous init hooks --yes --no-install
sous init hooks --dry-run
```

### `sous build`

Compiles the project's outputs, then removes the ones the config no longer produces. It is the command you want
almost always. `-w, --watch` rebuilds on every change to a source file, a config file or a linked checkout,
and reloads the config when a file is added to or removed from a glob target's folder;
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

After preparing the recipes, one build runs these steps, in this order:

1. The `check` handlers of the recipes and plugins (see [Handlers](handlers.md)). An error from one stops the
   build here, before anything in the project is written, and the build ends with exit code 1. A warning is
   printed and the build goes on.
2. The `beforeBuild` handlers.
3. The compiler, then the prune of outputs the config no longer produces.
4. The declared edits to files sous does not own, and their assertions (see
   [Editing files Sous does not own](editing-files.md)). An assertion at level error that fails leaves that one
   file unwritten; every other file is written, and the build ends with exit code 1.
5. The `afterBuild` handlers.

A compile error skips steps 4 and 5. Three flags let a build finish in spite of failures. Each failure is still
printed, as a warning, and the build ends as successful. There is no setting that makes this permanent: it is a
choice made on each run.

| Flag | What it lets through |
| --- | --- |
| `--ignore-failed-checks` | An error a `check` handler reports |
| `--ignore-failed-assertions` | A failed assertion at level error; the file is then written |
| `--keep-going` | Both |

`--dry-run` runs the `check` handlers (they only report), works out every edit and checks every assertion, and
writes nothing; it runs no `beforeBuild` or `afterBuild` handler, since those act. Watch mode runs every step on
each rebuild, with the flags it was started with. `sous prune` runs none of the handlers and no edits. The other
commands that build (`init`, `launch`, `subscription add` and the like) run the same steps without these flags,
so a failed check stops them too; run `sous build --ignore-failed-checks` first when that is what you want.

```bash
sous build
sous build --watch
sous build --keep-going
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

### Backups before overwriting or removing

Sous never destroys content it did not produce. Before `build`, `compile`, `prune` or `clear` overwrites or
removes a file, it copies the file to a backup when sous did not write the file, or when sous wrote it but the
file was edited by hand since (its content no longer matches the hash the state file recorded). A file whose
content already matches what is about to be written needs no backup, and neither does an output that is still
exactly as sous wrote it.

Backups go to `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/`, followed by the file's path relative to the project root,
in local time. Every backup of one run shares one timestamp folder. A file outside the project goes under
`outside-project/` in that folder, followed by its absolute path without the leading slash, so
`/home/me/.claude/CLAUDE.md` is backed up to `.sous/backups/2026-11-15/0912-04/outside-project/home/me/.claude/CLAUDE.md`.
A backup is never overwritten: if one is already there, the new one gets `.1`, `.2` and so on after its name.

Each backup is listed in the command's output, just before the line that says the file was written or removed.
A dry run lists the backups it would make and writes nothing:

```text
  ↪ /work/app/CLAUDE.md (backed up to /work/app/.sous/backups/2026-11-15/0912-04/CLAUDE.md)
  ✓ /work/app/CLAUDE.md
  ↪ /work/app/notes.md (would back up to /work/app/.sous/backups/2026-11-15/0913-20/notes.md)
  − /work/app/notes.md (would remove)
```

The first two lines come from a build, the last two from `sous prune --dry-run`.

A build also puts an output edited by hand back to its compiled content, even when its source did not change,
so the edit is backed up rather than silently kept as if sous had written it. With
`compilation.overwriteUntracked: false`, a file sous did not write is left alone instead, so it needs no backup.
Sous never deletes backups; remove old ones from `.sous/backups/` yourself.

### `sous launch TOOL...`

Builds the project, then starts a coding agent: one an agent plugin provides (the built-in Claude Code plugin
provides `claude-code`, and the built-in [Codex plugin](codex.md) provides `codex` once a project turns it on), or
one configured under `tools` in the config. A failed build starts nothing. The settings for the built-in Claude
Code one are under `tools.claude-code` (`command`, `args`, `promptFile`, `headless`). Before version 1.1.0 the
tool was named `claude`; `sous launch claude` is not kept as an alias, and when no tool has that name the error
suggests `sous launch claude-code`.
`--continuous` restarts the agent whenever it exits, and `--no-build` skips the build.

Arguments `launch` does not recognize are passed to the agent. Put one that clashes with a sous flag after a
bare `--`:

```bash
sous launch claude-code --resume
sous launch claude-code -- -c
```

### `sous search TEXT`

Searches the recipes every trusted repository publishes, by name or description. Also spelled
`sous repo search`.

```bash
sous search task
```

### `sous update [REF]`

Moves the lockfile's pins to the newest versions their ranges allow, then rebuilds: every subscription, or only
the repository, namespace or recipe `REF` names. `--dry-run` prints the plan and changes nothing. It asks before
it changes anything and before trusting a repository a newer version needs; `--yes` answers yes, and
`--answer <name>=<value>` or `--answers-file <path>` answer a new version's questions ahead of time.
`sous subscription update` and `sous recipe update` are other spellings of it. See
[Moving to newer versions](repositories-consuming.md#moving-to-newer-versions).

```bash
sous update --dry-run
sous update workflow/task-files --yes
```

### `sous upgrade`

Upgrades sous itself: the global install, the project's own install, or both, each through the package manager
that installed it. It prints every plan and asks before each install. By default each install moves to the
newest version in its current major; `--major` goes past it and `--version <version|range|tag>` picks one, a
downgrade included. After the project's install moves to a newer version, the new copy runs the
[migrations](#sous-doctor) that version brings, then builds the project; `--answer <name>=<value>` answers a
migration's question ahead of time. See [Upgrading](README.md#upgrading).

```bash
sous upgrade --dry-run
sous upgrade --version next
```

### `sous doctor`

Checks the project's health, runs the migrations a newer version of sous brought, and offers to fix each
problem it finds, asking before each fix. Its checks, in order:

1. The config loads.
2. The lockfile agrees with the subscriptions (fix: write the lockfile the subscriptions make, keeping every pin
   their ranges still allow).
3. Required recipe variables have answers (fix: ask them).
4. Every migration for this version of sous has run (fix: run them). This check runs even when the config does
   not load, since a migration may be what makes it load again (an option a newer sous removed). When it does,
   the config is read again in the same run: the first check shows as fixed, and the checks it had skipped run.
5. The git hooks are turned on, when the project was set up with them (fix: `sous init hooks --install`). Sous
   reads what `sous init hooks` committed: hook files in `.husky/` holding its marked block. They are on when
   git's hooks folder is Husky's `.husky/_`, which the package manager's install sets up; a fresh clone whose
   install has not run is what this finds. A project without a `package.json` keeps its hook outside git, so a
   new clone cannot tell, and the check says so.
6. The `check` handlers of the recipes and plugins report no errors. Their errors are a problem and their
   warnings a warning, one line each. No fix: what they report is yours to put right.
7. Every assertion on the files sous edits holds, checked without writing anything. A failed assertion at level
   error is a problem; one at level warn is a warning. No fix.
8. The files sous wrote are present and unchanged (fix: build).

Plugins add checks of their own. `--dry-run` reports and changes nothing; `--yes` applies every fix without
asking and takes the default answer to each migration's question; `--answer <name>=<value>` answers one
question, a migration's or a recipe variable's; `--only <check>` runs one check. It ends with exit code 1 when a
problem remains. A migration waiting for an answer nobody could give (no terminal, no `--yes`, no `--answer`)
is listed with the `--answer` that gives it, and does not change the exit code.

A migration brings a project's files in line with a newer version of sous. Each runs once for the project: the
lockfile records the version of sous whose migrations the project last ran. While one is waiting, every other
command prints one line saying so, and carries on.

```bash
sous doctor --dry-run
sous doctor --yes
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
sous config get repos.sous-recipes.url --layers
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

Shrinks this machine's recipe store down to its size limit. It also removes the download folders
(`.sous-restore-*`) an interrupted build left in the store more than an hour ago.

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

Creates a new recipe repository, then runs [`sous init`](#sous-init-directory) in the same directory, so the
repository is also a sous project whose memories file and `.claude/skills/` are build output. It
passes `--yes`, `--move-includes`, `--copy-includes`, `--leave-includes`, `--no-build` and `--dry-run` through to
init. A directory that already holds a sous config keeps it, and init is skipped with a note. See
[Authoring a repository](repositories-authoring.md).

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
- `subscription remove` (or `sous unsubscribe`) removes a subscription and everything only it brought in. The
  built-in `core` subscription is switched off instead, keeping its pin.
- `subscription update [REF]` is [`sous update`](#sous-update-ref).
- `subscription disable REF` and `subscription enable REF` switch a subscription off or back on in
  `conf.d/510-subscriptions.jsonc`, leaving the rest of that file as it is.
- `subscription list` lists the subscriptions, switched-off ones included, with their pins and latest versions.

```bash
sous subscribe workflow/task-files@^1.2.0 --answer apiUrl=https://api.example.com
sous subscription disable tool-usage/automated-browser-tasks
sous sub ls
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
- `vars show NAME` shows everything about one variable. `NAME` may also be an environment variable name that
  answers it.
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
