# ADR 0024: `sous init` imports a project's agent files, and sous owns them

**Status:** Accepted, 2026-11-15.

This record supersedes part of [ADR 0003](0003-project-init.md): the starter prompt, which compiled
only to `AGENTS.md`, and the idea that init only writes new files. It supersedes part of
[ADR 0006](0006-repo-init-model-home.md): the scaffold no longer writes `CLAUDE.md` or `AGENTS.md`,
and those two files are no longer repository documents sous never compiles. It also changes one reason
in [ADR 0001](0001-repositories.md): a recipe repository now has a `.sous/` directory, although the
`sous repo` commands still find the repository by its manifest rather than by config discovery. The
rest of all three records stands. The living answer is the `sous init` and `sous repo init` entries in
the [command reference](../commands.md).

## Context

Most projects that try sous already have agent files: a root `CLAUDE.md` or `AGENTS.md`, often with
`@path.md` lines that pull in other files, and skills in `.claude/skills/`. Before this record,
`sous init` wrote its own starter prompt beside them and compiled it to `AGENTS.md`, and the Claude Code
plugin's memory target compiled recipe memories to `CLAUDE.md`. The compiler overwrites files it did
not write by default, so the first build replaced whatever the project had at those paths. A project's
instructions were lost on the very first run, and the person who lost them had to find them in git.

Two smaller problems sat beside that one. An include that matches nothing stops a build, so a source
that includes a folder of the project's own memories fails when that folder is empty. And a recipe
repository was not a sous project: its `CLAUDE.md` and `AGENTS.md` were written once by
`sous repo init` and then edited by hand, so an agent working in the repository had no core skills
installed (only links to read them online), and the repository could not use a recipe's skills or
memories for its own work.

## Decision

### Import, instead of overwrite

- `sous init` imports the project's existing agent files into `.sous/` before the first build, so the
  build that compiles `CLAUDE.md`, `AGENTS.md` and `.claude/skills/` never loses what a person wrote
  there.
- A root `CLAUDE.md` or `AGENTS.md` is copied to `.sous/memories/imported/` as plain `.md`, never
  `.tpl.md`, so Liquid never touches text that was not written for it. A file that is a symlink to the
  other, holds the same text, or only points at the other (at most 3 non-blank lines and 400
  characters, naming the other file) is skipped, so the instructions are not imported twice.
- Every `@` reference in a copied file is rewritten to work from its new place: an include relative to
  the copy, an include of a file left in place as `@#project/<path>`, and any other reference relative
  to the project root, because Claude Code resolves those from the compiled file at the root. An
  include that names a missing file becomes an HTML comment, with a warning: Claude Code ignores a
  missing file, and sous stops the build on one.
- Skills in `.claude/skills/` move to `.sous/skills/`. The config always has a project-skills target
  compiling `.sous/skills/` into `.claude/skills/`, and init answers `skillsRoot` with `.sous/skills`
  in `.sous/.env`, so the skills the `create-skill` skill writes later are compiled too. A glob target
  whose folder does not exist yet compiles nothing without a warning, so a project with no skills of
  its own does not warn on every build.
- `.claude/agents/`, `.claude/commands/` and `.claude/settings.json` are left alone.

### Included files move by default, with three switches

- A file the instructions include (a line holding only `@path.md`, followed recursively) is moved,
  copied or left in place. Moving is the default because it leaves one copy of each file, under
  `.sous/` with the rest of the sources; copying leaves two copies that can drift apart, and leaving
  keeps a project's instructions split between `.sous/` and the rest of the tree.
- `--move-includes`, `--copy-includes` and `--leave-includes` answer ahead of time, one at a time.
  In a terminal, init lists the included files and asks once: move, copy, leave, or choose for each
  file. `--yes` accepts the default. With no terminal and none of these flags, init fails naming
  them, as every question in sous has a flag. A dry run plans with the default and asks nothing.
- A README stays where people look for it, and a file outside the project is not the project's to
  move. A file included by a file that stays is copied rather than moved, so the file that stays
  still finds it.

### Included files live outside `memories/`

- Moved and copied files go to `.sous/includes/<path from the project root>`. The instructions source
  includes every markdown file under `.sous/memories/`, and an included file must appear only where its
  include line is. Under `memories/` it would appear twice: once through the glob, once through its
  include line.

### One source, both instruction files

- The scaffolded config compiles `.sous/memories/instructions.tpl.md` (renamed from
  `memories/AGENTS.tpl.md`) into both `CLAUDE.md` and `AGENTS.md`. The source holds no instructions
  itself; it includes `@*/**/*.md` (every markdown file in a folder beside it: the project's own
  memories, such as `imported/` and `conventions/`) and then `@#memories/**/*.md` (the recipes'
  memories).
- The project's own targets win. When a target from the project's config writes a file that a
  plugin's or a recipe's target would also write, the other output is dropped. A plugin's target, such
  as the Claude Code memory target for `CLAUDE.md`, yields silently, because yielding is what it is
  for. A recipe's output yields with a warning, so a project skill with the same name as a recipe skill
  wins, and the user is told. Before this record only plugin targets yielded; a project that
  customized a recipe skill had two targets writing one file in turn.

### The memories folder is never empty

- An include glob that matches nothing stops the build, which is the right rule for a typo and the
  wrong outcome for a new project. So when nothing was imported, init writes a starter memory at
  `.sous/memories/project/overview.tpl.md`, or `.sous/memories/project/sous-repo.tpl.md` in a recipe
  repository (one with `sous.repo.yaml`). The repository's memory says it is a Sous Repo and names the
  core skills an agent loads before changing anything.
- The include rule itself is unchanged: the folder is kept non-empty, rather than letting this one
  glob match nothing.

### Everything moved is backed up

- Before init moves anything it copies it to `.sous/backups/<YYYY-MM-DD>/<HHMM-SS>/<path>`, the folder
  the compiler's own backups use, which the `.sous/.gitignore` managed block now ignores (`backups/`).
  A move can always be undone, whatever git knew about the file.

### Sous owns the project's agent configuration

- `CLAUDE.md`, `AGENTS.md` and `.claude/skills/` at the project root are build output. Init adds them
  to a sous-managed block in the project-root `.gitignore` (`/CLAUDE.md`, `/AGENTS.md`,
  `/.claude/skills/`) and stops git tracking them and the moved skill folders (`git rm -r --cached`);
  the files stay on disk until the build compiles over them.
- Committing build output invites the edits sous exists to prevent, and lets the committed copy drift
  from its sources. The cost is that `sous build` is required after cloning, and the README and
  CONTRIBUTING files a recipe repository is scaffolded with say so.

### `sous repo init` runs `sous init`

- A recipe repository is a sous project. After the scaffold, `sous repo init` runs `sous init` in the
  same directory, passing `--yes`, `--move-includes`, `--copy-includes`, `--leave-includes`,
  `--no-build` and `--dry-run` through. A directory that already holds a sous config keeps it, and init
  is skipped with a note.
- The scaffold no longer writes `CLAUDE.md` or `AGENTS.md`, and its `.gitignore` no longer lists
  `.sous/` files, which `.sous/.gitignore` now covers. The repository's agent instructions come from the
  starter memory, which names the core skills, and every build installs those skills at the running
  sous's version, so an agent reads how the installed sous works rather than how the one that made the
  repository did.

## Consequences

- A project's first `sous init` keeps every instruction it had, rewritten to work from `.sous/`, and
  the first build compiles the same instructions back to the same places, with recipe memories after
  them.
- Collaborators of a project set up this way, and of every recipe repository `sous repo init` creates,
  must run `sous build` after cloning before their agent sees any instructions.
- A project skill now shadows a recipe skill of the same name everywhere, with a warning on each build.
- `sous-plugin-authoring` depends on `sous-plugin-init`, and sits above it in the plugin dependency graph (S6,
  concerns and owners).
- A repository scaffolded by an older sous keeps its hand-written `CLAUDE.md` and `AGENTS.md`; running
  `sous init` in it imports them.
