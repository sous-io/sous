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

## Where Your Skills Live

Skills for this project live at `{{ skillsRoot }}`. That is the source directory Sous
compiles from. Create and edit skills there — never in `.claude/skills/` or
`.codex/skills/` directly.

YOU MUST load `create-skill` when creating a new skill for this project.

YOU MUST load `about-sous-configuration` when creating or editing the project's sous
config (`sous.config.*`, `conf.d/` layers), defining or debugging config variables, or
diagnosing a ConfigError.

## Sous's Shared Skill Bundles

Sous ships shared skill bundles at `{{ sousRootPath }}/shared-prompts/skills/`, which is
where the `about-sous`, `about-sous-configuration`, `about-agent-skills` and
`about-liquid-templates` skills you are reading came from. Edit them only in the sous repository itself, where they are the
sources. Never edit a compiled copy of them inside a consuming project — that copy is
build output and is overwritten on the next Sous run.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
