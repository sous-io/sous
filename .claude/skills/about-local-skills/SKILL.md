---
name: about-local-skills
description: >
  YOU MUST load this skill when working with skills in .claude/skills/ in the sous project or when the user mentions 
  "local skill" Covers what local skills are, who they serve, and how they differ from "shared skills" in 
  shared/skills/.
user-invocable: false
---
# Abstract

This "topical skill" is intended to provide information about a specific concept: "local claude skills".

## About Local Skills

The "local skill" is a concept that is unique to the `sous` project. We only have to distinguish between "local"
and "shared" because `sous` is, itself, a provider of skills that can be used by other projects that are managed
by `sous`.

When we refer to a "local skill" or as a skill being "local", we mean that it is a skill that the agent should use
when working on the `sous` project itself. Local skills are not intended to be distributed to other projects;
those skills are called "shared skills" and exist in another location.

## Where Local Skills Exist

Local skills are **compiled** into `.claude/skills/` — but that is the output directory, not where you edit them.

Because sous uses its own CLI to compile its LLM configs, local skills follow the same compilation workflow
as shared skills:

- **Source templates** live at `.sous/prompts/skills/<skill-name>/SKILL.tpl.md`
- **Compiled output** goes to `.claude/skills/<skill-name>/SKILL.md`
- Running `xcv build` compiles the templates and writes the output
- **Never edit files in `.claude/skills/` directly** — they are overwritten on every build

Since the source templates are `.tpl.md` files, they are processed through LiquidJS at compile time. This
is why every local skill must include the `## Source for this Skill` footer with `/home/luke/Projects/puravida/infra/sous/.sous/prompts/skills/about-local-skills/SKILL.tpl.md` —
it tells the agent where the source template lives so edits go to the right place.

Supporting files (references, examples, scripts) live alongside the `SKILL.tpl.md` in the source directory
at `.sous/prompts/skills/<skill-name>/`. They use `.tpl.` naming only when they genuinely need LiquidJS
processing; otherwise they are copied verbatim.

# Other Skills

## Action Skills

All skills that act upon "local skills" will have "local-skill" in their name. You should find the appropriate
"action skill" for what you want to do, if one exists. If the appropriate action skill does not exist, you should
ask the user if one should be created before continuing.

## Related Skills

This document does not cover the basics of "agent skills", which apply to both "local" and "shared" skills. You MUST load
`about-agent-skills` to learn more about skills and how they're structured.

If you're asked to work on "shared skills" (any skill that exists in `shared/`) then you MUST load the
`about-shared-skills` skill.

## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: /home/luke/Projects/puravida/infra/sous/.sous/prompts/skills/about-local-skills/SKILL.tpl.md
