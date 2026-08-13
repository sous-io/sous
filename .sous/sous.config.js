/**
 * Sous configuring itself.
 *
 * This is the config sous uses on its own repository. It exists both because
 * the sous repo genuinely wants compiled agent skills and because dogfooding
 * keeps the discovery path, the `${sousDir}` auto-var and the skill bundles
 * honest: if any of them break, `xcv build` on this repo breaks.
 *
 * Discovery: `xcv build` walks up from cwd, finds this `.sous/` directory and
 * loads this file. Auto-vars `${sousDir}` (this directory) and
 * `${sousConfigPath}` (this file) are injected before anything else resolves.
 *
 * OUTPUT IS LOCAL-ONLY. `.claude/`, and every file this config writes, is
 * gitignored build output. That includes BOTH instruction files: the repo-root
 * CLAUDE.md and docs/CLAUDE.md are compiled from tracked sources under
 * `.sous/prompts/` — edit those sources, never the compiled copies. A fresh
 * clone has no root CLAUDE.md until the first `xcv build`.
 */

// [SOUS] The built-in sous bundle: about-sous, about-agent-skills,
// about-liquid-templates, create-skill. These are the skills that teach an agent
// how sous itself works, so they are exactly what an agent working ON sous needs.
const sousSkills = {
  entryGlob: "${sharedSkillsRoot}/sous-skills/**/*",
  outputs: [{ destinationDir: "${claudeSkillsDir}" }],
};

// [SOUS] Control-flow skills: approve, opine, repeat, research. Generic
// interaction helpers with no project-specific variables.
const controlFlowSkills = {
  entryGlob: "${sharedSkillsRoot}/control-flow/**/*",
  outputs: [{ destinationDir: "${claudeSkillsDir}" }],
};

// [SOUS] Project-local skills: hand-maintained, sous-specific skills that have no
// shared-bundle equivalent (currently the unit-testing pair). These describe how to
// work ON this repo, so they are NOT distributed to downstream projects and do not
// live under shared-prompts/. They are plain SKILL.md files with no variables, so
// compilation is effectively a mirrored copy into .claude/skills/.
const projectSkills = {
  entryGlob: "${projectSkillsDir}/**/*",
  globBase: "${projectSkillsDir}",
  outputs: [{ destinationDir: "${claudeSkillsDir}" }],
};

// [ROOT] The repo-root CLAUDE.md: instructions for agents working ON sous.
// The source is tracked; the compiled /CLAUDE.md is gitignored output. Plain
// markdown (no .tpl.) — @-includes work if the doc is ever split into sections.
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

// Deliberately NOT compiled here:
//   - task-files: sous development does not use per-branch task files, and the
//     bundle needs taskFileRoot / ticketPrefix / ticketIdExample, none of which
//     mean anything for this repo.
//   - automated-browser-tasks: needs browserAutomationScriptsDir pointing at a
//     real script directory. sous has none.

import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo root is this file's grandparent (`<repo>/.sous/sous.config.js`).
// Derived here rather than as `${sousDir}/..` because these paths are rendered
// into agent-facing skill text, and `/repo/.sous/../shared-prompts` reads badly
// next to `/repo/shared-prompts`. A config is a real ES module, so it may
// compute values like this.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  _vars: {
    projectRoot: repoRoot,
  },
  projects: {
    // Single-project config: no defaultProject needed, sous uses the only key.
    sous: {
      name: "Sous",
      _vars: {
        // Where this repo's own shared skill sources live. `about-sous`,
        // `about-agent-skills` and `create-skill` all render this path to tell
        // the agent where to write skills. For sous itself the sources are the
        // shared bundles, so it points at the bundle root rather than at some
        // separate per-project skills directory.
        skillsRoot: "${projectRoot}/shared-prompts/skills",

        // Bundle root, used by the targets above.
        sharedSkillsRoot: "${projectRoot}/shared-prompts/skills",

        // Hand-maintained skills that are specific to developing sous itself and
        // are NOT distributed downstream. Tracked sources; see projectSkills.
        projectSkillsDir: "${sousDir}/skills",

        // Compiled skill destination. Gitignored build output.
        claudeSkillsDir: "${projectRoot}/.claude/skills",
      },
      compilation: {
        includeSourceComments: false,
        targets: [sousSkills, controlFlowSkills, projectSkills, rootClaude, docsSiteClaude],
      },
      tools: {
        claude: {
          command: "claude",
          args: ["--dangerously-skip-permissions"],
        },
      },
    },
  },
};
