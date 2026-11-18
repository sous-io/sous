/**
 * The contract of sous-plugin-memories: the one file each harness reads into every session
 * (`memory-target`), which recipe memories exist (`memories.selection`, the `#memories` name), and
 * the `memories.targets` contributor that turns each memory target into a compilation target.
 *
 * The file's source is the project's `.sous/MEMORIES.tpl.md` when it exists. Otherwise it is these
 * two lines, read as if written in a file inside `.sous/`:
 *
 * ```markdown
 * @memories/**\/*.md
 * @#memories/**\/*.md
 * ```
 *
 * The first includes the project's own files under `.sous/memories/`, the second the subscribed
 * recipes' memories. A result with nothing in it writes no file, and removes one an earlier build
 * wrote.
 *
 * Other plugins import this file type-only.
 */

/** One memory file. */
export interface Memory {
    /** The recipe it came from, `namespace/recipe`. */
    readonly recipe: string;
    /** The recipe's repository short name. */
    readonly repository?: string;
    /** Its path inside the recipe's memories, `/`-separated (as `#memories/<path>` names it). */
    readonly name: string;
    /** Absolute. For inline content, where it would be; no file exists there. */
    readonly path: string;
    /** Set for inline content (`{ $inline, path }` in a manifest): the memory's text, which no file holds. */
    readonly content?: string;
}

/**
 * A `memory-target` entity: the one file a harness reads into every session, which sous compiles
 * from the memories source. A harness's plugin adds one, from its own options:
 *
 * ```ts
 * config.addEntity("memory-target", {
 *     id: "claude-code",
 *     harness: "claude-code",
 *     outputPath: "${projectRoot}/.claude/rules/SOUS-MEMORIES.md",
 *     backupExisting: true,
 * });
 * ```
 */
export interface MemoryTargetEntity {
    /** `claude-code`, `codex`. The compilation target it becomes is `memories/<id>`. */
    id: string;
    /** The `harness` entity that reads the file. Its output is marked with it (S8, "The Merge"). */
    harness?: string;
    /**
     * The file to write. May hold `${projectRoot}` and other config variables; a relative path is
     * under the project root. Its folder is created.
     */
    outputPath: string;
    /**
     * A file whose content is placed before the memories, included as an `@` line includes a file
     * (a `.tpl.` file is rendered, and its own includes are followed). Skipped silently when the file
     * does not exist. A relative path is under the project root.
     */
    prependWith?: string;
    /**
     * When true and a file sous did not write already exists at `outputPath`, it is backed up under
     * `.sous/backups/`, a warning says so, and it is overwritten, whatever
     * `compilation.overwriteUntracked` says. Unset or false, the compiler's general rule applies.
     */
    backupExisting?: boolean;
}

/** Which memories go where. */
export interface MemoriesSelection {
    /** The active recipes' memories, ordered and filtered by `recipes.memories`. */
    selected(): Memory[];
    /**
     * The recipe memories one target's file takes through `@#memories/**\/*.md`: the selection.
     * Throws a `NotFoundError` for a target that does not exist.
     */
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

declare module "@sous-io/sous-plugin-api" {
    interface SousServices {
        "memories.selection": MemoriesSelection;
    }

    interface SousEntities {
        /** The one file a harness reads into every session. */
        "memory-target": MemoryTargetEntity;
    }

    interface SousConfig {
        "recipes.memories": MemoriesSettings;
    }
}
