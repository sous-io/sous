---
name: create-shared-skill
description: >
  YOU MUST use this skill when creating a new shared skill for the sous project.
  Do not use for local skills ({{ toolMetaDirectory }}/skills/) — those follow a different process.
---

# Abstract

This action skill covers creating a new shared skill in the sous project.

A **shared skill** is a skill that lives in `shared/skills/` within the `sous`
repo. It is compiled by `xcv build` and distributed to downstream projects that use sous.
It is distinct from a **local skill** (`{{ toolMetaDirectory }}/skills/`), which is active immediately
and never processed by LiquidJS.

## Creating a Shared Skill

You MUST load `about-agent-skills` and follow its standard skill creation steps. The
rules specific to shared skills are:

### 1. Location

Shared skills are organized into bundles. Place the skill directory at
`shared/skills/<bundle-name>/<skill-name>/` — not `{{ toolMetaDirectory }}/skills/`.

The built-in sous bundle is `sous-skills`. When creating a new skill that belongs to that bundle,
use `shared/skills/sous-skills/<skill-name>/`. When creating a new bundle, create a new
subdirectory under `shared/skills/` and add a corresponding `entryGlob` target in each
downstream project's config that should receive it.

### 2. Extended Frontmatter

Shared skills are distributed to other projects and should include full frontmatter:

```yaml
---
name: <skill-name>
description: >
  <trigger condition, under 500 chars>
license: MIT
compatibility:
  - claude
  - codex
metadata:
  version: 1.0.0
  tags: [<relevant>, <tags>]
---
```

Local skills omit `license`, `compatibility`, and `metadata` — shared skills should
include them since they are consumed by external agents and projects.

### 3. Name the main file `SKILL.tpl.md`

Every shared skill's main file must be `SKILL.tpl.md`, not `SKILL.md`. This is required
because every shared skill must include the `## Source for this Skill` footer, which uses
{% raw %}`{{ sousTemplatePath }}`{% endraw %} and therefore requires LiquidJS rendering.

For other files in the skill directory (references, scripts, supporting docs), use `.tpl.`
naming only when the file genuinely needs LiquidJS processing. YOU MUST load
`about-liquid-templates` when making that decision.

### 4. Add the source footer

Every shared `SKILL.tpl.md` must end with this block:

{% raw %}
```markdown
## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
```
{% endraw %}

### 5. Activation Requires `xcv build`

Unlike local skills, shared skills are not active immediately. They must be compiled
and distributed by running:

```bash
xcv build
```

Verify the skill directory is covered by an `entryGlob` target in the project settings
file. If the glob already covers `shared/skills/**/*.md`, no config changes
are needed.

# Related Skills

YOU MUST load `about-shared-skills` for the shared vs local distinction in sous. YOU
MUST load `about-agent-skills` for skill structure, frontmatter, and architecture
principles. YOU MUST load `about-liquid-templates` when deciding whether any file in
the skill directory needs `.tpl.` naming.

## Source for this Skill

This is a local skill for the `sous` project. Since `sous` uses its CLI to compile its own LLM configs, you cannot
edit the skill output directly. Instead, you need to edit the template.

- Source Path: {{ sousTemplatePath }}