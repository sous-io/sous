---
name: create-local-skill
description: >
  YOU MUST use this skill when creating a new local skill for the sous project.
  Do not use for shared skills (shared-prompts/skills/) — those follow a different process.
---

# Abstract

This "action skill" performs a specific operation: creating a new local skill in the sous project.

A **Claude Code skill** is a directory containing a `SKILL.md` file, placed under `.claude/skills/`.
It extends what Claude can do and can be invoked with `/skill-name`.

A **local skill** is a skill that lives in `.claude/skills/` within the `sous` repo and is intended
for Claude to use when working on `sous` itself. It is distinct from "shared skills", which live in
`shared-prompts/skills/` and are distributed to other projects via `xcv build`.

"Creating" a local skill means adding a new directory and `SKILL.md` to `.claude/skills/`.

## Creating a Local Skill

You MUST load `about-agent-skills` and follow its standard skill creation steps. The only rules
specific to local skills are: place the directory in `.claude/skills/<name>/` rather than
`shared-prompts/skills/`; never use `.tpl.` naming, as local skills are never processed
by Sous or LiquidJS; and there is no `xcv build` step — the skill is immediately active
once the file exists.

# Related Skills

You MUST load `about-local-skills` for the local vs shared distinction in sous. You MUST load
`about-agent-skills` for skill structure, frontmatter, and architecture principles.
