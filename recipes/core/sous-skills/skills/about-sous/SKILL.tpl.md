---
name: about-sous
description: >
  YOU MUST load this skill when you cannot edit a file in this project, are asked why
  a file keeps reverting, want to change a skill, memory or other file that came from a
  recipe, need to know where the source of truth for any managed file lives, or need to
  understand what this project's configuration system is.
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

## Changing a File That Came From a Recipe

A file whose footer names a recipe (`This skill comes from the <namespace>/<recipe> recipe`)
is published by a recipe repository. Its Source Path points into sous's machine-wide store,
which is read-only build input: an edit there is lost and reaches nobody. Change it upstream:

1. `sous repo contribute <namespace>/<recipe>` links a working copy of the recipe's
   repository on a new branch; the project's builds read from it until the contribution
   is finished, so an edit shows up on the next `sous build`.
2. Edit the recipe in that working copy, raising its version (YOU MUST load
   `about-sous-recipes`).
3. `sous repo contribute <namespace>/<recipe> --finish` proposes the change and unlinks.

YOU MUST load `about-sous-repos` before running these commands.

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

Their source is in the sous repository (https://github.com/sous-io/sous), under
`recipes/core/sous-skills/`; the copy in the recipe repository is written by each sous
release and takes no proposals. Never edit a compiled copy of them inside a consuming
project; that copy is build output and is overwritten on the next sous run.

## Trust and Activation

Trust is the only security boundary sous draws. Adding a repository is trusting it, and
that authorizes its recipes to run code on this machine: code sous runs itself and code an
agent runs, such as skill scripts and hooks. Sous sandboxes neither; trusted code runs
with the user's own permissions. Before a repository is trusted, nothing from it runs; the
trust question reads only its index.

Subscribing decides what is switched on, not what is safe. A recipe is active when the
project subscribes to it, directly or through its namespace, or when an active recipe
lists it under `subscribes`. Only an active recipe adds anything to the project: output files,
skills, tool hooks, tool plugins (such as a Claude Code plugin) and Sous plugins (code that
extends sous itself). A recipe held only through `depends` is a library: an active recipe may
include, call or import its files, but it adds nothing to the project itself.

A recipe's Sous plugin runs inside sous while sous builds the project's config, with the user's
own permissions, so it is code from that recipe's repository like any other. A recipe may also
require plugins from npm; `sous subscription add` refuses it while one is missing or outside
its version range, and offers to install it. Run `sous plugins show` to list every loaded plugin
and what it added.

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
repository. It was compiled from a template, so edit the source, never this output file. To
change it, propose the change to `sous-io/sous`, under `recipes/core/sous-skills/`.

- Source Path: {{ sousTemplatePath }}
