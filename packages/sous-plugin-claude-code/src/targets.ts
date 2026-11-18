/**
 * The skill target, the memory target and the pointer file for Claude Code. They come from a
 * contributor, not from `register`, because this plugin's options (a different skills directory,
 * a different memories file, memories off) are part of the config.
 */

import type { ConfigBuilder, ContributorDefinition } from "@sous-io/plugin-api";
import type { MemoryTargetEntity } from "@sous-io/sous-plugin-memories/types";
import type { SkillTargetEntity } from "@sous-io/sous-plugin-skills/types";
import { HARNESS_ID } from "./harness.js";
import type { ClaudeCodePluginOptions } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "claude-code/targets";

/** The id of both targets. */
export const TARGET_ID = "claude-code";

/** Where Claude Code reads skills from, under the project root. */
export const SKILLS_DIRECTORY = ".claude/skills";

/**
 * Where the memories file goes by default: a rules file, which Claude Code loads beside any
 * `CLAUDE.md` the project has, so sous never writes over the project's own instructions (spec 15).
 */
export const MEMORIES_OUTPUT_PATH = "${projectRoot}/.claude/rules/SOUS-MEMORIES.md";

/** The file Claude Code reads in every directory it works in, which a pointer file is made of. */
export const POINTER_FILE = "CLAUDE.md";

/**
 * Adds the skill target, the memory target unless the plugin's `memories` option is `false`, and
 * the `CLAUDE.md` pointer file every folder sous creates gets.
 *
 * ```ts
 * // plugins.options."@sous-io/sous-plugin-claude-code": { memoriesOutputPath: "${projectRoot}/CLAUDE.md" }
 * // -> memory-target { id: "claude-code", harness: "claude-code", outputPath: "${projectRoot}/CLAUDE.md", backupExisting: true }
 * ```
 */
export function contributeTargets(config: ConfigBuilder): void {
    const options = config.options<ClaudeCodePluginOptions>() ?? {};
    const skills: SkillTargetEntity = {
        id: TARGET_ID,
        harness: HARNESS_ID,
        directory: options.skillsDirectory ?? SKILLS_DIRECTORY,
        description: "Claude Code reads skills from .claude/skills.",
    };

    config.addEntity("skill-target", skills);

    // Claude Code reads CLAUDE.md in every directory it works in, so each folder sous creates gets one
    // pointing at the folder's README.
    config.addEntity("pointer-file", { id: TARGET_ID, fileName: POINTER_FILE });

    if (options.memories !== false) {
        const memories: MemoryTargetEntity = {
            id: TARGET_ID,
            harness: HARNESS_ID,
            outputPath: options.memoriesOutputPath ?? MEMORIES_OUTPUT_PATH,
            backupExisting: true,
        };

        config.addEntity("memory-target", memories);
    }
}

/**
 * A directory from this plugin's options as an output directory: absolute and variable paths as
 * written, anything else under `${projectRoot}`, with no trailing slash.
 *
 * ```ts
 * outputDirectory(".claude/skills");   // -> "${projectRoot}/.claude/skills"
 * outputDirectory("/abs/skills/");     // -> "/abs/skills"
 * ```
 */
export function outputDirectory(directory: string): string {
    const trimmed = directory.trim().replace(/\/+$/, "");

    if (trimmed.startsWith("${") || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
        return trimmed;
    }

    return `\${projectRoot}/${trimmed.replace(/^\.\/+/, "")}`;
}

/** The contributor. */
export const targetsContributor: ContributorDefinition = {
    id: TARGETS_CONTRIBUTOR,
    contribute: contributeTargets,
};
