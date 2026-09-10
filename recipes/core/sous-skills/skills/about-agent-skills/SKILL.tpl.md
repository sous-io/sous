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

**Topic skills** hold reference material and background context for a concept, plus any
shared scripts the action skills draw from. They are moderately descriptive and reusable
across many workflows. Always set `user-invocable: false`. Use the `about-*` prefix when
the skill's primary purpose is background understanding.

A topic skill's body holds fundamental knowledge — what is needed in ~75%+ of use cases.
Deeper reference material (complete tables, edge cases, advanced patterns) goes in
`references/` files, loaded only when needed. When official documentation exists for the
topic, fetch it once and store distilled versions in `references/`, including the official
source URL so the agent can check anything not covered locally. This prevents repeated doc
fetches during work sessions.

**Action skills** perform a specific operation and are as thin as possible — they
contain only what is exclusive to that action. All shared knowledge belongs in the
parent topic skill. Action skills carry less cold-start context than topic skills: just
enough to not be opaque, then delegate depth upward with `YOU MUST load`. Name action
skills with a verb prefix: `create-`, `deploy-`, `run-`. If the skill operates on a
specific type, include it after the verb (e.g. `create-skill` operates on a "skill").
The verb-first pattern immediately distinguishes action skills from topic skills in any
skill listing.

Non-command action skills must NOT have `disable-model-invocation: true` — that flag
removes the skill from the agent's context entirely, making it undiscoverable. A
non-command action skill relies on its description to tell the agent when to invoke it
automatically; omitting the flag is what makes that possible.

## Template Files (`.tpl.`)

Any file in a skill directory can use `.tpl.` naming to opt into LiquidJS processing
at compile time. The `.tpl.` segment is stripped from the output filename.
For when `SKILL.md` must be `SKILL.tpl.md`, see **Template-Compiled Skills** below.

YOU MUST load `about-liquid-templates` when deciding whether any file in a skill
directory needs `.tpl.` naming or when writing LiquidJS syntax.

## General Principles

**Knowledge lives at the highest common ancestor.** If two skills need the same
knowledge, it belongs in the most general topic skill covering both — never
duplicated across skills. Before adding content anywhere, ask whether it belongs
higher up.

**Every skill provides minimal cold-start context.** Assume the agent knows nothing
about the concept until the skill is loaded, and will not load any other skill unless
explicitly told to. Include the briefest possible orientation, then point to deeper
resources.

**Never duplicate information that changes over time.** Do not create lists or tables
that inventory things which will evolve (e.g. available skills, current files in a
directory). Teach the agent where to look rather than providing a snapshot that will go
stale. Only document things stable by nature.

**Use strong trigger language.** Descriptions must open with `YOU MUST load this
skill when...`. Cross-references to other skills must use `YOU MUST load` — weak
language like "consult" or "see" is not sufficient. In a skill body, write the
requirement so it binds whichever agent executes ("The agent performing this work MUST
load `x`"), not just the main session: delegated sub-agents start with fresh context and
must load the skills themselves.

**Write steps for whoever executes them.** Do not assume the main session performs
a skill's steps inline. Say which steps are delegated to a sub-agent and which are
orchestrator-only (anything needing the user, or the chat conversation's own
contents). Never rely on "skip this if it is already in context" heuristics: a
sub-agent's context is always fresh. Steps that produce a link or question for the
user must return it to the orchestrator, which relays it.

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

## Examples

- [examples/about-something.md](examples/about-something.md) — a complete example of a topic (`about-*`) skill
- [examples/do-something.md](examples/do-something.md) — a complete example of an action skill (command)

## Reference Files

- [frontmatter.md](references/frontmatter.md) — complete frontmatter field table and invocation matrix
- [substitutions.md](references/substitutions.md) — `$ARGUMENTS`, `$ARGUMENTS[N]`, `$CLAUDE_SESSION_ID`, `$CLAUDE_SKILL_DIR`
- [commands.md](references/commands.md) — command-specific conventions: descriptions, headings, arguments, `argument-hint`
- [advanced-patterns.md](references/advanced-patterns.md) — dynamic context injection, subagent execution (`context: fork`), `allowed-tools`

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}