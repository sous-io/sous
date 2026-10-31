/**
 * The skill target and memory target for Claude Code. They come from a contributor, not from
 * `register`, because this plugin's options (a different skills directory, memories off) are part of
 * the config.
 */

import type { ConfigBuilder, ContributorDefinition } from "@sous-io/plugin-api";
import type { MemoryTargetEntity } from "@sous-io/plugin-memories/types";
import type { SkillTargetEntity } from "@sous-io/plugin-skills/types";
import type { ClaudeCodePluginOptions } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "claude-code/targets";

/** The id of both targets. */
export const TARGET_ID = "claude-code";

/** Where Claude Code reads skills from, under the project root. */
export const SKILLS_DIRECTORY = ".claude/skills";

/** The file Claude Code reads into every session. */
export const MEMORY_FILE = "CLAUDE.md";

/** Adds the skill target, and the memory target unless the plugin's `memories` option is `false`. */
export function contributeTargets(config: ConfigBuilder): void {
    const options = config.options<ClaudeCodePluginOptions>() ?? {};
    const skills: SkillTargetEntity = {
        id: TARGET_ID,
        harness: "claude",
        directory: options.skillsDirectory ?? SKILLS_DIRECTORY,
        description: "Claude Code reads skills from .claude/skills.",
    };

    config.addEntity("skill-target", skills);

    if (options.memories !== false) {
        const memories: MemoryTargetEntity = {
            id: TARGET_ID,
            harness: "claude",
            fileName: MEMORY_FILE,
            // Claude Code reads CLAUDE.md in every directory it works in, so a pointer file is made of it too.
            readIn: "any-directory",
        };

        config.addEntity("memory-target", memories);
    }
}

/** The contributor. */
export const targetsContributor: ContributorDefinition = {
    id: TARGETS_CONTRIBUTOR,
    contribute: contributeTargets,
};
