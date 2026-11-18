/**
 * The `codex/targets` contributor: the Codex harness, its memory target, its skill target and the
 * `.gitignore` line for the memories file, all added only while the project has turned Codex on.
 *
 * They come from a contributor, not from `register`, because whether Codex is on, and this plugin's
 * options, are part of the config. A harness that is always registered would cost every project one
 * more config build (S8), and a memory target that is always registered would write an
 * `AGENTS.override.md` into projects that never use Codex.
 */

import path from "node:path";
import type { ConfigBuilder, ContributorDefinition } from "@sous-io/plugin-api";
import type { SkillTargetEntity } from "@sous-io/sous-plugin-skills/types";
import { codexHarness, HARNESS_ID } from "./harness.js";
import type { CodexMemoryTarget, CodexPluginOptions } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "codex/targets";

/** The id of both targets. */
export const TARGET_ID = "codex";

/** Where Codex reads skills from, under the project root (from Codex's documentation; not run). */
export const SKILLS_DIRECTORY = ".agents/skills";

/** The file Codex reads in place of a folder's `AGENTS.md`. */
export const MEMORY_FILE = "AGENTS.override.md";

/** Where the memories file goes by default. */
export const DEFAULT_MEMORIES_OUTPUT_PATH = `\${projectRoot}/${MEMORY_FILE}`;

/** The file placed before the memories by default: the project's own instructions. */
export const DEFAULT_PREPEND_MEMORIES_WITH = "${projectRoot}/AGENTS.md";

/** The config key the editor applies. */
const EDITOR_EDITS_KEY = ["editor", "edits"];

/** The config variable a path under the project root starts with. */
const PROJECT_ROOT_PREFIX = "${projectRoot}/";

/**
 * Whether the project has turned Codex on: it wrote this plugin's options (even `{}`) or
 * `tools.codex`. Both reads are recorded, so writing either later re-runs the contributor.
 *
 * ```jsonc
 * { "plugins": { "options": { "@sous-io/sous-plugin-codex": {} } } }   // on
 * { "tools": { "codex": { "args": ["--full-auto"] } } }                // on
 * {}                                                                   // off
 * ```
 */
export function isCodexOn(config: ConfigBuilder): boolean {
    const options = config.options<CodexPluginOptions>();
    const tool = config.atPath(["tools", HARNESS_ID]).get();

    return isObject(options) || isObject(tool);
}

/**
 * A path from this plugin's options as a config path: one that starts with `${...}` or is absolute
 * stays as it is; a relative one is put under `${projectRoot}`.
 *
 * ```ts
 * configPath("docs/AGENTS.override.md");              // -> "${projectRoot}/docs/AGENTS.override.md"
 * configPath("${projectRoot}/AGENTS.override.md");    // -> unchanged
 * configPath("/srv/app/AGENTS.override.md");          // -> unchanged
 * ```
 */
export function configPath(value: string): string {
    if (value.startsWith("${") || path.isAbsolute(value)) {
        return value;
    }

    return `${PROJECT_ROOT_PREFIX}${value.replace(/^(\.\/)+/, "")}`;
}

/**
 * The `.gitignore` line that keeps a file out of git, anchored at the project root, or `undefined`
 * for a file outside the project or under another variable.
 *
 * ```ts
 * ignoreLine("${projectRoot}/AGENTS.override.md", "/work/app");    // -> "/AGENTS.override.md"
 * ignoreLine("/work/app/docs/AGENTS.override.md", "/work/app");    // -> "/docs/AGENTS.override.md"
 * ignoreLine("/elsewhere/AGENTS.override.md", "/work/app");        // -> undefined
 * ```
 */
export function ignoreLine(outputPath: string, projectRoot: string | undefined): string | undefined {
    let relative: string | undefined;

    if (outputPath.startsWith(PROJECT_ROOT_PREFIX)) {
        relative = outputPath.slice(PROJECT_ROOT_PREFIX.length);
    } else if (projectRoot !== undefined && path.isAbsolute(outputPath)) {
        const inside = path.relative(projectRoot, outputPath);

        if (inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside)) {
            relative = inside;
        }
    }

    if (relative === undefined || relative.includes("${")) {
        return undefined;
    }

    return `/${relative.split(path.sep).join("/").replace(/^\/+/, "")}`;
}

/** Adds the harness and the targets when Codex is on; nothing otherwise. */
export function contributeTargets(config: ConfigBuilder): void {
    if (!isCodexOn(config)) {
        return;
    }

    const options = config.options<CodexPluginOptions>() ?? {};

    config.addEntity("harness", codexHarness);

    const skills: SkillTargetEntity = {
        id: TARGET_ID,
        harness: HARNESS_ID,
        directory: options.skillsDirectory ?? SKILLS_DIRECTORY,
        description: "Codex reads skills from .agents/skills.",
    };

    config.addEntity("skill-target", skills);

    if (options.memories === false) {
        return;
    }

    const outputPath = configPath(options.memoriesOutputPath ?? DEFAULT_MEMORIES_OUTPUT_PATH);
    const memories: CodexMemoryTarget = {
        id: TARGET_ID,
        harness: HARNESS_ID,
        outputPath,
        prependWith: configPath(options.prependMemoriesWith ?? DEFAULT_PREPEND_MEMORIES_WITH),
        backupExisting: true,
    };

    config.addEntity("memory-target", memories);

    // Keep the file out of git. `sous init` writes `/AGENTS.override.md` into the root .gitignore for
    // new projects; this also covers older projects and a moved file. Only when the editor is loaded.
    const line = ignoreLine(outputPath, config.project?.root);

    if (line !== undefined && config.entity("config-key", "editor") !== undefined) {
        config.atPath(EDITOR_EDITS_KEY).append({ file: ".gitignore", ensureLine: { line } });
    }
}

/** The contributor. */
export const targetsContributor: ContributorDefinition = {
    id: TARGETS_CONTRIBUTOR,
    contribute: contributeTargets,
};

function isObject(value: unknown): boolean {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
