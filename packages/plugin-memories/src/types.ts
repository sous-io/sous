/**
 * The contract of plugin-memories (S6, "Memories: plugin-memories"): files a harness reads into
 * every session (`memory-target`), which memories go where, the `memories.targets` contributor that
 * turns memory targets into compilation targets (C6, C43), the `#memories` name, and a
 * `pointer-file` entity for every memory target read in any directory (C44).
 *
 * The order is: the active recipes' memories, the config's selection (`recipes.memories.first`,
 * `.exclude`), the target's `filter()`, then its `format()` (ruled 2026-10-29). The default
 * `format()` writes one compiler `@` include line per memory.
 *
 * Other plugins import this file type-only.
 */

import type { ConfigBuilder } from "@sous-io/plugin-api";

/** One memory file. */
export interface Memory {
    /** The recipe it came from, `namespace/recipe`. */
    readonly recipe: string;
    /** The recipe's repository short name. */
    readonly repository?: string;
    /** Its path inside the recipe's memories, `/`-separated (as `#memories/<path>` names it). */
    readonly name: string;
    /** Absolute. */
    readonly path: string;
}

/** Where a harness reads a memory file. */
export type MemoryReadIn = "project-root" | "any-directory";

/**
 * A `memory-target` entity (C43): a file a harness reads into every session. `filter` and `format`
 * run in the `memories.targets` contributor and get its builder, so what they read is recorded.
 */
export interface MemoryTargetEntity {
    /** `claude-code`. */
    id: string;
    /** The `harness` entity that reads it. */
    harness?: string;
    /** The file name: `CLAUDE.md`, `AGENTS.md`. */
    fileName: string;
    /** `any-directory` also makes a `pointer-file` entity of it. Default `project-root`. */
    readIn?: MemoryReadIn;
    /** Where the file is written; relative to the project root. Default the project root. */
    directory?: string;
    /** Which memories it takes. Default: all. Sous does not report what it leaves out. */
    filter?(memory: Memory, config: ConfigBuilder): boolean;
    /** The file's template content. Default: one `@<path>` include line per memory, blank lines between. */
    format?(memories: readonly Memory[], config: ConfigBuilder): string;
}

/** Which memories go where (S6, `memories.selection`). */
export interface MemoriesSelection {
    /** The active recipes' memories, ordered and filtered by `recipes.memories`. */
    selected(): Memory[];
    /** What one target gets after its `filter()`. */
    forTarget(targetId: string): Memory[];
    /** Memories the selection excluded, with the setting that did it. */
    excluded(): Array<{ readonly memory: Memory; readonly by: string }>;
}

/** The `recipes.memories` config key. */
export interface MemoriesSettings {
    /** Recipe keys or globs whose memories come first, in this order. Default `[]`. */
    first: string[];
    /** Recipe keys or globs whose memories are left out. Default `[]`. */
    exclude: string[];
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        "memories.selection": MemoriesSelection;
    }

    interface SousEntities {
        /** A file a harness reads into every session. */
        "memory-target": MemoryTargetEntity;
    }

    interface SousConfig {
        "recipes.memories": MemoriesSettings;
    }
}
