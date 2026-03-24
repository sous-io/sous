---
name: about-agent-skills
description: >
  YOU MUST load this skill when creating, editing, auditing, or reasoning about any
  {{ toolName }} skill. Covers skill structure, core frontmatter, invocation, topic vs
  action patterns, and the skill architecture principles used in this project.
user-invocable: false
---

# Abstract

This "topical skill" provides information about two things: the {{ toolName }} skills system —
what skills are, how they're structured, and how they work — and the conventions this
project uses when creating and maintaining them.

## About {{ toolName }} Skills

A {{ toolName }} skill is a directory containing a `SKILL.md` file and optional supporting
files, placed under a `skills/` directory. Skills extend what the agent can do — invoke
them directly with `/skill-name`, or the agent loads them automatically when relevant.

{% if tool == "claude" %}
Official docs: https://code.claude.com/docs/en/skills

{% endif %}
In the `sous` project, skills fall into two categories: **local skills** (in `{{ toolMetaDirectory }}/skills/`,
for use when working on sous itself) and **shared skills** (in `shared/skills/`, compiled
by xcv and distributed to other projects). You MUST load `about-local-skills` or `about-shared-skills`
as appropriate before working with either type.

## Where Skills Live

Skills go in different locations depending on their type. The specific rules for each
type are covered by `about-local-skills` and `about-shared-skills`.

## Directory Structure

```
my-skill/
├── SKILL.md        # Required. Frontmatter + instructions.
├── references/     # Optional. Deep-dive docs loaded when needed.
├── examples/       # Optional. Example outputs.
└── scripts/        # Optional. Executable scripts the agent can run.
```

Supporting files must be referenced from `SKILL.md` — the agent will not know they exist otherwise.

## Core Frontmatter

These four fields cover the vast majority of skills:

```yaml
---
name: my-skill
description: >
  One or two sentences.
disable-model-invocation: true
user-invocable: false
---
```

**`name`** — becomes the `/slash-command`. Defaults to the directory name if omitted.

**`description`** — tells the agent when to invoke this skill. Keep under 500 chars. If omitted,
the agent uses the first paragraph of the skill body.

**`disable-model-invocation`** — set `true` to prevent the agent from invoking the skill
automatically. Use this for **commands**: skills that represent an intentional, user-initiated
action (e.g. `/commit`, `/deploy`, `/create-local-skill`). Commands should usually have this
set, but not always — if it makes sense for the agent to invoke the command on the user's
behalf, omit it. Use judgement on a case-by-case basis.

**`user-invocable`** — set `false` to hide the skill from the `/` menu. Use this on all
topic skills (`about-*`). They are reference material the agent loads automatically; they are
not commands for the user to invoke directly.

For all frontmatter fields, see [references/frontmatter.md](references/frontmatter.md).

## Topical Skills

Also referred to as "topic skills". A topical skill is a knowledge hub for a concept —
it holds reference material, background context, and any shared scripts that action skills
draw from. Topical skills may be moderately descriptive. Always set `user-invocable: false`
on topical skills; they are reference material the agent loads automatically, not commands for
the user to invoke.

**Naming:** Use the `about-*` prefix when the skill's primary purpose is background
understanding rather than serving as a parent to action skills or housing shared scripts.

**Principles specific to topical skills:**

- The skill body holds fundamental knowledge — information needed in ~75%+ of use cases.
  Deeper reference material (complete tables, edge cases, advanced patterns) goes in
  `references/` files, loaded only when needed.
- When official documentation exists for the topic, fetch it once and store distilled
  versions in `references/`. Include the official source URL so the agent can check for
  anything not covered locally. This prevents repeated doc fetches during work sessions.

## Action Skills

An action skill performs a specific operation and is as thin as possible — it contains only
what is exclusive to that action. All shared knowledge belongs in the parent topic skill.
Action skills carry less cold-start context than topical skills; just enough to not be
opaque, then delegate depth upward with `YOU MUST load`.

**Commands** are a specific kind of action skill: ones that represent an intentional,
user-initiated workflow. The user explicitly invokes them with `/skill-name`. Commands
should usually have `disable-model-invocation: true` set — but not always. If it makes
sense for the agent to invoke the command on the user's behalf, omit it.

Non-command action skills must NOT have `disable-model-invocation: true`. That flag
removes the skill from the agent's context entirely, making it undiscoverable. A non-command
action skill relies on its description to tell the agent when to invoke it automatically —
omitting the flag is what makes that possible.

**Naming:** Action skill names always begin with a verb (e.g. `create-`, `deploy-`, `run-`).
If the skill operates on a specific type, include the type after the verb
(e.g. `create-local-skill` operates on a "local skill"). This verb-first pattern
immediately distinguishes action skills from topical skills in any skill listing.

**Principles specific to action skills:**

- Contain only steps and knowledge exclusive to that action. If you find yourself writing
  general guidance, it belongs in the topic skill instead.
- Carry the minimum cold-start context needed to orient the agent, then point upward.

## Template Files (`.tpl.`)

Any file in a skill directory can use `.tpl.` naming to opt into LiquidJS processing
at compile time. The `.tpl.` segment is stripped from the output filename.

**`SKILL.md` for any skill compiled by sous — whether in `shared/skills/`, in
`.sous/prompts/skills/` (sous's own local skills), or in a downstream project's skill
source directory — must always be named `SKILL.tpl.md`.** This is required because every
compiled skill must include a `## Source for this Skill` footer containing
{% raw %}`{{ sousTemplatePath }}`{% endraw %}, which requires LiquidJS rendering. No exceptions.

In generic downstream projects, skills placed directly in `{{ toolMetaDirectory }}/skills/` (not compiled
by sous) use plain `SKILL.md`. In the sous project itself, however, even local skills are
compiled — their source templates live in `.sous/prompts/skills/` and use `SKILL.tpl.md`.
See `about-local-skills` for the full sous-specific workflow.

All other files in any skill directory (references, scripts, docs) use `.tpl.` naming
only when they genuinely need variable substitution, conditionals, or partials.

YOU MUST load `about-liquid-templates` when deciding whether a file needs `.tpl.`
naming or when writing LiquidJS syntax.

## General Principles

You MUST follow these when creating, editing, or auditing any skill.

**1. Knowledge lives at the highest common ancestor.**
If two skills need the same knowledge, it belongs in the most general topic skill covering
both — never duplicated across skills. Before adding content anywhere, ask whether it
belongs higher up.

**2. Every skill provides minimal cold-start context.**
Assume the agent knows nothing about the concept until the skill is loaded and will not
load any other skill unless explicitly told to. Include the briefest possible orientation,
then point to deeper resources.

**3. Never duplicate information that changes over time.**
Do not create lists or tables that inventory things which will evolve (e.g. available
skills, current files in a directory). Teach the agent where to look rather than providing
a snapshot that will go stale. Only document things stable by nature.

**4. Use strong trigger language.**
Descriptions must open with `YOU MUST load this skill when...`. Cross-references to other
skills must use `YOU MUST load`. Weak language like "consult" or "see" is not sufficient.

**5. If no action skill exists for a task, ask the user.**
Do not improvise an action that warrants its own skill. Ask the user whether a skill should
be created before proceeding.

## Examples

- [examples/about-something.md](examples/about-something.md) — a complete example of a topical (`about-*`) skill
- [examples/do-something.md](examples/do-something.md) — a complete example of an action skill (command)

## Reference Files

- [references/frontmatter.md](references/frontmatter.md) — complete frontmatter field table and invocation matrix
- [references/substitutions.md](references/substitutions.md) — `$ARGUMENTS`, `$ARGUMENTS[N]`, `$CLAUDE_SESSION_ID`, `$CLAUDE_SKILL_DIR`
- [references/commands.md](references/commands.md) — command-specific conventions: descriptions, headings, arguments, `argument-hint`
- [references/advanced-patterns.md](references/advanced-patterns.md) — dynamic context injection, subagent execution (`context: fork`), `allowed-tools`

# Other Skills

## Action Skills

Action skills for working with specific types of skills will have "skill" in their name.
Find the appropriate action skill for what you want to do. If no appropriate action skill
exists, ask the user whether one should be created before continuing.

## Related Skills

`about-local-skills` and `about-shared-skills` extend this skill for the sous-specific
two-tier context. You MUST load them when working with sous skills specifically.

## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: {{ sousTemplatePath }}