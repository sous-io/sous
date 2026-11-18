# ADR 0035: `sous init` writes a JSONC config and the memories source, and installs git hooks

**Status:** Accepted, 2026-11-18.

This record supersedes part of [ADR 0024](0024-init-imports-agent-files.md): the source that compiled into both
`CLAUDE.md` and `AGENTS.md` (`.sous/memories/instructions.tpl.md`), the starter memory under
`.sous/memories/project/`, the root `.gitignore` lines `/CLAUDE.md` and `/AGENTS.md`, and the root instruction
files staying on disk for the first build to compile over. The rest of ADR 0024 stands: the import, the
included files, the skills, the backups and `sous repo init` running `sous init`. The design is specification
[S14](../architecture/specifications/S14-init-and-git-hooks.md).

## Context

The memories file is now compiled by each coding tool's plugin from `.sous/MEMORIES.tpl.md` (for Claude Code,
into `.claude/rules/SOUS-MEMORIES.md`), and Sous no longer writes a `CLAUDE.md`. The starter `sous init` wrote
would then give Claude Code the same text three times: through the memories file, through the recipes' memories
added again, and through the root `AGENTS.md` the starter compiled.

Sous's outputs are git-ignored, so a new git worktree starts without them. The Claude Desktop app and some
editors create worktrees and start sessions themselves, so Sous is never run there. Luke: "that would 'just
work' for every, single, harness, eh? (we'd prompt the user for all of this)".

The main config was a JavaScript module, which Sous cannot edit. Luke: "This kinda makes me want `sous init` to
create a `.json` file, by default. ... our config syntax, as JSON, is getting pretty powerful, and the need for
large/complicated configs is rapidly reducing."

## Decision

- `sous init` writes `.sous/sous.config.jsonc`, comments kept, with `$schema` pointing at the schema published
  with the running version. A project may still write a `sous.config.js` by hand.
- The config compiles no instructions and no root `AGENTS.md`; its one target compiles the project's own skills.
  The starter memory is `.sous/memories/project.tpl.md`, the project's own text with no include line. Luke: "and
  we provide some generic, default, text for `project.md`".
- `sous init` writes `.sous/MEMORIES.tpl.md` with the two default lines, `@memories/**/*.md` and
  `@#memories/**/*.md`, under a comment saying what each includes. Luke: "making it obvious to the user how to
  override it".
- A root `CLAUDE.md` or `AGENTS.md` is imported, then backed up and removed, since no build writes it now.
- The project's `.gitignore` gains, once, a marked block for `/.claude/rules/SOUS-MEMORIES.md`,
  `/.claude/skills/`, `/.claude/agents/` and `/AGENTS.override.md`. Luke: "I did not mean to imply that Sous
  should dynamically generate a .gitignore as the list of compiler outputs change." `backups/` stays in
  `.sous/.gitignore`.
- `sous init` stores the running version as `migratedVersion` in `sous.lock.json`, so a new project has no
  pending migrations.
- A new command, `sous init hooks`. Luke: "I want a new command: `sous init hooks` that all of this is packaged
  in." With a `package.json` it adds Husky and `.husky/post-checkout`, which runs the package manager's install
  on every branch checkout, and adds Husky and a guarded `sous build` to `prepare` (npm, pnpm) or `postinstall`
  (Yarn). Without one, the repository's own hook runs `sous build`. `post-merge` and `post-rewrite` are offered.
  The hook prints a failure and exits 0. Only a project whose `.sous/` is at the top of its repository is
  supported; anywhere else the command names the lines to add by hand.
- `sous init` asks whether to install the hooks when the project has a `.git` folder (`--hooks`, `--no-hooks`,
  `--pull-hooks`, `--install`; `--yes` installs `post-checkout` and runs the install), and skips its own build
  when the install it ran builds. Luke: "Doing this should negate the `sous build` that Sous already does (I
  think) at the end of an `init`."

## Consequences

- A new project's config can be changed by `sous config set` without a `conf.d` layer.
- A project's existing `CLAUDE.md` and `AGENTS.md` leave the root on `sous init`; their text reaches the agent
  through the memories file, and the originals are in `.sous/backups/`.
- A new worktree, or a branch checked out, gets Sous's output without anyone running Sous, once the hooks are
  installed and Husky has run.
- Installing Husky points git at `.husky/`, so in a project that used another hook manager, that manager's hooks
  stop running until the project sorts it out. Sous does not warn.
- An older sous refuses a lockfile holding `migratedVersion`, since the format is strict.
- `sous-plugin-init` depends on `sous-plugin-update`, for the package manager's install command.
