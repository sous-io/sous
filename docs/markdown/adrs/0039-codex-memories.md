# ADR 0039: Sous writes Codex's memories to a git-ignored `AGENTS.override.md`

**Status:** Accepted, 2026-11-17 (Luke); built 2026-11-18. Untested against Codex.

The living answer is [S16: Codex](../architecture/specifications/S16-codex.md) and the user page
[Codex](../codex.md). The issue is [gh-238](https://github.com/sous-io/sous/issues/238).

## Context

Sous should get its instructions to every coding agent without touching an instruction file the project
already has.

> "Figuring this out for Codex would be good, as well, since some Sous users will be using codex."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

Codex reads one instruction file per folder, from the project root down, and nothing inside `.codex/`.
It has no second file that is always read beside `AGENTS.md`. A folder's `AGENTS.override.md` is read
in place of its `AGENTS.md`. None of this could be run: Codex was not installed on the machine used,
so it comes from Codex's documentation and source code.

## Decision

- Sous writes a git-ignored `AGENTS.override.md` at the project root, holding the text of the
  project's `AGENTS.md` first and Sous's memories after it. The project's `AGENTS.md` is never
  touched, and Codex sees both.
- Where it goes is a setting, `memoriesOutputPath`, default `${projectRoot}/AGENTS.override.md`:
  "We'll allow users to specify its memory output location" (Luke).
- The file placed first is a setting, `prependMemoriesWith`, default `${projectRoot}/AGENTS.md`
  (Luke named both settings), skipped silently when missing.
- An `AGENTS.override.md` Sous did not write is backed up, warned about, and overwritten:

    > "nah, we'll overwrite it. But the backup mechanism we already discussed could be used to
    > preserve it, and we should issue a warning."
    >
    >   -- **Luke Chavers** in an agent session (2026-11-17)

- All of it lives in a new built-in plugin, `@sous-io/sous-plugin-codex`, with the `codex` harness
  for `sous launch codex` and a skills folder at `.agents/skills`.
- The agent's rule, where Luke left it open: the plugin does nothing until the project writes its
  options or `tools.codex`. A project that never uses Codex gets no override file (which would
  silence its `AGENTS.md` for Codex) and no extra config build.
- Luke ruled that it is built as designed, with three points marked untested: that the root override
  is read in place of `AGENTS.md`, that a git-ignored one is read, and what happens past 32 KiB.

## Consequences

- Codex cuts its project instruction files off at 32 KiB by default; `AGENTS.md` plus the memories
  can pass that.
- The override goes stale when `AGENTS.md` is edited and nobody rebuilds.
- Codex reads no project instruction file in a project it does not trust, so neither file reaches it
  there.
- Projects using Codex pay one more config build per command (S8).

Rejected: Claude Code's path (`.claude/rules/SOUS-MEMORIES.md`) as Codex's default, since Codex never
reads it; `developer_instructions` in `.codex/config.toml`, which needs TOML editing and a trusted
project; refusing to overwrite an existing override file.
