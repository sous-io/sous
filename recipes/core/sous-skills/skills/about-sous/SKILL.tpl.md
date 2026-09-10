---
name: about-sous
description: >
  YOU MUST load this skill when you cannot edit a file in this project, are asked why
  a file keeps reverting, need to know where the source of truth for any managed file
  lives, or need to understand what this project's configuration system is.
user-invocable: false
---

# About Sous

Sous (`sous`) is a CLI tool that compiles markdown templates and manages output files
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

## Sous's Shared Recipes

The `about-sous`, `about-sous-configuration`, `about-agent-skills` and
`about-liquid-templates` skills you are reading come from the `core/sous-skills` recipe,
published by the official sous recipe repository (https://github.com/sous-io/sous-recipes).
A copy of that recipe also ships inside the installed sous package, where it seeds the
machine-wide store so a fresh, offline install still has these skills.

Edit them only in the recipe repository, where they are the sources. Never edit a compiled
copy of them inside a consuming project; that copy is build output and is overwritten on
the next sous run.

## Sous's Own Documentation

Sous's full documentation ships inside the installed package as plain markdown
at `{{ sousRootPath }}/docs/markdown/`. Read `_sidebar.md` there first; it is
the index of what exists. When you need to understand a sous feature beyond
what the skills cover, read these files before guessing or searching the web:
they match the INSTALLED version of sous, unlike the online copy
(https://sous-io.github.io/sous/markdown/#/), which tracks the latest release.
The reference content is still being written; the index shows what exists so
far.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
