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

- `.claude/`: Claude Code configuration, skills, and instructions
- `.codex/`: Codex configuration and skills
- `AGENTS.md` and `CLAUDE.md`: agent instruction files
- Any file you did not create yourself in a designated source directory

If you need to change something in one of these files, the change must be made at the
source, in the central configuration this project uses with Sous.

## Where Your Skills Live

Skills for this project live at `{{ skillsRoot }}`. That is the source directory Sous
compiles from. Create and edit skills there, never in `.claude/skills/` or
`.codex/skills/` directly.

YOU MUST load `create-skill` when creating a new skill for this project.

YOU MUST load `about-sous-configuration` when creating or editing the project's sous
config (`sous.config.*`, `conf.d/` layers), defining or debugging config variables, or
diagnosing a ConfigError.

YOU MUST load `about-sous-repos` when working inside a recipe repository (one with a
`sous.repo.yaml` at its root), and `about-sous-recipes` when creating or changing a recipe.

## Sous's Shared Recipes

The `about-sous`, `about-sous-configuration`, `about-agent-skills` and
`about-liquid-templates` skills you are reading come from the `core/sous-skills` recipe,
published by the official sous recipe repository (https://github.com/sous-io/sous-recipes).
A copy of that recipe also ships inside the installed sous package, where it seeds the
machine-wide store so a fresh, offline install still has these skills.

Edit them only in the recipe repository, where they are the sources. Never edit a compiled
copy of them inside a consuming project; that copy is build output and is overwritten on
the next sous run.

## Trust and Activation

Trust is the only security boundary sous draws. Adding a repository is trusting it, and
that authorizes its recipes to run code on this machine: code sous runs itself and code an
agent runs, such as skill scripts and hooks. Sous sandboxes neither; trusted code runs
with the user's own permissions. Before a repository is trusted, nothing from it runs; the
trust question reads only its index.

Subscribing decides what is switched on, not what is safe. A recipe is active when the
project subscribes to it, directly or through its namespace, or when an active recipe
lists it under `subscribes`, and only an active recipe registers entry points of its own
(output files, skills, tool hooks and tool plugins). A recipe held only through `depends` is a
library: an active recipe may include, call or import its files, but it registers nothing
itself. No recipe installs a Sous plugin; Sous plugins come only from sous's built-ins and from
npm-style modules.

> "recipes will not be allowed to install _Sous_ plugins. All Sous plugins, besides any built-ins that ship with Sous, itself, will come from a NPM repo (or similar) as modules. Recipes _will_ be allowed to install tool plugins (e.g. Claude Code Plugins)."
>
>   -- **Luke Chavers** in an agent session (2026-09-29)

## Sous's Own Documentation

Sous's full documentation ships inside the installed package as plain markdown
at `{{ sousRootPath }}/docs/markdown/`. Read `_sidebar.md` there first; it is
the index of what exists. When you need to understand a sous feature beyond
what the skills cover, read these files before guessing or searching the web:
they match the INSTALLED version of sous, unlike the online copy
(https://sous.io/markdown/#/), which tracks the latest release.
The reference content is still being written; the index shows what exists so
far.

## Source for this Skill

This skill comes from the `core/sous-skills` recipe, installed by sous from a recipe
repository. It was compiled from a template, so edit the source, never this output file.

- Source Path: {{ sousTemplatePath }}
