# S15: Claude Code

**Status:** Accepted on 2026-11-18, from Luke's rulings of 2026-11-15 to 2026-11-18 quoted below; built on
2026-11-18. From now on, a change to this specification is recorded under "Changes".

**Serves:** G8 (every core feature works without any particular agent tool: what only Claude Code reads is owned
by Claude Code's plugin), G3 (versatility: the memories file can be moved, emptied or switched off; a recipe can
ship a plugin or an agent), G10 (config as desired state: every file below is a compilation target in the config),
G4 (predictable and observable: `sous config show` names each output's harness).

**Related:** S6 (concerns and owners), S8 (one config build per harness), S10 (includes), S11 (migrations),
S12 (manifests as config, open content kinds), S14 (init).

**Shaped by:** L8 (declarations as config).

## What This Specifies

What `@sous-io/sous-plugin-claude-code` gives Sous, beyond launching Claude Code:

1. The harness id `claude-code`, and its settings key `tools.claude-code`.
2. Every output written for Claude Code marked with that harness.
3. One memories file, by default `.claude/rules/SOUS-MEMORIES.md`, and the `memory-target` entity that names it.
4. Two content kinds, `claude-code-plugin` and `claude-code-agent`.
5. The line telling the person to run `/reload-plugins`.
6. Two migrations, for projects upgraded from before these changes.

## 1. The Harness Id

> "its better to be overly verbose than regret inspecificity later."
>
>   -- **Luke Chavers** (2026-11-17)

A bare `claude` would be ambiguous beside a later harness for another Claude product (such as Claude Desktop). So:

- The `harness` entity's id is `claude-code`. Conditions read `harness.id == 'claude-code'`.
- The user's settings for it are `tools.claude-code` (`command`, `args`, `promptFile`, `headless`). The command
  run is still `claude` unless `command` says otherwise.
- `sous launch claude-code` starts it. **`sous launch claude` is not an alias.** Keeping it would bring back the
  short name the rename removes. Instead, when `launch` finds no tool by the name given, and some tool's id starts
  with that name and a hyphen, the error suggests it:

  ```text
  Tool 'claude' not found.
    Did you mean: sous launch claude-code
    Available tools: claude-code, codex
  ```

  (Agent's choice. The rule is general, in `sous-plugin-harnesses`, not a special case for Claude Code.)

## 2. Outputs Marked With a Harness

Every compilation output that `sous-plugin-skills`, `sous-plugin-memories` and `sous-plugin-claude-code` add for Claude Code
carries `harness: "claude-code"`, so the merge of S8 takes it from Claude Code's config build.

- `sous-plugin-skills` marks each output written into a `skill-target` with that entity's `harness`. A directory named
  only in `recipes.skills.outputs` has no harness, so its outputs stay unmarked.
- `sous-plugin-memories` marks each memory target's output with the `memory-target` entity's `harness`.
- The two content kinds (section 4) mark every output `claude-code`.

## 3. The Memories File

> "we will write to one file, overridable, but defaulted to `.claude/rules/SOUS-MEMORIES.md`."
>
> "If [the file] exists, it will use that as the source. If it does not exist, the default will basically be
> `@memories/**/*.md\n@#memories/**/*.md`."
>
>   -- **Luke Chavers** (2026-11-17)

A file under `.claude/rules/` is loaded by Claude Code beside any `CLAUDE.md`, from any sub-folder, under
`claude -p`, and without silencing a project's `AGENTS.md` (tested on 2026-11-17). Writing there means Sous never
writes over the project's own instruction files.

### The `memory-target` entity

A harness's plugin adds one `memory-target` for the one file that harness reads into every session. The fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | `claude-code`, `codex`. The compilation target is `memories/<id>`. |
| `harness` | `string?` | The harness that reads the file; its output is marked with it. |
| `outputPath` | `string` | The file to write. May hold `${projectRoot}` and other config variables; a relative path is under the project root. |
| `prependWith` | `string?` | A file whose content comes before the memories, included as an `@` line includes a file (a `.tpl.` file is rendered and its includes followed). Skipped silently when it does not exist. |
| `backupExisting` | `boolean?` | When true and a file Sous did not write is at `outputPath`, it is backed up under `.sous/backups/`, a warning says so, and it is overwritten, whatever `compilation.overwriteUntracked` says. Unset or false, the compiler's general rule applies. |

The fields it had before (`fileName`, `directory`, `readIn`, `filter`, `format`) are refused by name, so a plugin
written for them fails with a message naming `outputPath`. `filter` and `format` have no meaning now: what a file
holds is decided by its source, not by the plugin.

Claude Code's memory target:

```js
{
    id: "claude-code",
    harness: "claude-code",
    outputPath: "${projectRoot}/.claude/rules/SOUS-MEMORIES.md",   // the memoriesOutputPath option
    backupExisting: true,
}
```

The plugin's options: `memoriesOutputPath` (Luke's name) sets `outputPath`; `memories: false` adds no memory
target at all.

### The source

- `.sous/MEMORIES.tpl.md`, when it exists, is the whole source. `sous init` creates it with the two default lines
  (S14).
- Otherwise the source is the default: the two lines, read as if written in a file inside `.sous/`.

  | Line | What it includes |
  |---|---|
  | `@memories/**/*.md` | The project's own files under `.sous/memories/` |
  | `@#memories/**/*.md` | The subscribed recipes' memories, in the order of `#memories` |

  The contributor writes the default out as the include lines it stands for: the project's files as one glob line,
  and the recipes' memories as one line each, in selection order. A memory a manifest gives inline
  (`{ $inline, path }`) has no file, which `#memories` cannot list, so writing the lines out is what lets inline
  memories reach the file. (Agent's choice; Luke's "basically" left the form open.)
- Every path in the generated content is absolute, as found on disk. (Agent's choice, forced by a defect: a
  `${sousDir}` in an include path is not filled in during `sous init`'s own first build.)

### Empty results

> "A glob that matches nothing should simply do nothing."
>
>   -- **Luke Chavers** (2026-11-17)

- With no source file, no file to prepend, no project memories and no recipe memories, no compilation target is
  added.
- Otherwise the target carries the transform `memories/skip-empty`, which leaves out a file that compiled to
  nothing but white space. The compiler no longer counts an output a transform left out as produced, so a copy an
  earlier build wrote is removed by the prune that follows.
- Sous creates the `.claude/rules/` folder, as it creates any output's folder.

### The pointer file

Claude Code reads a `CLAUDE.md` in every folder it works in, so each folder Sous creates gets a one-line
`CLAUDE.md` pointing at the folder's README. That `pointer-file` entity was a side effect of the old memory
target (`readIn: "any-directory"`); `sous-plugin-claude-code` now adds it directly, whether or not memories are on.

## 4. Content Kinds for Claude Code

> "perhaps we should just scope the 'kind' to the harness or harness family. `kind: claude-plugin`."
>
>   -- **Luke Chavers** (2026-11-17), before choosing `claude-code-plugin`

> "Sous should include a new `kind` for `claude-code-agent`. Those agent files are Claude-specific."
>
>   -- **Luke Chavers** (2026-11-17)

`sous-plugin-claude-code` registers both as `content-kind` entities (S12) and its contributor `claude-code/kinds`
responds to their `recipes.contents` entries. Only this plugin consumes them, so a group of either kind produces
outputs for Claude Code alone, with no harness condition in the recipe.

```yaml
contents:
  - kind: claude-code-plugin
    include:
      - plugins/**
  - kind: claude-code-agent
    include:
      - agents/**/*.md
```

| Recipe file | Output |
|---|---|
| `plugins/session-harness/.claude-plugin/plugin.json` | `.claude/skills/session-harness/.claude-plugin/plugin.json` |
| `plugins/session-harness/scripts/start.tpl.sh` | `.claude/skills/session-harness/scripts/start.sh` |
| `agents/reviewer.tpl.md` | `.claude/agents/reviewer.md` |
| `agents/review/security.md` | `.claude/agents/review/security.md` |

- One compilation target per file, `claude-code-plugin/<recipe>/<path>` or `claude-code-agent/<recipe>/<path>`,
  with the include pattern's fixed part as `globBase`, so the output keeps the path under it. A plugin goes under
  the skills directory (the `skillsDirectory` option, default `.claude/skills`); agents under `.claude/agents`.
- A `.tpl.` file is rendered with the recipe's variables (the target's origin names the recipe); any other file is
  written as the compiler writes any untemplated file. Inline content is a `content` target, rendered only when its
  path holds `.tpl.`.
- The first way of shipping a plugin, listed among `skills` with an `exclude` carrying
  `harness.id != 'claude-code'`, works unchanged (S12).

Rejected by Luke, not to be built: a `harness` key on a `contents` group; a second group in its own folder for
the first way; a shorter spelling turned into the harness condition; a notice when a plugin brings hooks ("trust
is trust. we dont need a notice."); a check that the plugin loaded.

## 5. The `/reload-plugins` Line

Claude Code loads a project's plugins when a session starts or on `/reload-plugins`. Luke ruled the line in
(2026-11-17). When a build adds, changes or removes any file under a folder that holds
`.claude-plugin/plugin.json`, however the recipe shipped it, the build ends with one line:

```text
A Claude Code plugin changed (session-harness). Run /reload-plugins in any open Claude Code session.
```

- It listens to `compiler.wrote` (files `created` or `updated`, or their dry-run forms) and `compiler.pruned`,
  per command chain, and prints at `build.after`, through the chain's reporter.
- A file's plugin is the nearest folder at or above it, inside the project, that holds the manifest, or held it
  until this build removed it.
- Several plugins are named in one line; a dry run says "would change ... after the build".
- This recognition drives nothing else.

## 6. Migrations

Both belong to sous 1.1.0 (the release the `_if` migration of S11 names too), and are added with
`sous.migrations.add`.

### `claude-code/tools-key` (order 400)

Renames `tools.claude` to `tools.claude-code` in the project's main config and every `conf.d` file that is JSON,
JSONC or YAML, surgically through the document library. A file that is code, or a patch file, that seems to set
the key is named in the outcome with what to change. A file setting both keys is left alone and named. It asks
nothing.

### `claude-code/memories-file` (order 500)

> "when projects upgrade to this new ver, I'd like a migration to offer to move their CLAUDE.md output to the new
> path, or if they'd like to keep output pointed at the root CLAUDE.md."
>
>   -- **Luke Chavers** (2026-11-18)

It applies when the project's last build wrote the root `CLAUDE.md` from the old target `memories/claude-code`,
or the old default would have (recipes with memories, and no target of the project's own writing `CLAUDE.md`), or
a source of the project's own that writes `CLAUDE.md` holds the line `@#memories/**/*.md`.

| Question | Values | Default |
|---|---|---|
| `claude-code.memories` | `move`, `keep` | `move` |
| `claude-code.memories.remove-line` | `yes`, `no` | `no` |

- `move`: writes `.sous/MEMORIES.tpl.md` with the two default lines, unless it exists. With the second answer
  `yes`, removes each line `@#memories/**/*.md` from the project's own sources for `CLAUDE.md` (a line that stood
  between two blank lines takes one of them along, so no doubled blank line is left); with `no`, leaves
  them and says the memories will be read twice. Sources under `.sous/memories/` that the project also compiles
  elsewhere are named in the outcome.
- `keep`: sets `plugins.options."@sous-io/sous-plugin-claude-code".memoriesOutputPath` to `${projectRoot}/CLAUDE.md`
  through `config.set` (in the main config when it is JSON, JSONC or YAML, else in
  `conf.d/600-claude-code-memories.jsonc`), and writes `.sous/MEMORIES.tpl.md` with only the recipes' line, so
  `CLAUDE.md` holds what it held.
- Nothing to migrate, `memories: false`, or `memoriesOutputPath` already set: the first question is answered from
  the config, nothing is asked, nothing changes.
- The second question stands down (answered `no`) when the first is `keep` or no such line exists. For that, the
  migrations plugin now passes each question's `answered` the answers given before it in the same migration.
- Running it again changes nothing more.

## Open Questions

- The second question's text cannot name the lines it found: a question's message is fixed when the migration is
  added. The outcome names them.
- `#memories` cannot list inline memories, so a project's own `.sous/MEMORIES.tpl.md` with `@#memories/**/*.md`
  leaves them out, as it did before.
- In `sous init`'s own first build, `${sousDir}` in a path is not filled in (the state file lands in a folder
  literally named `${sousDir}`). This specification works around it; the defect is the init and build streams'.
- The tools-key migration searches only the project's own config files (the main one and `conf.d`), not any
  personal config outside the project.

## Changes

### 2026-11-18: Built

First version, written when the design was built. Choices the agent made where the rulings left them open,
approved by nobody yet: no `sous launch claude` alias, with a hint instead; the default source written out line by
line; absolute include paths; the `skip-empty` transform and the compiler's prune of an output a transform left
out; `backupExisting` as an output field the compiler honors; the pointer file added by `sous-plugin-claude-code`;
the migrations' version 1.1.0 and the `conf.d` file for `keep`; the migrations plugin passing earlier answers to
`answered`.
