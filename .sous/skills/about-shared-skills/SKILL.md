---
name: about-shared-skills
description: >
  YOU MUST load this skill when working with skills in shared-prompts/skills/ or when
  the user mentions "shared skill". Covers what shared skills are, the .tpl. convention,
  xcv compilation, and the extended frontmatter used in sous-distributed skills.
user-invocable: false
---

# Abstract

This "topical skill" is intended to provide information about a specific concept: "shared sous skills".

## About Shared Skills

The "shared skill" is a concept unique to the `sous` project. We only have to distinguish between "shared"
and "local" because `sous` is, itself, a provider of skills that can be used by other projects managed
by `sous`.

When we refer to a "shared skill" or a skill being "shared", we mean a template file that `xcv build`
compiles and mirrors into the skill directories of **downstream projects that use sous** — not this
project. Shared skills teach those projects' agents how to work with sous.

Shared skills are organized into **bundles** under `shared-prompts/skills/`. Each bundle is a
subdirectory (e.g. `shared-prompts/skills/sous-skills/`) containing one or more skills. Downstream
projects point their `entryGlob` targets at specific bundle directories, allowing them to opt in to
only the bundles they need. The built-in sous bundle lives at `shared-prompts/skills/sous-skills/`.

The main skill file for every shared skill must be named `SKILL.tpl.md` (not `SKILL.md`). It is
rendered through LiquidJS at compile time and output as `SKILL.md` at the destination — the `.tpl.`
segment is stripped. This is required because every shared skill must include the `## Source for this
Skill` footer, which uses `{{ sousTemplatePath }}` and therefore requires LiquidJS rendering. This
rule applies to all shared skill libraries — sous's built-in skills and any other library. No exceptions.

Other files in the skill directory (scripts, references, supporting docs) use `.tpl.` naming only when
they genuinely need variable substitution, partials, or conditionals; otherwise copy verbatim.

# Other Skills

## Action Skills

All skills that act upon "shared skills" will have "shared-skill" in their name. Find the appropriate
action skill for what you want to do, if one exists. If no appropriate action skill exists, ask the
user whether one should be created before continuing.

## Related Skills

This document does not cover the basics of "agent skills", which apply to both local and shared skills.
You MUST load `about-agent-skills` to learn more about skill structure and architecture principles.

If you're asked to work on "local skills" (any skill in `.claude/skills/`) then you MUST load
`about-local-skills`.

Supporting files in a shared skill directory (references, scripts, docs) may use `.tpl.` naming
when they need LiquidJS processing. The main `SKILL.tpl.md` is always required — see above.
You MUST load `about-liquid-templates` when working with any `.tpl.` file or deciding whether
a supporting file needs LiquidJS processing.

Every shared skill's `SKILL.tpl.md` must end with a `## Source for this Skill` block:

```markdown
## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
```

This renders the source path into the compiled output, telling downstream agents where the
skill originated and reinforcing that the file must not be edited directly.
