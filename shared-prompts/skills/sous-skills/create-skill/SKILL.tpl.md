---
name: create-skill
description: >
  YOU MUST use this skill when creating a new skill for this project.
---

# Create a Skill

The agent performing this work MUST load `about-agent-skills` for skill structure,
frontmatter, and architecture principles.

Skills for this project live at `{{ skillsRoot }}`. Create new skills there — not in
`.claude/skills/` or `.codex/skills/` directly (those are managed automatically and
must not be edited).

## Steps

### 1. Create the directory

```
{{ skillsRoot }}/<skill-name>/
```

The directory name must match the `name` frontmatter field (lowercase, hyphens).

**If `{{ skillsRoot }}` is a bundle root**, its immediate subdirectories are *bundles*, not
skills, and the path gains a segment: `{{ skillsRoot }}/<bundle-name>/<skill-name>/`. Check
what is already there before creating anything: a directory holding `SKILL.md` /
`SKILL.tpl.md` files directly means skills go at the top level; a directory holding further
subdirectories that each contain a skill means you are looking at bundles, so add the skill
to the bundle it belongs to. When a new skill genuinely needs a new bundle, create the
bundle directory and add a matching `entryGlob` target in the config of every project that
should receive it — a bundle with no `entryGlob` is never compiled anywhere.

### 2. Write `SKILL.tpl.md`

Create `SKILL.tpl.md` in the directory with valid frontmatter and an imperative body.
See `about-agent-skills` for the full frontmatter reference and topic vs action
skill guidance.

**Distributed skills take extended frontmatter.** A skill compiled out to other projects
declares its provenance and portability; a project-local skill omits these fields because
nothing outside the project consumes it:

```yaml
license: MIT
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [<relevant>, <tags>]
```

### 3. Add supporting files (if needed)

- `references/` — supplementary documentation loaded on demand
- `scripts/` — executable scripts the skill uses
- `examples/` — example outputs

Reference all supporting files from `SKILL.md` — the agent will not discover them
otherwise.

### 4. Name the main file `SKILL.tpl.md` and add the source footer

Skills in `{{ skillsRoot }}` are compiled and distributed — the main skill file must
always be named `SKILL.tpl.md`, not `SKILL.md`. No exceptions, and specifically **not even
when the skill body contains no variables at all**: the mandatory `## Source for this Skill`
footer itself contains a template variable, so every skill needs a LiquidJS render pass by
definition. A plain `SKILL.md` is copied verbatim, which would ship the footer's unrendered
variable straight into the output. The footer:

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

### 6. Write the body for whoever executes it

Per the sub-agent delegation pattern
(`~sous-shared/_partials/sub-agent-delegation.md`), a skill's steps may run in a delegated
sub-agent with fresh context. Mark which steps are delegated and which are
orchestrator-only (anything needing the user or this conversation's contents), and
phrase skill-loading requirements as "The agent performing this work MUST load `x`".
See `about-agent-skills` → General Principles.

# Related Skills

YOU MUST load `about-agent-skills` for skill structure and principles. YOU MUST load
`about-sous` for context on what is managed automatically in this project. YOU MUST
load `about-liquid-templates` if any file in your skill needs `.tpl.` processing.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
