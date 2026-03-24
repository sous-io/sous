---
name: create-local-skill
description: >
  YOU MUST use this skill when creating a new local skill for the sous project.
  Do not use for shared skills (shared/skills/) — those follow a different process.
---

# Abstract

This "action skill" performs a specific operation: creating a new local skill in the sous project.

A **local skill** is a skill intended for the agent to use when working on `sous` itself. It is
distinct from "shared skills", which live in `shared/skills/` and are distributed to
other projects via `xcv build`.

Because sous uses its own CLI to compile its LLM configs, "creating" a local skill means adding
a source template to `.sous/prompts/skills/` and compiling it to `{{ toolMetaDirectory }}/skills/` with `xcv build`.

## Creating a Local Skill

You MUST load `about-agent-skills` and follow its standard skill creation steps. The rules
specific to local skills in the sous project are:

### 1. Location

Place the skill directory at `.sous/prompts/skills/<skill-name>/` — not `{{ toolMetaDirectory }}/skills/`
(that is the compiled output directory) and not `shared/skills/` (those are shared skills).

### 2. Name the main file `SKILL.tpl.md`

The main file must be `SKILL.tpl.md`, not `SKILL.md`. It is rendered through LiquidJS at compile
time and output as `SKILL.md` at the destination. This is required because every compiled skill
must include the `## Source for this Skill` footer containing {% raw %}`{{ sousTemplatePath }}`{% endraw %}.

For other files in the skill directory (references, scripts, supporting docs), use `.tpl.` naming
only when the file genuinely needs LiquidJS processing. YOU MUST load `about-liquid-templates`
when making that decision.

### 3. Add the source footer

Every local `SKILL.tpl.md` must end with this block:

{% raw %}
```markdown
## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: {{ sousTemplatePath }}
```
{% endraw %}

### 4. Activation requires `xcv build`

Local skills in sous are not active immediately. They must be compiled by running:

```bash
xcv build
```

The existing `localSkillsCompilationConfig` in `.sous/config/project.config.js` already targets
`.sous/prompts/skills/**/*`, so no config changes are needed for new skills.

# Related Skills

You MUST load `about-local-skills` for the local vs shared distinction in sous. You MUST load
`about-agent-skills` for skill structure, frontmatter, and architecture principles.

## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: {{ sousTemplatePath }}
