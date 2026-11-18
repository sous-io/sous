# S14: What `sous init` Writes, and `sous init hooks`

**Status:** Accepted on 2026-11-18, from Luke's rulings that day. From now on, a change to this
specification is recorded under "Changes".

**Serves:** G3 (versatility, always), G4 (predictable and observable), G8 (every core feature works
without any particular agent tool), G10 (config as desired state).

**Related:** S2 (config building), S6 (concerns and owners: `plugin-init` and the `package-manager`
entity).

## What This Specifies

What `sous init` writes into a new project, and the git hooks it installs, through a new command,
`sous init hooks`, so a new git worktree gets Sous's output. Every rule below is marked as ruled by
Luke (quoted), or as the agent's choice where he left it open.

## The Files `sous init` Writes

### The main config is a data file

`sous init` creates `.sous/sous.config.jsonc`, not `sous.config.js`. Luke: "This kinda makes me want
`sous init` to create a `.json` file, by default. ... our config syntax, as JSON, is getting pretty
powerful, and the need for large/complicated configs is rapidly reducing." He confirmed the decision
("yes").

- A data file is one Sous can edit (`sous config set`, and later migrations and declared edits); a code
  config can only be reported on. Expressions, `${name}` variables and `$file` cover what a code config
  was needed for.
- JSONC rather than JSON, because the scaffolded config leans on its comments to be legible, and the
  config editor already keeps comments in JSONC.
- The file sets `$schema` to the schema published on GitHub with the running version
  (`https://raw.githubusercontent.com/sous-io/sous/v<version>/sous.config.schema.json`), so an editor
  can complete and check it. Sous ignores the key. (Agent's choice: the schema's own `$id` names a
  site that does not serve the file, and the tag pins it to the version that wrote the config.)
- A project may still write a `sous.config.js` by hand. Only what `sous init` creates changes.

### The starter content: no compile target for the instructions, no root `AGENTS.md`

The memories file is now compiled by each coding tool's plugin from `.sous/MEMORIES.tpl.md` (for Claude
Code, into `.claude/rules/SOUS-MEMORIES.md`). Keeping today's starter would give Claude Code the same
text three times. Decision (Luke, option 1):

- The starter is a plain project file, `.sous/memories/project.tpl.md`, holding only the project's own
  text, with no include line. It is written when there was nothing to import. Luke: "and we provide
  some generic, default, text for `project.md`". The text:

  ```markdown
  # <the project's name>

  {% comment %}
  Sous compiles this file, and every other file under `.sous/memories/`, into the
  instructions your coding tool reads in every session. Edit it and run `sous build`.
  {% endcomment -%}

  ## Working in this project

  - Describe the project here: what it is, how it is built, and how it is tested.
  - Add more files under `.sous/memories/` for longer topics. Each one is included
    automatically, in name order.
  - The memories of the recipes this project subscribes to are added after these files.
    `.sous/MEMORIES.tpl.md` controls what is included and in what order.
  ```

  In a recipe repository (one with a `sous.repo.yaml`), the same file says the repository is a Sous
  Repo and names the core skills an agent loads first.
- The scaffolded config has no compile target for the instructions, and no root `AGENTS.md` is
  written. A project can still add a target for `AGENTS.md` by hand.
- The config keeps its one other target, which compiles the project's own skills from `.sous/skills/`
  into `.claude/skills/` (agent's choice, see "Departures" below).

Rejected: also keeping a target that writes the project's text to a root `AGENTS.md` (Claude Code
would get it twice); and leaving the starter as it was.

### The memories source

`sous init` creates `.sous/MEMORIES.tpl.md` with the two default lines, each on its own line, under a
comment saying what each includes and that removing a line removes that part. Luke: "making it
obvious to the user how to override it".

```markdown
{% comment %}
Sous compiles this file into the memories file your coding tool reads in every session
(`.claude/rules/SOUS-MEMORIES.md` for Claude Code). Each line below includes one part:

  @memories/**/*.md    this project's own memories: every markdown file under `.sous/memories/`
  @#memories/**/*.md   the memories of every recipe this project subscribes to

Removing a line removes that part, and moving a line changes the order. Run `sous build` after
a change.
{% endcomment -%}
@memories/**/*.md
@#memories/**/*.md
```

### The root instruction files move into `.sous/`

`sous init` imported a root `CLAUDE.md` or `AGENTS.md` into `.sous/memories/imported/` and left the
file for the first build to compile over. No build writes those files now, so a file left at the root
would be read by a coding tool beside the compiled memories file, and the instructions would arrive
twice. So both root files are backed up to `.sous/backups/<date>/<time>/` and removed, whether they
were imported or skipped as a link, a pointer or a copy of the other, and git stops tracking them.
(Agent's choice, following from the decision above.)

### Ignore entries, written once

Luke: "I was saying that `sous init` should gitignore the stuff that it knows about. I did not mean to
imply that Sous should dynamically generate a .gitignore as the list of compiler outputs change."

- `sous init` writes a marked block in the project's own `.gitignore`, once, through the
  `host.gitignore` service. No build keeps it current, and there is no setting for it:

  ```text
  # >>> sous managed (do not edit between these markers)
  /.claude/rules/SOUS-MEMORIES.md
  /.claude/skills/
  /.claude/agents/
  /AGENTS.override.md
  # <<< sous managed
  ```

- `.claude/skills/` and `.claude/agents/` are ignored whole: Sous writes one entry per recipe item
  there and cannot list them by name at init time. A project that commits its own removes the line.
- Backups go in `.sous/.gitignore`, not the project's. Luke: "why not put backups in the
  `.sous/.gitignore`?" The managed block there holds `backups/`.

### No pending migrations

`sous init` stores the running version as `migratedVersion` in `.sous/sous.lock.json`, so a new project
has no pending migrations.

- The lockfile format (`formats.lockfile`) accepts an optional `migratedVersion`, a semver version.
- `recipes.lock`, the lockfile's owner, keeps the value already on disk when it writes a lockfile built
  without one, which is every lockfile a resolution builds.
- When `sous init` runs, the project does not exist yet for `recipes.lock`, so `sous init` writes the
  key the way that owner writes the file: through `formats.lockfile`, in its one stable form, keeping
  whatever a lockfile already there pins.
- Reading the key, and running pending migrations, belong to the migrations plugin.

## `sous init hooks`

### Why

Sous's outputs are git-ignored, so a new git worktree starts without them, and the Claude Desktop app
and some editors create worktrees and start sessions without running Sous. Luke: "that would 'just
work' for every, single, harness, eh? (we'd prompt the user for all of this)". Git runs
`post-checkout` after `git worktree add`, whoever ran it:

```text
a worktree is created, or a branch is checked out
  -> git runs the post-checkout hook
     -> the hook runs the project's install command (pnpm install, npm install, ...)
        -> the package manager runs a script from package.json
           -> sous build
```

### The command

Luke: "I want a new command: `sous init hooks` that all of this is packaged in." It is the intent
`init.hooks` in `plugin-init`.

- **With a `package.json`:** Husky is added as a dev dependency (`^9.1.7`), with no detection of other
  hook managers. Luke: "`sous init hooks` installs Husky when package.json is there, or a plain hook when
  its not. No detecting whatever, simple ops." `.husky/post-checkout` runs the package manager's
  install, on every branch checkout. Luke: "I'm ok with pm install running, even when we switch
  branches. The branches might have different deps and, ofc, the project can change the hooks, if they
  want."
- **The package script.** `sous build` goes into the script the manager runs after an install:
  `prepare` for npm and pnpm, `postinstall` for Yarn, whose newer versions do not run `prepare` on
  install (Luke chose option 1). Husky's own command goes in front when the script lacks it, because
  Husky turns its hooks on from that script. An existing script keeps what it has, and Sous's part runs
  after it. The guard `|| exit 0` makes a missing `sous` (an install without dev dependencies) or a
  failed build print its error without failing the install; `&&`, `||`, parentheses and `exit` work in
  sh, in Windows' cmd.exe and in Yarn's own shell.

  | Script before | Script after |
  | --- | --- |
  | none | `husky && sous build \|\| exit 0` |
  | `husky` | `husky && (sous build \|\| exit 0)` |
  | `tsc -b` | `tsc -b && (husky && sous build \|\| exit 0)` |

- **Without a `package.json`:** the repository's own `post-checkout` hook (`git rev-parse --git-path
  hooks`, which honours `core.hooksPath`) runs `sous build` directly, and nothing without a `sous`
  command.
- **The package manager** is detected through the `package-manager` entities (`ownerOf` in
  `plugin-update`), which gain `installCommand` and `afterInstallScript`, "so that a) the appropriate
  command is added to the hooks, and b) so the package manager's `install` can be run at the end."
- **The install at the end.** Sous asks before running it; `--install` and `--yes` run it,
  `--no-install` skips it. Luke: "`--yes`, again, runs them automatically (as needed)." Running it
  installs Husky, which is what turns the hooks on. A failed install is a warning: the hooks and the
  script are in place.
- **Which hooks.** `post-checkout` only by default; Sous asks whether to add `post-merge` and
  `post-rewrite`. Luke: "3 by default, prompt the user for more". `--pull-hooks` and `--no-pull-hooks`
  answer, and `--yes` takes the default, `post-checkout` only (the agent's reading, not objected to).
- **When each acts.** `post-checkout` acts on a branch checkout (its third argument is 1, which covers a
  new worktree and a clone), not on a checkout of single files. `post-merge` acts on every merge.
  `post-rewrite` acts after a rebase, not after an amend, which leaves the files as they were. (Agent's
  choice.)
- **A hook never stops git.** The hook prints any failure and exits 0, so git carries on.
- **An existing hook file** keeps its lines and gains Sous's block after them, between the markers
  `# >>> sous managed: init hooks (do not edit between these markers)` and
  `# <<< sous managed: init hooks`. Running the command again replaces the block and changes nothing
  else.
- **One-time.** Installing the hooks is an action of `sous init hooks`; no build puts them back, since a
  project may change its hooks.
- **Only `.sous/` at the top of the repository** is supported (Luke chose option 2). Anywhere else the
  command stops, says why, and prints the lines to add by hand: a hook line that changes into the
  project's folder first, and the script.

The hook file for pnpm:

```sh
# >>> sous managed: init hooks (do not edit between these markers)
# After a checkout, install the dependencies; the "prepare" script then runs `sous build`, so the
# files Sous writes match this checkout. A failure is printed, and git carries on.
if [ "$3" = "1" ]; then
  pnpm install || echo "sous: 'pnpm install' failed after a checkout; git carried on." >&2
fi
# <<< sous managed: init hooks
```

### What `sous init` does with it

- `sous init` asks whether to install the hooks when the project has a `.git` folder, before writing
  anything. `--hooks` and `--no-hooks` answer, and `--yes` installs them. Without a terminal and with
  none of these, it fails naming them (law L4). It then asks about the pull hooks, unless the project
  cannot have hooks.
- Where hooks are not supported, `sous init` reports why and the lines to add by hand, and goes on.
- When the install it ran will have run `sous build` through the package script, `sous init` skips its
  own build. Luke: "Doing this should negate the `sous build` that Sous already does (I think) at the
  end of an `init`." When the install is declined or skipped, `sous init` builds by itself, as before.
- `--no-build` also leaves the install out, since the install builds, unless `--install` asks for it.
  (Agent's choice.)

### Flags

| Command | Flag | Meaning |
| --- | --- | --- |
| `sous init` | `--hooks`, `--no-hooks` | Install the git hooks, or not |
| `sous init`, `sous init hooks` | `--pull-hooks`, `--no-pull-hooks` | Also install `post-merge` and `post-rewrite`, or not |
| `sous init`, `sous init hooks` | `--install`, `--no-install` | Run the package manager's install at the end, or not |
| `sous init`, `sous init hooks` | `--yes` | Every default: the hooks without the pull hooks, and the install |
| `sous init hooks` | `--dry-run` | Show the files and the install command, and change nothing |

## Places It Does Not Reach

- A tool that creates a worktree without checking files out.
- A cloud session, which starts from a fresh clone and runs no hooks; it needs the install in its own
  environment setup.
- A developer using Sous privately in a project that does not: Husky and the `prepare` script are
  committed changes. Designed later with the local-only mode.

## Departures

- **The project-skills target stays.** The ruling says the scaffolded config has no compile target; it
  was made about the target that compiled the instructions into a root `AGENTS.md`. The config's other
  target compiles the project's own skills, the ones `sous init` moves out of `.claude/skills/`; without
  it, those skills would never be compiled back. (Agent's choice.)
- **The root instruction files are removed** after being imported, with a backup, which the ruling did
  not say; see "The root instruction files move into `.sous/`".

## Changes

None yet.
