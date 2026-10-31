# ADR 0019: Agent tools are plugins, described by harness, skill and memory targets

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The details are in
[Concerns and Owners](../architecture/specifications/S6-concerns-and-owners.md) (its sections on
skills, memories and harnesses), with entities explained in
[the engine specification](../architecture/specifications/S1-engine.md). Where this record and those
files disagree, they win. It amends [ADR 0013](0013-one-ref-resolver.md) where it gives
`recipes.skills.outputs` a default.

## Context

Before 1.0, facts about Claude Code are spread through general code: `.claude/skills` is the
built-in default of `recipes.skills.outputs`, the `CLAUDE.md` and `AGENTS.md` pointer files are
written by the code that creates sous's directories, and launching a tool is code inside
`sous launch`. Supporting another agent tool meant editing sous itself. One goal of the 1.0
architecture is that every core feature works without any particular agent tool, and that features
only one tool supports are added on top.

## Decision

- **Each agent tool is a plugin.** The Claude Code plugin is built in and loaded unless disabled,
  so sous works with Claude Code out of the box. Every other agent tool, Codex included, is a plugin
  installed separately. No other plugin depends on a tool-specific one.
- **A tool plugin describes its tool with entities**, records of a kind another plugin defines and
  reads. There are three kinds:
  - a **harness**: the program that wraps a model, which sous may launch, run without a terminal, or
    read a transcript from;
  - a **skill target**: a place the tool reads skills from;
  - a **memory target**: a file the tool reads into every session.
- **Core has no default place for skills.** Skills go to every skill target and to every path in
  `recipes.skills.outputs`. With neither, the build skips the skills and says why and how to fix it.
  With the built-in Claude Code plugin, skills land in `.claude/skills` as before.
- **Memories are placed by memory targets.** Each memory target becomes a file sous compiles, by
  default one `@` include line per selected memory. The `#memories` name stays.
- **Pointer files come from plugins.** In each directory it creates, sous writes only its own
  `README.md`. A pointer file (a one-line file such as `CLAUDE.md` or `AGENTS.md` that tells an agent
  to read the README) is added for each memory target's file name. Sous writes each pointer once and
  never overwrites a file that already exists.
- **A tool written under `tools` in the config launches without any plugin.**
- **Only the compiler writes build outputs.** It overwrites by default and takes ownership of the
  file; `compilation.overwriteUntracked: false` turns that off.

## Consequences

- A project that disables the Claude Code plugin and sets no `recipes.skills.outputs` gets no
  skills, with a message saying so.
- Sous's directories get an `AGENTS.md` pointer only when a plugin for a tool that reads
  `AGENTS.md` is loaded.
- Adding support for an agent tool means writing a plugin, published to npm or shipped in a recipe
  ([ADR 0017](0017-recipes-ship-plugins.md)).
