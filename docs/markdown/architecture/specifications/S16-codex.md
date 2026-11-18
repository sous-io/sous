# S16: Codex

**Status:** Accepted on 2026-11-17 (Luke's design for the memories file); built on 2026-11-18. From
now on, a change to this specification is recorded under "Changes".

**Serves:** G2 (a plugin system), G3 (versatility, always), G8 (every core feature works without any
particular agent tool), G9 (very fast), G10 (config as desired state).

**Trades:** G3 against G9. A Codex harness that every project had would cost every project one more
config build (S8). The plugin is therefore off until a project turns it on.

**Related:** S8 (one config build per harness), S9 (the editor), S14 (what `sous init` writes).

**Shaped by:** L1 (one concern, one owner: everything about Codex is in one plugin), L8 (declarations
as config: the `.gitignore` line is an entry of `editor.edits`).

## What This Specifies

How Sous supports Codex, OpenAI's coding agent: its harness, where Sous writes its instructions for
Codex, where it writes skills, and when any of it happens. The goal is the one stated for every tool:

> "Could we modify Sous so that it always works and never conflicts with the projects other, existing,
> instructions for all of the major tools?"
>
> "Figuring this out for Codex would be good, as well, since some Sous users will be using codex."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

**NOTHING HERE HAS BEEN RUN AGAINST CODEX.** Codex was not installed on the machine used. The design
rests on Codex's documentation and its source code (`openai/codex`, `codex-rs/core/src/agents_md.rs`,
commit `3aaa23a`). Luke ruled that it is built as designed, with these three points marked untested
until someone runs it:

1. that an `AGENTS.override.md` at the project root is read in place of `AGENTS.md`;
2. that a git-ignored `AGENTS.override.md` is read;
3. what happens when the project's instruction files together pass 32 KiB.

## What Codex Reads (from its documentation and source)

- At most one instruction file per folder, on the path from the project root (usually the git root)
  down to the folder it was started in, plus one home-level file. Nothing inside `.codex/`.
- In a folder holding `AGENTS.override.md`, that file IN PLACE OF the folder's `AGENTS.md`.
- No import syntax.
- `project_doc_max_bytes`, 32 KiB by default, for all project instruction files together; the file
  that crosses it is cut off.
- No project instruction file at all when the project is not trusted in Codex.
- Skills from `.agents/skills/`, loaded on demand rather than into every session.

Codex gives no second file that is always read beside `AGENTS.md`, so the override file is the only
whole file Sous can own.

## The Plugin

`@sous-io/sous-plugin-codex`, in `packages/sous-plugin-codex`, built in, loaded right after the Claude
Code plugin. Its one contributor, `codex/targets`, adds everything below, and only while Codex is on.

### When it is on

Codex is on for a project when its config holds either:

- `plugins.options."@sous-io/sous-plugin-codex"`, an object (`{}` is enough); or
- `tools.codex`, an object.

Otherwise the contributor adds nothing: no harness (so no extra config build, S8), no memories file,
no skills folder, no edit. Both reads are recorded, so writing either key later re-runs it, and
removing it takes everything away again on the next build. `plugins.disabled` still keeps the plugin
from loading at all.

The rule is the agent's (Luke left it open): an `AGENTS.override.md` silences the project's own
`AGENTS.md` for Codex, so a project that never asked for it must never get one.

### The harness

`codex`, with `launch` only: it runs `tools.codex.command` (default `codex`) in the project root with
`tools.codex.args` before the person's own arguments, as the Claude Code harness does. There is no
`runHeadless`: `codex exec` has its own output format, and nothing could be checked.

### The memories file

A `memory-target` entity, id `codex`, harness `codex`:

| Field | Value |
|---|---|
| `outputPath` | the option `memoriesOutputPath`, default `${projectRoot}/AGENTS.override.md` |
| `prependWith` | the option `prependMemoriesWith`, default `${projectRoot}/AGENTS.md` |
| `backupExisting` | `true` |
| `readIn` | `project-root` |
| `fileName` | the last part of `outputPath` (today's `memory-target` schema requires it) |

A relative path in either option is put under `${projectRoot}`; one that starts with a variable or is
absolute is kept as written. The option `memories: false` adds no memory target.

What these fields do belongs to `@sous-io/plugin-memories`, whose contributor turns the entity into a
compilation target: the file named by `prependWith` comes first (skipped silently when missing), then
the memories, from `.sous/MEMORIES.tpl.md` or its default; the output is marked `harness: "codex"`
from the entity's `harness`, so the merge of S8 takes it from the Codex build; and an existing file
Sous did not write is backed up to `.sous/backups/` with a warning before it is overwritten. Luke on
that last point:

> "nah, we'll overwrite it. But the backup mechanism we already discussed could be used to preserve
> it, and we should issue a warning."
>
>   -- **Luke Chavers** in an agent session (2026-11-17)

The three fields were added to `memory-target` in a branch built at the same time as this plugin. The
plugin declares them in its own types (`MemoryTargetOutputFields`) and casts once, in a marked place,
so the two join without edits.

### Keeping the file out of git

`sous init` writes `/AGENTS.override.md` into the project's `.gitignore` (S14). The plugin also adds
one entry to `editor.edits` (S9) while Codex is on and memories are on:

```js
{ file: ".gitignore", ensureLine: { line: "/AGENTS.override.md" } }
```

The line follows `memoriesOutputPath` when it is inside the project; a file outside the project gets
no line. The entry is added only when the editor's `editor` config key exists. Because the editor
undoes an entry that is no longer declared, turning Codex off removes the line again, unless it was
already there before Sous added it.

### Skills

A `skill-target` entity, id `codex`, harness `codex`, `directory` from the option `skillsDirectory`,
default `.agents/skills`. The folder is NOT added to `.gitignore`: other tools read `.agents/skills/`
too, and a project may keep its own skills there. This location is also untested.

## Rejected

- Keeping the Claude Code path, `.claude/rules/SOUS-MEMORIES.md`, as Codex's default: Codex never
  reads it.
- Putting the memories in `developer_instructions` in `.codex/config.toml` as a declared edit: it needs
  TOML support in the editor first, and a project Codex trusts.
- Registering the harness and targets in `register`, always: every project would get a Codex config
  build and an `AGENTS.override.md`.

## Known Limits

- **32 KiB.** The project's `AGENTS.md` plus the memories can pass Codex's limit and be cut off. A size
  assertion on the output (S9) is one way to be told.
- **Staleness.** The override goes stale when someone edits `AGENTS.md` and does not rebuild.
- **An untrusted project** reads no project instruction file at all, override included.

## Changes

### 2026-11-18: Built

First version, written when the design was built. Choices the agent made where the design left them
open, approved by nobody yet:

- The plugin is off until `plugins.options."@sous-io/sous-plugin-codex"` or `tools.codex` is written.
- The harness has `launch` only.
- The `.gitignore` line is declared as an editor edit, besides the line `sous init` writes.
- The skills folder is `.agents/skills`, taken from Codex's documentation, and is not git-ignored.
- `memories: false` and `skillsDirectory` options, mirroring the Claude Code plugin.
