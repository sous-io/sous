---
name: about-sous
description: >
  YOU MUST load this skill when you cannot edit a file in this project, are asked why
  a file keeps reverting, need to know where the source of truth for any managed file
  lives, or need to understand what this project's configuration system is.
user-invocable: false
---

# About Sous

Sous (`xcv`) is a CLI tool that compiles markdown templates and manages output files
for AI coding agents. It reads a central configuration, resolves variables, and
copies or renders files to their destinations in this project.

## Files You Must Never Edit

Sous manages certain files in this project by compiling them from a central source.
**You must never edit these directly.** Your changes will be silently overwritten the
next time Sous runs:

- `.claude/` — Claude Code configuration, skills, and instructions
- `.codex/` — Codex configuration and skills
- `AGENTS.md` and `CLAUDE.md` — agent instruction files
- Any file you did not create yourself in a designated source directory

If you need to change something in one of these files, the change must be made at the
source — in the central configuration this project uses with Sous.

## Recommended Project Layout

Sous recommends using a `.sous/` directory in the project root for all project-specific
configuration, templates, and state:

```
.sous/
  config/              # sous config files (sous.config.js, project.config.js)
  prompts/             # source templates for compiled output
    memory/            # root memory templates → CLAUDE.md, AGENTS.md, etc.
    skills/            # skill source templates → .claude/skills/
    runtime-context/   # generated session context (gitignored)
  state/               # sous state files (gitignored)
  tasks/               # task files for runtime context
```

Content shared across multiple projects (skill bundles, partials) should live in a
separate repo or directory — not inside `.sous/`.

## Where Your Skills Live

Skills for this project live at `{{ skillsRoot }}`. That is the source directory Sous
compiles from. Create and edit skills there — never in `.claude/skills/` or
`.codex/skills/` directly.

YOU MUST load `create-skill` when creating a new skill for this project.

## Sous Reference Skills

Sous ships built-in reference skills at `{{ sousRootPath }}/shared/skills/`.
You may read these for reference. Never edit them — that path is inside the Sous
installation itself.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
