/**
 * The contract of sous-plugin-codex: everything sous knows about Codex, as entities: a `harness`
 * (`codex`), a `memory-target` (`AGENTS.override.md` at the project root) and a `skill-target`
 * (`.agents/skills`). It declares no services, intents or events.
 *
 * Every entity is added only while the project has turned Codex on (see `isCodexOn`): a project
 * that never uses Codex gets no `AGENTS.override.md` and no extra config build.
 */

import type {} from "@sous-io/plugin-host/types";
import type { HarnessEntity, ToolSettings } from "@sous-io/plugin-harnesses/types";
import type { MemoryTargetEntity } from "@sous-io/plugin-memories/types";
import type { SkillTargetEntity } from "@sous-io/plugin-skills/types";

/** The harness's id, the key of its settings under `tools`, and what outputs for Codex are marked with. */
export type CodexHarnessId = "codex";

/** The `skill-target` and `memory-target` id. */
export type CodexTargetId = "codex";

/** The harness, as this plugin adds it: `launch` only. */
export type CodexHarness = HarnessEntity & { id: CodexHarnessId };

/** The skill target: `directory` is `.agents/skills`. */
export type CodexSkillTarget = SkillTargetEntity & { id: CodexTargetId; harness: CodexHarnessId };

/**
 * The fields of a `memory-target` that say where its file goes and what comes before the memories.
 * They are being added to `MemoryTargetEntity` itself in `@sous-io/plugin-memories` by a branch
 * built at the same time as this plugin; until that lands, this plugin declares them here.
 */
export interface MemoryTargetOutputFields {
    /** Where the file is written, as a config path: `${projectRoot}/AGENTS.override.md`. */
    outputPath: string;
    /** A file whose content is placed before the memories; skipped silently when it is missing. */
    prependWith?: string;
    /** A file at `outputPath` that Sous did not write is backed up, with a warning, before it is overwritten. */
    backupExisting?: boolean;
}

/** The memory target, as this plugin adds it. */
export type CodexMemoryTarget = MemoryTargetEntity & MemoryTargetOutputFields & { id: CodexTargetId; harness: CodexHarnessId };

/** The user's settings for the harness, under `tools.codex` (read when `launch` runs). */
export type CodexToolSettings = ToolSettings;

/**
 * This plugin's options (`plugins.options."@sous-io/sous-plugin-codex"`). Writing this key, even as
 * `{}`, turns Codex on for the project; so does writing `tools.codex`.
 */
export interface CodexPluginOptions {
    /** Where the memories file is written. Default `${projectRoot}/AGENTS.override.md`. */
    memoriesOutputPath?: string;
    /**
     * A file whose content is placed before the memories, because Codex reads `AGENTS.override.md`
     * in place of `AGENTS.md`. Default `${projectRoot}/AGENTS.md`; skipped silently when missing.
     */
    prependMemoriesWith?: string;
    /** Where skills go instead of `.agents/skills`. */
    skillsDirectory?: string;
    /** `false` writes no memories file for Codex. Default `true`. */
    memories?: boolean;
}
