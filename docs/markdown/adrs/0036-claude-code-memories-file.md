# ADR 0036: Claude Code's memories go to `.claude/rules/SOUS-MEMORIES.md`, compiled from `.sous/MEMORIES.tpl.md`

**Status:** Accepted, 2026-11-18.

The design is specification [S15](../architecture/specifications/S15-claude-code.md), section 3 (the file) and
section 6 (the migration).

## Context

Before this record, Sous's Claude Code plugin compiled the subscribed recipes' memories into the root
`CLAUDE.md`, one include line per memory. That file is the project's own place for instructions, and any
`CLAUDE.md` makes Claude Code ignore `AGENTS.md`, so a project with both got its own text silenced. A file under
`.claude/rules/` is loaded by Claude Code beside any `CLAUDE.md`, from any sub-folder, under `claude -p`, and
without silencing `AGENTS.md` (tested on 2026-11-17).

## Decision

> "we will write to one file, overridable, but defaulted to `.claude/rules/SOUS-MEMORIES.md`."
>
> "If [the file] exists, it will use that as the source. If it does not exist, the default will basically be
> `@memories/**/*.md\n@#memories/**/*.md`."
>
>   -- **Luke Chavers** (2026-11-17)

- One file per harness. For Claude Code it is `.claude/rules/SOUS-MEMORIES.md`, moved by the plugin option
  `memoriesOutputPath` (Luke's name), and switched off by `memories: false`.
- Its source is `.sous/MEMORIES.tpl.md` when it exists, and otherwise the two default lines read as if written in
  `.sous/`: the project's own memories, then the recipes'. There are no separate switches for the two parts;
  Luke: "this `MEMORIES.tpl.md` provides a way for users to override it and disable/etc."
- An empty result writes no file and removes one an earlier build wrote.
- The `memory-target` entity is now `{ id, harness?, outputPath, prependWith?, backupExisting? }`.
  `prependWith` names a file placed before the memories (skipped when missing); `backupExisting` backs up,
  warns about and replaces a file Sous did not write at `outputPath`. The old fields are refused by name.
- A project upgraded from the old default is asked once, by `sous doctor` or `sous upgrade`, whether to move
  (default) or keep. Luke asked for a migration that offers "to move their CLAUDE.md output to the new path, or if
  they'd like to keep output pointed at the root CLAUDE.md." On `move`, a second question, default `no`, offers to
  remove a now-duplicating `@#memories/**/*.md` line from the project's own source (Luke chose option 1: find the
  lines, show them, ask). `--yes` takes `move` and `no`; `--answer` answers either.

Rejected by Luke: two files, one for the project's memories and one for the recipes' (Claude Code orders rules
files by how the filesystem lists them, not by name); on/off settings for each part; only reporting the
duplicating line; not offering `move` when such a line exists.

## Consequences

- Sous never writes over a project's `CLAUDE.md` or `AGENTS.md` unless the project points `memoriesOutputPath`
  there.
- A project upgraded without answering the migration gets the recipes' memories in both files until it does;
  every command says migrations are waiting.
- Inline memories reach the default file, because the default is written out line by line; a project's own
  `.sous/MEMORIES.tpl.md` with `@#memories/**/*.md` still leaves them out, since `#memories` lists only files.
