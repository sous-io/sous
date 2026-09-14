/**
 * Sous configuring itself.
 *
 * This is the config sous uses on its own repository. It exists both because
 * the sous repo genuinely wants compiled agent skills and because dogfooding
 * keeps the discovery path, the `${sousDir}` auto-var and the repositories
 * system honest: if any of them break, `sous build` on this repo breaks.
 *
 * Discovery: `sous build` walks up from cwd, finds this `.sous/` directory and
 * loads this file. Auto-vars `${sousDir}` (this directory) and
 * `${sousConfigPath}` (this file) are injected before anything else resolves.
 *
 * WHERE THE SKILLS COME FROM. Sous no longer keeps a library of skill bundles
 * inside its own repository. Everything except the `core` seed is published by
 * the official recipe repository, and this project subscribes to what it wants
 * like any other project would. Three sources feed `.claude/skills/`:
 *
 *   1. `core/sous-skills`, which every project gets without asking. It is not
 *      listed below because sous provides that subscription itself; the copy in
 *      `recipes/core/sous-skills/` at the root of this repository is its source.
 *   2. The subscriptions declared below, fetched from the official repository
 *      and pinned in `.sous/sous.lock.json`, which is committed.
 *   3. This project's own skills, in `.sous/skills/`, compiled by the
 *      `projectSkills` target below.
 *
 * OUTPUT IS LOCAL-ONLY. `.claude/`, and every file this config writes, is
 * gitignored build output. That includes BOTH instruction files: the repo-root
 * CLAUDE.md and docs/CLAUDE.md are compiled from tracked sources under
 * `.sous/prompts/`; edit those sources, never the compiled copies. A fresh
 * clone has no root CLAUDE.md until the first `sous build`.
 */

// [SOUS] Project-local skills: hand-maintained, sous-specific skills that have no
// published equivalent (currently the unit-testing pair). These describe how to
// work ON this repository, so they are not published as recipes. They are plain
// SKILL.md files with no variables, so compilation is effectively a mirrored copy
// into .claude/skills/.
const projectSkills = {
  entryGlob: "${projectSkillsDir}/**/*",
  globBase: "${projectSkillsDir}",
  outputs: [{ destinationDir: "${claudeSkillsDir}" }],
};

// [ROOT] The repo-root CLAUDE.md: instructions for agents working ON sous.
// The source is tracked; the compiled /CLAUDE.md is gitignored output. Plain
// markdown (no .tpl.); @-includes work if the doc is ever split into sections.
const rootClaude = {
  entryPoint: "${sousDir}/prompts/root/CLAUDE.md",
  outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],
};

// [SITE] Agent instructions for the GitHub Pages site under docs/. Same
// tracked-source / gitignored-output arrangement as rootClaude.
const docsSiteClaude = {
  entryPoint: "${sousDir}/prompts/docs-site/CLAUDE.md",
  outputs: [{ destinationFile: "${projectRoot}/docs/CLAUDE.md" }],
};

import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo root is this file's grandparent (`<repo>/.sous/sous.config.js`).
// Derived here rather than as `${sousDir}/..` because these paths are rendered
// into agent-facing skill text, and `/repo/.sous/../recipes` reads badly next to
// `/repo/recipes`. A config is a real ES module, so it may compute values like
// this.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  name: "Sous",

  // The recipes this project subscribes to, fetched from the official
  // repository and pinned in the committed lockfile. `sous-recipes` itself
  // needs no `repos:` entry: sous provides that one, and the `core` namespace
  // subscription, to every project.
  //
  // Deliberately NOT subscribed: `tool-usage/automated-browser-tasks`. It needs
  // browserAutomationScriptsDir pointing at a real script directory, and sous
  // has none.
  subscriptions: {
    "workflow/task-files": { range: "^1" },
    "workflow/github-projects": { range: "^1" },
    "communication/control-flow": { range: "^1" },
  },

  // Where a subscribed recipe's files are written. Only `skills` is named,
  // because the recipes above contribute only skills.
  recipeOutputs: {
    skills: ["${claudeSkillsDir}"],
  },

  // WHERE THE RECIPE ANSWERS LIVE. Every variable the subscribed recipes ask
  // about (the task file root, the ticket prefix, the GitHub board and its
  // field IDs, your login and name, and so on) is answered in the env files,
  // not here: `.sous/.env` holds the shared answers and is committed, and
  // `.sous/.env.local` holds the personal ones and is gitignored. `sous vars
  // list` shows every answer and where it came from, and `sous vars ask`
  // answers what is missing. A build lays those answers into the template
  // scope on its own, so nothing below has to name them; `_vars` is only for
  // what this config needs that no recipe asks about.
  _vars: {
    projectRoot: repoRoot,

    // Where this repository's own skill sources live, for the projectSkills
    // target above. The recipes learn the same path from the `skillsRoot`
    // answer in `.sous/.env`; this entry is the target's, so the target reads
    // as a target rather than as a reference to a recipe variable.
    projectSkillsDir: "${sousDir}/skills",

    // Compiled skill destination. Gitignored build output.
    claudeSkillsDir: "${projectRoot}/.claude/skills",
  },
  compilation: {
    includeSourceComments: false,
    targets: [projectSkills, rootClaude, docsSiteClaude],
  },
  tools: {
    claude: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
    },
  },
};
