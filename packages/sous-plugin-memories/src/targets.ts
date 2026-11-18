/**
 * The `memories.targets` contributor: one `content` compilation target per `memory-target` entity,
 * compiled from the memories source into the target's `outputPath`.
 *
 * The source is the project's `.sous/MEMORIES.tpl.md` when it exists. Otherwise it is the default,
 * the two lines spec 15 names, read as if written in a file inside `.sous/`:
 *
 * ```markdown
 * @memories/**\/*.md      <- the project's own files under .sous/memories/
 * @#memories/**\/*.md     <- the subscribed recipes' memories
 * ```
 *
 * The default is written out as the include lines it stands for: the project's files as one glob
 * line, and the recipes' memories as one line per memory, in selection order, so a memory a
 * manifest gives inline (`{ $inline, path }`), which no file holds, is written in place.
 *
 * A target's `prependWith` file, when it exists, is included before the source. A file that
 * compiles to nothing is not written, and a copy an earlier build wrote is removed (the
 * `memories/skip-empty` transform leaves it out, so the prune removes it).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigBuilder, ContributorDefinition, ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import type { CompilationOutput, CompilationTarget, CompilationTransformEntity } from "@sous-io/sous-plugin-compiler/types";
import { selectMemories, type MemoryGlobs, type MemoryRecipe } from "./listing.js";
import type { MemoriesSettings, Memory, MemoryTargetEntity } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "memories.targets";

/** The memories source a project may write, inside `.sous/`. */
export const MEMORIES_SOURCE = "MEMORIES.tpl.md";

/** The project's own memories folder, inside `.sous/`. */
export const PROJECT_MEMORIES_DIR = "memories";

/** The default source, as spec 15 names it: what `sous init` writes into `.sous/MEMORIES.tpl.md`. */
export const DEFAULT_SOURCE_LINES = ["@memories/**/*.md", "@#memories/**/*.md"] as const;

/** The transform that leaves out a memories file that compiled to nothing. */
export const SKIP_EMPTY_TRANSFORM = "memories/skip-empty";

/** The id of the compilation target a memory target becomes: `memories/claude-code`. */
export function compilationTargetId(target: Pick<MemoryTargetEntity, "id">): string {
    return `memories/${target.id}`;
}

/**
 * One compiler `@` include line per recipe memory, with a blank line between. Inline content is
 * written in place.
 *
 * ```ts
 * defaultFormat([{ path: "/store/a/one/memories/m.md" }, { path: "/store/b/two/memories/n.md" }]);
 * // -> "@/store/a/one/memories/m.md\n\n@/store/b/two/memories/n.md"
 * ```
 */
export function defaultFormat(memories: readonly Pick<Memory, "path" | "content">[]): string {
    return memories.map((memory) => (memory.content === undefined ? `@${memory.path}` : inlineMemory(memory.content, memory.path))).join("\n\n");
}

/**
 * Inline memory content as it goes into a memory file's template: no file holds it, so it is
 * written in place. Only a `.tpl.` path is a template, so any other content is wrapped in
 * `{% raw %}`, since the compiler renders the whole memory file as Liquid.
 */
export function inlineMemory(content: string, virtualPath: string): string {
    return virtualPath.split(/[\\/]/).pop()!.includes(".tpl.") ? content : `{% raw %}${content}{% endraw %}`;
}

/**
 * A path from a memory target as a config path: absolute and variable paths as written, anything
 * else under `${projectRoot}`.
 *
 * ```ts
 * configPath(".claude/rules/SOUS-MEMORIES.md");   // -> "${projectRoot}/.claude/rules/SOUS-MEMORIES.md"
 * configPath("${projectRoot}/CLAUDE.md");         // -> "${projectRoot}/CLAUDE.md"
 * ```
 */
export function configPath(file: string): string {
    const trimmed = file.trim();

    if (trimmed.startsWith("${") || trimmed.startsWith("~/") || path.isAbsolute(trimmed)) {
        return trimmed;
    }

    return `\${projectRoot}/${trimmed.replace(/^\.\/+/, "")}`;
}

/**
 * Where a config path is on disk, for checking that a file exists: `${projectRoot}`, `${sousDir}`
 * and `~/` are filled in. A path naming any other variable gives `undefined`.
 */
export function diskPath(file: string, project: Pick<ProjectInfo, "root" | "sousDir">): string | undefined {
    const filled = configPath(file)
        .replace(/^~\//, `${os.homedir()}/`)
        .replace(/\$\{projectRoot\}/g, project.root)
        .replace(/\$\{sousDir\}/g, project.sousDir);

    return filled.includes("${") ? undefined : path.resolve(project.root, filled);
}

/** Whether a folder holds a Markdown file anywhere below it. */
function holdsMarkdown(dir: string): boolean {
    let entries: fs.Dirent[];

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }

    return entries.some((entry) => (entry.isDirectory() ? holdsMarkdown(path.join(dir, entry.name)) : entry.name.endsWith(".md")));
}

/** What the compilation target for one memory target is made from. */
export interface MemoriesSource {
    readonly project: Pick<ProjectInfo, "root" | "sousDir">;
    /** The recipe memories, in selection order. */
    readonly selected: readonly Memory[];
    /** Whether a file exists. Default: `fs.existsSync`. */
    readonly exists?: (file: string) => boolean;
}

/**
 * The template content for one memory target, or `undefined` when nothing could be in it (no
 * source file, no file to prepend, no project memories and no recipe memories). Every path is
 * written absolute, as found on disk, so the include reads the file this check found.
 *
 * ```ts
 * // project /p, no .sous/MEMORIES.tpl.md; .sous/memories/project.tpl.md; recipe memory /store/a/one/memories/m.md
 * memoriesContent({ id: "claude-code", outputPath: ".claude/rules/SOUS-MEMORIES.md" }, source);
 * // -> "@/p/.sous/memories/**\/*.md\n\n@/store/a/one/memories/m.md"
 *
 * // with .sous/MEMORIES.tpl.md, and prependWith "AGENTS.md", which exists
 * // -> "@/p/AGENTS.md\n\n@/p/.sous/MEMORIES.tpl.md"
 * ```
 */
export function memoriesContent(target: Pick<MemoryTargetEntity, "prependWith">, source: MemoriesSource): string | undefined {
    const exists = source.exists ?? fs.existsSync;
    const parts: string[] = [];

    if (typeof target.prependWith === "string" && target.prependWith.trim() !== "") {
        const file = diskPath(target.prependWith, source.project);

        if (file !== undefined && exists(file)) {
            parts.push(`@${file}`);
        }
    }

    if (exists(path.join(source.project.sousDir, MEMORIES_SOURCE))) {
        parts.push(`@${path.join(source.project.sousDir, MEMORIES_SOURCE)}`);
    } else {
        if (holdsMarkdown(path.join(source.project.sousDir, PROJECT_MEMORIES_DIR))) {
            parts.push(`@${path.join(source.project.sousDir, PROJECT_MEMORIES_DIR)}/**/*.md`);
        }

        if (source.selected.length > 0) {
            parts.push(defaultFormat(source.selected));
        }
    }

    return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * The compilation target for one memory target, or `undefined` when nothing could be in it.
 *
 * ```ts
 * compilationTargetFor({ id: "claude-code", harness: "claude-code", outputPath: ".claude/rules/SOUS-MEMORIES.md" }, source, "@sous-io/sous-plugin-memories");
 * // -> { id: "memories/claude-code", content: "...", transforms: ["memories/skip-empty"],
 * //      origin: { plugin: "@sous-io/sous-plugin-memories" },
 * //      outputs: [{ destinationFile: "${projectRoot}/.claude/rules/SOUS-MEMORIES.md", harness: "claude-code" }] }
 * ```
 */
export function compilationTargetFor(target: MemoryTargetEntity, source: MemoriesSource, plugin: string): CompilationTarget | undefined {
    const content = memoriesContent(target, source);

    if (content === undefined) {
        return undefined;
    }

    const output: CompilationOutput = {
        destinationFile: configPath(target.outputPath),
        ...(typeof target.harness === "string" && target.harness !== "" ? { harness: target.harness } : {}),
        ...(target.backupExisting === true ? { backupExisting: true } : {}),
    };

    return {
        id: compilationTargetId(target),
        content,
        transforms: [SKIP_EMPTY_TRANSFORM],
        origin: { plugin },
        outputs: [output],
    };
}

/** The transform that leaves out a memories file with nothing but white space in it. */
export const skipEmptyTransform: CompilationTransformEntity = {
    id: SKIP_EMPTY_TRANSFORM,
    description: "Leaves out a memories file that compiled to nothing, so no empty file is written and an earlier copy is removed.",
    transform: (file) => (typeof file.content === "string" && file.content.trim() === "" ? undefined : file),
};

/** Reads `recipes.memories` through the builder, so a change re-runs the contributor. */
export function readSettings(config: ConfigBuilder): Partial<MemoriesSettings> {
    const value = config.atPath(["recipes", "memories"]).get<Partial<MemoriesSettings>>();

    return value !== null && typeof value === "object" ? value : {};
}

/**
 * The `memories.targets` contributor.
 *
 * @param plugin - The plugin's name, recorded as each target's origin.
 * @param services - Where `host.globs` comes from (a singleton, usable while the config is built).
 */
export function targetsContributor(plugin: string, services: ServiceReader): ContributorDefinition {
    // A contributor re-runs on later passes and builds; each warning is given once per process.
    const warned = new Set<string>();

    return {
        id: TARGETS_CONTRIBUTOR,

        contribute(config) {
            const targets = config.entities("memory-target");
            const project = config.project;

            if (targets.length === 0 || project === undefined) {
                return;
            }

            const globs = services.get("host.globs") as MemoryGlobs;
            const { selected } = selectMemories({
                recipes: config.entities("active-recipe") as MemoryRecipe[],
                settings: readSettings(config),
                globs,
                // The `memories` entries of `recipes.contents` (law L8), read through the builder.
                contents: services.get("recipes.contents").of(config, "memories"),
                onWarning: (message) => {
                    if (!warned.has(message)) {
                        warned.add(message);
                        config.warn(message);
                    }
                },
            });

            for (const target of targets) {
                const compilation = compilationTargetFor(target, { project, selected }, plugin);

                if (compilation) {
                    config.atPath(["compilation", "targets"]).appendValue(compilation);
                }
            }
        },
    };
}
