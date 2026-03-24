---
name: about-agent-skills
description: >
  YOU MUST load this skill when creating, editing, auditing, or reasoning about any
  skill. Covers skill structure, frontmatter fields, invocation, topic vs action
  patterns, naming conventions, and general principles.
user-invocable: false
---

# About Agent Skills

A skill is a directory containing a `SKILL.md` file and optional supporting files.
Skills extend what a coding agent can do — invoke them directly with `/skill-name`,
or they load automatically when the agent's decision logic matches the `description`.

## Where Skills Live

Skills for this project live at `{{ skillsRoot }}`. Create and edit skills there —
never in `.claude/skills/` or `.codex/skills/` directly. See `create-skill` for
step-by-step instructions.

## Directory Structure

```
my-skill/
├── SKILL.md        # Required. Frontmatter + instructions.
├── references/     # Optional. Deep-dive docs loaded when needed.
├── examples/       # Optional. Example outputs.
└── scripts/        # Optional. Executable scripts.
```

Supporting files must be referenced from `SKILL.md` — the agent will not know they
exist otherwise. Keep `SKILL.md` under ~500 lines; move detailed reference material
to `references/` files.

## Core Frontmatter

```yaml
---
name: my-skill
description: >
  One or two sentences describing when the agent should invoke this skill.
  Under 500 characters. Write as a trigger condition, not a title.
disable-model-invocation: true
user-invocable: false
---
```

**`name`** — becomes the `/slash-command`. Defaults to the directory name if omitted.

**`description`** — tells the agent when to invoke this skill. Use strong trigger
language: open with "YOU MUST load this skill when...". Under 500 chars.

**`disable-model-invocation`** — set `true` to prevent the agent from invoking the
skill automatically. Use this for command skills that represent intentional,
user-initiated actions (e.g. `/commit`, `/deploy`). If it makes sense for the agent
to invoke the skill on the user's behalf, omit it.

**`user-invocable`** — set `false` to hide the skill from the `/` menu. Use this on
all topic skills (`about-*`). They are reference material the agent loads
automatically, not commands for the user to invoke.

For all frontmatter fields, see [references/frontmatter.md](references/frontmatter.md).

## Topic vs Action Skills

**Topic skills** hold reference material and background context for a concept. They
are moderately descriptive and reusable across many workflows. Always set
`user-invocable: false`. Use the `about-*` prefix when the skill's primary purpose
is background understanding.

**Action skills** perform a specific operation and are as thin as possible — they
contain only what is exclusive to that action. All shared knowledge belongs in the
parent topic skill. Name action skills with a verb prefix: `create-`, `deploy-`,
`run-`. If the skill operates on a specific type, include it after the verb
(e.g. `create-skill` operates on a "skill").

Non-command action skills must NOT have `disable-model-invocation: true` — that flag
removes the skill from the agent's context entirely, making it undiscoverable.

## Template Files (`.tpl.`)

Any file in a skill directory can use `.tpl.` naming to opt into LiquidJS processing
at compile time. The `.tpl.` segment is stripped from the output filename.
For when `SKILL.md` must be `SKILL.tpl.md`, see **Template-Compiled Skills** below.

YOU MUST load `about-liquid-templates` when deciding whether any file in a skill
directory needs `.tpl.` naming or when writing LiquidJS syntax.

## General Principles

**Knowledge lives at the highest common ancestor.** If two skills need the same
knowledge, it belongs in the most general topic skill covering both — never
duplicated across skills.

**Every skill provides minimal cold-start context.** Include the briefest possible
orientation, then point to deeper resources.

**Never duplicate information that changes over time.** Teach the agent where to look
rather than providing a snapshot that will go stale. Only document things stable by
nature.

**Use strong trigger language.** Descriptions must open with `YOU MUST load this
skill when...`. Cross-references to other skills must use `YOU MUST load`.

**If no action skill exists for a task, ask the user.** Do not improvise an action
that warrants its own skill.

## Template-Compiled Skills

Every skill distributed from a shared library — whether this library (`sous`) or any other
shared skill library — must use `SKILL.tpl.md`, not `SKILL.md`. This is required because
every distributed skill must end with a `## Source for this Skill` section (see below), and
that section uses a template variable for the source path, which requires LiquidJS rendering.
No exceptions.

Every such skill's `SKILL.md` must end with a `## Source for this Skill` section:

```
## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: <resolved source path>
```

This tells agents reading the compiled output where the skill originated and that the
file must not be edited directly. Because this footer is required, all shared skills must
use `SKILL.tpl.md` (not `SKILL.md`) so the source path variable can be rendered at
compile time.

## Reference Files

- [frontmatter.md]({{ sousRootPath }}/.claude/skills/about-agent-skills/references/frontmatter.md) — complete frontmatter field table and invocation matrix
- [substitutions.md]({{ sousRootPath }}/.claude/skills/about-agent-skills/references/substitutions.md) — `$ARGUMENTS`, `$ARGUMENTS[N]`, `$CLAUDE_SESSION_ID`, `$CLAUDE_SKILL_DIR`
- [commands.md]({{ sousRootPath }}/.claude/skills/about-agent-skills/references/commands.md) — command-specific conventions: descriptions, headings, arguments, `argument-hint`
- [advanced-patterns.md]({{ sousRootPath }}/.claude/skills/about-agent-skills/references/advanced-patterns.md) — dynamic context injection, subagent execution (`context: fork`), `allowed-tools`

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}