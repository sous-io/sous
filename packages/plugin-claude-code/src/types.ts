/**
 * The contract of plugin-claude-code (S6, "Host and package-manager plugins"): everything sous
 * knows about Claude Code, as entities: a `harness` (`claude`), a `skill-target` (`.claude/skills`)
 * and a `memory-target` (`CLAUDE.md`, read in any directory, so it is also a pointer file). It
 * declares no services, intents or events; nothing depends on it (G8).
 *
 * It is not the Sous-provided Claude Code plugin S3 describes.
 */

import type {} from "@sous-io/plugin-host/types";
import type { HarnessEntity, ToolSettings } from "@sous-io/plugin-harnesses/types";
import type { MemoryTargetEntity } from "@sous-io/plugin-memories/types";
import type { SkillTargetEntity } from "@sous-io/plugin-skills/types";

/** The ids of the entities this plugin adds. */
export type ClaudeCodeHarnessId = "claude";

/** The `skill-target` and `memory-target` id. */
export type ClaudeCodeTargetId = "claude-code";

/** The harness, as this plugin adds it: `launch`, `runHeadless` (the Agent SDK) and `readTranscript`. */
export type ClaudeCodeHarness = HarnessEntity & { id: ClaudeCodeHarnessId };

/** The skill target: `directory` is `.claude/skills`. */
export type ClaudeCodeSkillTarget = SkillTargetEntity & { id: ClaudeCodeTargetId; harness: ClaudeCodeHarnessId };

/** The memory target: `fileName` is `CLAUDE.md`, `readIn` is `any-directory`. */
export type ClaudeCodeMemoryTarget = MemoryTargetEntity & { id: ClaudeCodeTargetId; harness: ClaudeCodeHarnessId };

/** The user's settings for the harness, under `tools.claude` (read when `launch` runs). */
export type ClaudeToolSettings = ToolSettings;

/** This plugin's options (`plugins.options."@sous-io/plugin-claude-code"`). */
export interface ClaudeCodePluginOptions {
    /** The model headless runs use, when the prompt names none. */
    model?: string;
    /** Where skills go instead of `.claude/skills`. */
    skillsDirectory?: string;
    /** Turns the memory target off, for projects that write `CLAUDE.md` by hand. */
    memories?: boolean;
}
