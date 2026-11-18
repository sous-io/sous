/**
 * The contract of plugin-claude-code: everything sous
 * knows about Claude Code, as entities: a `harness` (`claude-code`), a `skill-target`
 * (`.claude/skills`), a `memory-target` (`.claude/rules/SOUS-MEMORIES.md`), a `CLAUDE.md`
 * `pointer-file`, and the content kinds `claude-code-plugin` and `claude-code-agent`. It declares
 * no services or intents; nothing depends on it.
 *
 * It is not the Sous-provided Claude Code plugin the docs describe.
 */

import type {} from "@sous-io/plugin-host/types";
import type { HarnessEntity, ToolSettings } from "@sous-io/plugin-harnesses/types";
import type { MemoryTargetEntity } from "@sous-io/plugin-memories/types";
import type { SkillTargetEntity } from "@sous-io/plugin-skills/types";

/** The ids of the entities this plugin adds. */
export type ClaudeCodeHarnessId = "claude-code";

/** The `skill-target` and `memory-target` id. */
export type ClaudeCodeTargetId = "claude-code";

/** The harness, as this plugin adds it: `launch`, `runHeadless` (the Agent SDK) and `readTranscript`. */
export type ClaudeCodeHarness = HarnessEntity & { id: ClaudeCodeHarnessId };

/** The skill target: `directory` is `.claude/skills`. */
export type ClaudeCodeSkillTarget = SkillTargetEntity & { id: ClaudeCodeTargetId; harness: ClaudeCodeHarnessId };

/** The memory target: `outputPath` is the `memoriesOutputPath` option, by default `.claude/rules/SOUS-MEMORIES.md`. */
export type ClaudeCodeMemoryTarget = MemoryTargetEntity & { id: ClaudeCodeTargetId; harness: ClaudeCodeHarnessId };

/** The user's settings for the harness, under `tools.claude-code` (read when `launch` runs). */
export type ClaudeToolSettings = ToolSettings;

/** This plugin's options (`plugins.options."@sous-io/plugin-claude-code"`). */
export interface ClaudeCodePluginOptions {
    /** The model headless runs use, when the prompt names none. */
    model?: string;
    /** Where skills go instead of `.claude/skills`. */
    skillsDirectory?: string;
    /**
     * Where the memories file is written. Default `${projectRoot}/.claude/rules/SOUS-MEMORIES.md`,
     * which Claude Code loads beside any `CLAUDE.md`. Config variables are allowed; a relative path
     * is under the project root. A file sous did not write there is backed up, with a warning, and
     * replaced.
     */
    memoriesOutputPath?: string;
    /** `false` writes no memories file at all. The source is still `.sous/MEMORIES.tpl.md` for other tools. */
    memories?: boolean;
}
