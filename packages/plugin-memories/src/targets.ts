/**
 * The `memories.targets` contributor (S6, "Memories: plugin-memories"): one `content` compilation
 * target per `memory-target` entity (C6, C43), and a `pointer-file` entity for every memory target
 * read in any directory (C44).
 *
 * The order is: the active recipes' memories, the config's selection, the target's `filter()`, then
 * its `format()`. Sous does not report what a filter left out; a plugin that wants the user to know
 * says so itself.
 */

import type { ConfigBuilder, ContributorDefinition, ServiceReader } from "@sous-io/plugin-api";
import type { CompilationTarget } from "@sous-io/plugin-compiler/types";
import { selectMemories, type MemoryGlobs, type MemoryRecipe } from "./listing.js";
import type { MemoriesSettings, Memory, MemoryTargetEntity } from "./types.js";

/** The contributor's id. */
export const TARGETS_CONTRIBUTOR = "memories.targets";

/** The id of the compilation target a memory target becomes: `memories/claude-code`. */
export function compilationTargetId(target: Pick<MemoryTargetEntity, "id">): string {
    return `memories/${target.id}`;
}

/** The id of the pointer-file entity a memory target read in any directory becomes. */
export function pointerFileId(target: Pick<MemoryTargetEntity, "id">): string {
    return `memories/${target.id}`;
}

/**
 * The default `format()`: one compiler `@` include line per memory, with a blank line between, so
 * the compiler pulls each memory in.
 *
 * ```ts
 * defaultFormat([{ path: "/store/a/one/memories/m.md" }, { path: "/store/b/two/memories/n.md" }]);
 * // -> "@/store/a/one/memories/m.md\n\n@/store/b/two/memories/n.md"
 * ```
 */
export function defaultFormat(memories: readonly Pick<Memory, "path">[]): string {
    return memories.map((memory) => `@${memory.path}`).join("\n\n");
}

/** What one target takes, after its `filter()`. */
export function memoriesForTarget(
    target: MemoryTargetEntity,
    selected: readonly Memory[],
    config: ConfigBuilder,
): Memory[] {
    return target.filter ? selected.filter((memory) => target.filter!(memory, config)) : [...selected];
}

/** Where a target's file is written, as a config path with `${projectRoot}`. */
export function destinationFile(target: Pick<MemoryTargetEntity, "directory" | "fileName">): string {
    const directory = (target.directory ?? "").replace(/^\.?\/+|\/+$/g, "");

    return directory === "" ? `\${projectRoot}/${target.fileName}` : `\${projectRoot}/${directory}/${target.fileName}`;
}

/**
 * The compilation target for one memory target, or `undefined` when its content is empty (nothing
 * to write, so an existing file is left alone).
 */
export function compilationTargetFor(
    target: MemoryTargetEntity,
    selected: readonly Memory[],
    config: ConfigBuilder,
    plugin: string,
): CompilationTarget | undefined {
    const memories = memoriesForTarget(target, selected, config);
    const content = target.format ? target.format(memories, config) : defaultFormat(memories);

    if (content === "") {
        return undefined;
    }

    return {
        id: compilationTargetId(target),
        content,
        origin: { plugin },
        outputs: [{ destinationFile: destinationFile(target) }],
    };
}

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

            for (const target of targets) {
                if (target.readIn === "any-directory") {
                    config.addEntity("pointer-file", { id: pointerFileId(target), fileName: target.fileName });
                }
            }

            if (targets.length === 0) {
                return;
            }

            const globs = services.get("host.globs") as MemoryGlobs;
            const { selected } = selectMemories({
                recipes: config.entities("active-recipe") as MemoryRecipe[],
                settings: readSettings(config),
                globs,
                onWarning: (message) => {
                    if (!warned.has(message)) {
                        warned.add(message);
                        config.log("warning", message);
                    }
                },
            });

            for (const target of targets) {
                const compilation = compilationTargetFor(target, selected, config, plugin);

                if (compilation) {
                    config.atPath(["compilation", "targets"]).appendValue(compilation);
                }
            }
        },
    };
}
