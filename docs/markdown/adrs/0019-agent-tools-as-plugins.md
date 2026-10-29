# ADR 0019: Agent tools are plugins, described by harness, skill and memory targets

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The source of truth is
[S6: Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) ("The machine",
"Skills", "Memories", "Harnesses", "Host and package-manager plugins"), with entities described in
[S1: The Engine](../architecture/specifications/S1-engine.md) ("Entities"). Where this record and
those files disagree, they win. It amends [ADR 0013](0013-one-ref-resolver.md) where it gives
`recipes.skills.outputs` a default.

## Context

Before 1.0, facts about Claude Code are spread through general code: `.claude/skills` is the
built-in default of `recipes.skills.outputs`, the `CLAUDE.md` and `AGENTS.md` pointer files are
written by the sous-directory helper, and launching a tool is code in `sous launch`. Supporting
another agent tool meant editing sous itself. One goal of the 1.0 architecture is that every core
feature works without any particular agent tool, and that features only one tool supports are
additions on top.

## Decision

- **Each agent tool is a plugin.** `plugin-claude-code` is built in and loaded unless disabled, so
  the default sous experience assumes Claude Code. Codex, and every other agent tool, is a separately
  installed plugin. No other plugin depends on a tool-specific one.
- **A tool plugin describes the tool with entities**:
  - a `harness` (the program that wraps a model), with an optional `launch`, `runHeadless` and
    `readTranscript`;
  - a `skill-target` (a place the tool reads skills from), with an optional transform of each file;
  - a `memory-target` (a file the tool reads into every session), with an optional `filter()` and
    `format()`.
- **Core has no default skills destination.** Skills go to every skill target and to every path in
  `recipes.skills.outputs`. With neither, the build skips the skills, says why, and names both
  fixes. With the built-in Claude Code plugin, skills land in `.claude/skills` as before.
- **Memories are placed by memory targets.** `plugin-memories` turns each memory target into a
  compilation target, by default one `@` include line per selected memory. The `#memories` name
  stays.
- **Pointer files come from plugins.** In each directory it creates, sous writes only its own
  `README.md`. A pointer file (a one-line file such as `CLAUDE.md` or `AGENTS.md` that tells an agent
  to read the README) comes from a `pointer-file` entity; `plugin-memories` adds one for every memory
  target the tool reads in any directory. Several plugins may name the same file; sous writes each
  once, and never overwrites a file that already exists.
- **A tool written under `tools` in the config launches with no plugin at all.**
- **Only `plugin-compiler` writes build outputs.** It overwrites by default and takes ownership;
  `compilation.overwriteUntracked: false` opts out.

## Consequences

- A project that disables `plugin-claude-code` and sets no `recipes.skills.outputs` gets no skills,
  with a message saying so.
- Sous's directories get an `AGENTS.md` pointer only when a plugin whose tool reads `AGENTS.md` is
  loaded.
- Adding support for an agent tool is a plugin, published to npm or shipped in a recipe (ADR 0017).
