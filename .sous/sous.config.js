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
 * OUTPUT IS LOCAL-ONLY. `.claude/` is gitignored, so everything written here is
 * a build artifact, not a tracked file. The repo's root CLAUDE.md is HAND-WRITTEN
 * and tracked, so this config deliberately compiles NO root instruction file —
 * skills only. Do not add a `destinationFile` target for CLAUDE.md or AGENTS.md.
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

        // Compiled skill destination. Gitignored build output.
        claudeSkillsDir: "${projectRoot}/.claude/skills",
      },
      compilation: {
        includeSourceComments: false,
        targets: [sousSkills, controlFlowSkills],
      },
      tools: {
        claude: { command: "claude" },
      },
    },
  },
};
