---
name: create-skill
description: >
  YOU MUST use this skill when creating a new skill for this project.
---

# Create a Skill

YOU MUST load `about-agent-skills` for skill structure, frontmatter, and architecture
principles before continuing.

Skills for this project live at `{{ skillsRoot }}`. Create new skills there — not in
`.claude/skills/` or `.codex/skills/` directly (those are managed automatically and
must not be edited).

## Steps

### 1. Create the directory

```
{{ skillsRoot }}/<skill-name>/
```

The directory name must match the `name` frontmatter field (lowercase, hyphens).

### 2. Write `SKILL.tpl.md`

Create `SKILL.tpl.md` in the directory with valid frontmatter and an imperative body.
See `about-agent-skills` for the full frontmatter reference and topic vs action
skill guidance.

### 3. Add supporting files (if needed)

- `references/` — supplementary documentation loaded on demand
- `scripts/` — executable scripts the skill uses
- `examples/` — example outputs

Reference all supporting files from `SKILL.md` — the agent will not discover them
otherwise.

### 4. Name the main file `SKILL.tpl.md` and add the source footer

Skills in `{{ skillsRoot }}` are compiled and distributed — the main skill file must
always be named `SKILL.tpl.md`, not `SKILL.md`. No exceptions. This is required because
every distributed skill must end with a `## Source for this Skill` footer:

{% raw %}
```markdown
## Source for this Skill

This skill was compiled from a template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
```
{% endraw %}

The `{{ sousTemplatePath }}` variable renders to the absolute path of the source template
at compile time, telling agents where the skill originated.

For other files in the skill directory (references, scripts, supporting docs), use `.tpl.`
naming only when the file genuinely needs LiquidJS processing. YOU MUST load
`about-liquid-templates` before making that decision.

### 5. No build step needed

Once the files exist in `{{ skillsRoot }}`, distribution is handled automatically.

# Related Skills

YOU MUST load `about-agent-skills` for skill structure and principles. YOU MUST load
`about-sous` for context on what is managed automatically in this project. YOU MUST
load `about-liquid-templates` if any file in your skill needs `.tpl.` processing.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
