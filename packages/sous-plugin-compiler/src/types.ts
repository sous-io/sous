/**
 * The contract of sous-plugin-compiler: compiling every compilation
 * target in the config into outputs, include resolution (`@`, `~`, `#`), aliases, the compilation
 * settings, the built-in tags and filter, the state file, writing every build output, and pruning.
 *
 * Among the built-in plugins only the compiler writes build outputs; others add
 * compilation targets to the config. It compiles whatever targets the config holds, with a
 * scope and a namespace resolver, so it depends on no recipe plugin.
 *
 * Other plugins import this file type-only.
 */

import type { ServiceContext } from "@sous-io/sous-plugin-api";
import type { VarScope } from "@sous-io/sous-plugin-variables/types";

// ---------------------------------------------------------------------------------------------
// The `compilation` and `_aliases` config keys
// ---------------------------------------------------------------------------------------------

/** Who added a target, so the state file records where each output came from. */
export interface CompilationOrigin {
    /** The plugin whose contributor added it. */
    plugin?: string;
    /** The recipe whose content it compiles: `namespace/recipe`. */
    recipe?: string;
    /** The short name of that recipe's repository. */
    repository?: string;
}

/** One output of a target. */
export interface CompilationOutput {
    /** Variables of this output's scope. */
    _vars?: Record<string, string>;
    /** Where a single output goes. One of `destinationFile` and `destinationDir`. */
    destinationFile?: string;
    /** Where a glob target's files go, mirroring their paths under the glob's base. */
    destinationDir?: string;
    /** `compilation-transform` ids applied to this output, after the target's own. */
    transforms?: string[];
    /**
     * The harness this output belongs to (`claude-code`, `codex`): set by the contributors that
     * write a harness's skills or memories. Templates read it as `harness.id`, which is `""` for an
     * output that belongs to none.
     */
    harness?: string;
    /**
     * When true, a file sous did not write at the destination is backed up under
     * `.sous/backups/`, a warning says so, and the file is overwritten, whatever
     * `compilation.overwriteUntracked` says. Unset, the compiler's general rule applies. Set by a
     * memory target's `backupExisting`.
     */
    backupExisting?: boolean;
}

/**
 * One compilation target. Its source is exactly one of `entryPoint`, `entryGlob` and `content`; a
 * `content` target needs an `id`, which names the source in errors.
 */
export interface CompilationTarget {
    /** Names the target in errors, `config show` and `compiler.compile`'s `targets`. */
    id?: string;
    /** Variables of this target's scope. */
    _vars?: Record<string, string>;
    /** One source file. */
    entryPoint?: string;
    /** A glob of source files. */
    entryGlob?: string;
    /** A template string as the source. */
    content?: string;
    /** The base output paths mirror under; default: the glob's static base. */
    globBase?: string;
    /** Writes `<!-- source -->` comments; default the compilation-wide setting. */
    includeSourceComments?: boolean;
    /** Asks sous-plugin-build to write the runtime context file before this target compiles. */
    generateRuntimeContext?: boolean;
    /** `compilation-transform` ids applied to every output. */
    transforms?: string[];
    /** Who added it. */
    origin?: CompilationOrigin;
    outputs: CompilationOutput[];
}

/**
 * One file a build writes: one output of one source of one target. Sous lists them while it builds
 * the config (the `compiler.files` contributor matches each `entryGlob` against the disk then), so
 * the config says which files a build writes, and the compiler reads these instead of matching
 * globs itself.
 *
 * ```jsonc
 * // sous config get compilation.files
 * [{ "target": "projectSkills", "targetIndex": 0, "source": "/p/.sous/skills/review/SKILL.tpl.md",
 *    "output": 0, "destination": "/p/.claude/skills/review/SKILL.md" }]
 * ```
 */
export interface CompilationFile {
    /** The target's name: its id, or its index as text. */
    target: string;
    /** The target's index in `compilation.targets`. */
    targetIndex: number;
    /** The source file, absolute; for a `content` target, a path named after its id under the project root. */
    source: string;
    /** The output's index in the target's `outputs`. */
    output: number;
    /** The file it writes, absolute, from before any transform. */
    destination: string;
    /** The output's harness, when it has one. */
    harness?: string;
    /**
     * Variables `compilation.varOverrides` sets for this file (the `compiler.var-overrides`
     * contributor). They win over the output's own `_vars`.
     */
    _vars?: Record<string, string>;
}

/** A problem found while listing the files, reported when a build runs. */
export interface CompilationFileProblem extends CompileProblem {
    /** The target's index, when the problem belongs to one. */
    readonly targetIndex?: number;
}

/** What listing the files of the targets found, beside the files themselves. */
export interface CompilationListing {
    /**
     * How many targets were listed. A target at a later index was added after the listing (by a
     * contributor in a later config stage), so it has no files, and a build says so.
     */
    targets: number;
    /** What went wrong: a variable no one sets, a glob that matched nothing. */
    problems: CompilationFileProblem[];
}

/**
 * One rule of `compilation.varOverrides`: variables for every file whose path matches. Each of
 * `match` and `exclude` is one entry or a list; an entry is a glob, or a regular expression when
 * written between two slashes. A rule's variables win over the output's own; a later rule wins over
 * an earlier one for a name both set. The path matched is the one Sous planned to write, before
 * any transform.
 *
 * ```js
 * compilation: {
 *     varOverrides: [
 *         {
 *             match: "${projectRoot}/.claude/**",
 *             exclude: ["/\\.local\\./"],
 *             _vars: { tool: "claude" },
 *         },
 *     ],
 * },
 * ```
 */
export interface CompilationVarOverride {
    match: string | string[];
    exclude?: string | string[];
    _vars: Record<string, string>;
}

/** The `compilation` config key, with its defaults filled in. */
export interface CompilationSettings {
    /** Variables of the compilation scope. */
    _vars?: Record<string, string>;
    /** Variables by output path. Default `[]`. */
    varOverrides?: CompilationVarOverride[];
    /** Every file a build writes, listed while the config is built. Set by Sous. */
    files?: CompilationFile[];
    /** What listing the files found. Set by Sous. */
    listing?: CompilationListing;
    /** Default `false`. */
    includeSourceComments: boolean;
    /** Overwrites files the compiler did not write, taking ownership. Default `true`; `false` opts out. */
    overwriteUntracked: boolean;
    /** Where the state file is written. Default `${sousDir}/.state.json`. */
    stateFile?: string;
    /** Default `[]`. */
    targets: CompilationTarget[];
}

/** The `_aliases` config key: an alias name to one base directory or several, tried in order. */
export type AliasesSettings = Record<string, string | string[]>;

// ---------------------------------------------------------------------------------------------
// The compilation-transform entity (agent addition: how a skill target's transform reaches the compiler)
// ---------------------------------------------------------------------------------------------

/** One output file as a transform sees it. */
export interface TransformFile {
    /** The source file, or the target id for a `content` target. */
    readonly source: string;
    /** Where it will be written, absolute. */
    destination: string;
    content: string;
}

/**
 * A `compilation-transform` entity: changes an output's path or contents before it is written.
 * Targets and outputs name it under `transforms` (a skill target's optional transform).
 */
export interface CompilationTransformEntity {
    id: string;
    description?: string;
    /** Returns the file to write, or `undefined` to write nothing for it. */
    transform(file: TransformFile, ctx: ServiceContext): TransformFile | undefined | Promise<TransformFile | undefined>;
}

// ---------------------------------------------------------------------------------------------
// compiler.namespace-resolver (implemented by sous-plugin-recipes)
// ---------------------------------------------------------------------------------------------

/** Why a recipe the include names is not pinned in this project. */
export type DroppedRecipe =
    | { by: "recipe"; recipe: string; declaredAt: string; pinned: string; through?: string[] }
    | { by: "disabled-subscription"; subscription: string };

/** A recipe and the directory its files are in. */
export interface RecipeRoot {
    readonly recipe: string;
    readonly dir: string;
}

/** A `~namespace/recipe/path` include to resolve. */
export interface NamespaceRequest {
    /** The reference with its `~` removed, `${var}` already substituted. */
    reference: string;
    /** The file the include is written in, which decides the recipe it may reach. */
    fromFile: string;
}

/** What a namespace include resolves to. */
export type NamespaceResolution =
    | { kind: "candidates"; candidates: string[]; glob?: true; roots?: RecipeRoot[] }
    | { kind: "unknown-namespace"; namespace: string; recipe: string; known: string[]; dropped?: DroppedRecipe }
    | { kind: "unknown-recipe"; recipe: string; known: string[]; dropped?: DroppedRecipe }
    | { kind: "not-a-dependency"; recipe: string; includingRecipe: string | null }
    | { kind: "escapes-recipe"; recipe: string; reference: string }
    | { kind: "invalid"; reference: string; message: string };

/** The resolver the `~` sigil uses: declared here, registered by sous-plugin-recipes. */
export interface NamespaceResolver {
    resolve(request: NamespaceRequest): NamespaceResolution;
    /** The recipe a file belongs to, or `null` for a project file. */
    includingRecipe?(fromFile: string): string | null;
}

// ---------------------------------------------------------------------------------------------
// compiler.includes and compiler.aliases
// ---------------------------------------------------------------------------------------------

/** Where an include is written. */
export interface IncludeContext {
    /** The file the include line or `{% render %}` is in. */
    fromFile: string;
    /** The directory a relative path resolves against. Default: the file's directory. */
    baseDir?: string;
    /** The variable scope `${var}` in the path is substituted from. */
    scope: VarScope;
}

/** One group of candidate paths; the first group that names a file wins. */
export interface IncludeGroup {
    readonly paths: string[];
    readonly glob: boolean;
    readonly roots?: RecipeRoot[];
}

/** What an include resolved to. */
export interface IncludeResolution {
    /** The files included, in order (a glob's in the order of `compareIncludeOrder`). */
    readonly files: string[];
    /** Every path tried, for the error. */
    readonly candidates: string[];
    readonly glob: boolean;
    /** True when the include named a `#` view. */
    readonly view: boolean;
    /** What went wrong with a `~` reference. */
    readonly namespaceProblem?: { reference: string; fromFile: string; resolution: NamespaceResolution };
    /** What went wrong with a `#` name. */
    readonly hashProblem?: string;
}

/** Include resolution: include lines and `{% render %}` paths, `@`, `~` and `#`. */
export interface CompilerIncludes {
    /**
     * Whether a line, alone, is an include Sous tries: one of Sous's own forms, or a plain path
     * Claude Code's rule accepts. Whether the file exists is not checked.
     */
    isIncludeLine(line: string): boolean;
    /** Resolves an include path. */
    resolve(path: string, context: IncludeContext): IncludeResolution;
    /** Describes a failed `~` include for an error (`formatNamespaceProblem`). */
    describeNamespaceProblem(problem: NonNullable<IncludeResolution["namespaceProblem"]>): string;
}

/** Aliases: the built-in ones and `_aliases`, each resolved to base directories. */
export interface CompilerAliases {
    /** Every alias, each to its base directories in the order tried. */
    all(): Record<string, string[]>;
    /** One alias's directories, or `undefined`. */
    get(name: string): string[] | undefined;
    /** Splits `docs/x.md` or `docs:x.md` into an alias and the rest, when it starts with one. */
    split(path: string): { alias: string; rest: string } | undefined;
}

// ---------------------------------------------------------------------------------------------
// compiler.state and compiler.writer
// ---------------------------------------------------------------------------------------------

/** One file the compiler wrote. */
export interface StateFileEntry {
    /** Absolute in memory; on disk, relative to the project root when inside it. */
    dest: string;
    /** The source's hash (sha256 hex). */
    srcHash: string;
    /** The written content's hash. */
    destHash: string;
    size: number;
    builtAt: string;
    /** The target it came from (its id or index). */
    target?: string;
    /** Who the target came from. */
    origin?: CompilationOrigin;
}

/** The state file: every file sous wrote, and which recipe it came from. */
export interface StateFile {
    /**
     * The project the state was written for. On disk, paths inside it are written relative to it;
     * in memory every path is absolute. Missing from older state files, whose paths are all absolute.
     */
    projectRoot?: string;
    lastBuild: string;
    resolvedVars: Record<string, string>;
    /** Directories the compiler created, so pruning can remove them when empty. */
    dirs: string[];
    files: StateFileEntry[];
}

/** Which entries to select. */
export interface StateFilter {
    repository?: string;
    recipe?: string;
    plugin?: string;
    target?: string;
}

/** The state file. Only the compiler writes it. */
export interface CompilerState {
    /** Where it is. */
    path(): string;
    /** What it holds; an empty state when there is none. */
    read(): StateFile;
    /** Every entry. */
    entries(): StateFileEntry[];
    /** The files that came from a repository, recipe, plugin or target (what removing a repository deletes). */
    filesFrom(filter: StateFilter): StateFileEntry[];
    /** Whether the compiler wrote a file. */
    isTracked(file: string): boolean;
}

/** What writing one output did. */
export type WriteAction = "created" | "updated" | "unchanged" | "skipped-untracked" | "would-create" | "would-update";

/** One output written, or not. */
export interface WrittenFile {
    readonly file: string;
    readonly action: WriteAction;
    readonly bytes: number;
    readonly target?: string;
    readonly origin?: CompilationOrigin;
    /**
     * Where the file's previous content was copied before it was overwritten (or, on a dry run,
     * would be): set only when that content was not sous's own, because sous did not write the
     * file or it was edited by hand since.
     */
    readonly backup?: string;
}

/** One file copied to a backup before it was overwritten or removed. */
export interface BackedUpFile {
    /** The file. */
    readonly file: string;
    /** Its backup: `<sousDir>/backups/<YYYY-MM-DD>/<HHMM-SS>/<path relative to the project root>`. */
    readonly backup: string;
}

/** How to write one output. */
export interface WriteOptions {
    /** The source file or target id the content came from. */
    source: string;
    /** The hash of the source, recorded in the state file. */
    sourceHash?: string;
    /** The target it came from. A write with no target and an `origin.plugin` is that plugin's own file: prune leaves it, clear removes it. */
    target?: string;
    origin?: CompilationOrigin;
    /** Writes nothing. */
    dryRun?: boolean;
    /** Writes even when the content is unchanged. */
    force?: boolean;
    /**
     * The file mode to give it: an untemplated source's own, or, for a template whose source is
     * executable, the source's. Default: `0o755` for `.sh`, otherwise left as it is.
     */
    mode?: number;
    /** Which run the write belongs to (the chain's id): every backup of one run goes in one timestamp folder. */
    run?: number;
    /** Overrides `compilation.overwriteUntracked` for this write: `true` backs up and overwrites a file sous did not write. */
    overwriteUntracked?: boolean;
}

/** How to remove files. */
export interface RemoveOptions {
    /** Removes nothing. */
    dryRun?: boolean;
    /** Which run the removal belongs to (the chain's id): every backup of one run goes in one timestamp folder. */
    run?: number;
}

/** What removing files did. */
export interface RemovedFiles {
    removed: string[];
    dirsRemoved: string[];
    /** The files backed up before they were removed (or, on a dry run, that would be); missing when none. */
    backedUp?: BackedUpFile[];
}

/**
 * Writing outputs: overwrites and takes ownership, unless
 * `compilation.overwriteUntracked` is `false`. Every write is recorded in the state file.
 * The one way any plugin writes a build output (the runtime context file included). Before it
 * overwrites or removes a file whose content sous did not produce (a file it did not write, or an
 * output edited by hand since it wrote it), it copies the file to `<sousDir>/backups/`.
 */
export interface CompilerWriter {
    /** Writes text as UTF-8, and bytes as they are (a binary file copied unchanged). */
    write(file: string, content: string | Uint8Array, options: WriteOptions): Promise<WrittenFile>;
    /** Removes files the compiler wrote, and directories it created that are left empty. */
    remove(files: readonly string[], options?: RemoveOptions): Promise<RemovedFiles>;
    /** Saves the state file after a run. */
    commit(options?: { dryRun?: boolean; resolvedVars?: VarScope }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// The compiler.compile and compiler.prune intents, and their events
// ---------------------------------------------------------------------------------------------

/** One problem a compile found. */
export interface CompileProblem {
    readonly level: "error" | "warning";
    readonly message: string;
    readonly target?: string;
    readonly file?: string;
    readonly line?: number;
}

/** One output compiled. */
export interface CompiledOutput extends WrittenFile {
    readonly source: string;
    /** Its size in tokens (`o200k_base`), when counted. */
    readonly tokens?: number;
}

/** The input of `compiler.compile` (internal). */
export interface CompileInput {
    /** Only these targets, by id or index. Default: every target. */
    targets?: ReadonlyArray<string | number>;
    /** Only the targets whose sources include one of these files (watch mode's partial rebuild). */
    changedFiles?: readonly string[];
    /** Warnings fail the compile. */
    strict?: boolean;
    /** Writes every output even when unchanged. */
    rebuild?: boolean;
    dryRun?: boolean;
    /**
     * Ends the report with `Done.` (`true` unless `false`). A caller that reports more steps after
     * the compile (the build's prune) passes `false` and ends the report itself.
     */
    reportEnd?: boolean;
}

/** The result of `compiler.compile`. Errors are listed, never thrown, so every target compiles. */
export interface CompileResult {
    readonly ok: boolean;
    readonly outputs: CompiledOutput[];
    readonly problems: CompileProblem[];
    /** Every file the compile read, as real paths: sources and everything they include. */
    readonly included?: string[];
    readonly durationMs: number;
}

/** The input of `compiler.prune` (internal). */
export interface CompilerPruneInput {
    /** Removes every file the compiler wrote, not only those no target produces (`clear`). */
    all?: boolean;
    dryRun?: boolean;
    /** Reports each removed file as progress (`true` unless `false`); a caller that returns the files as its own result passes `false`. */
    report?: boolean;
}

/** The result of `compiler.prune`. */
export interface CompilerPruneResult {
    readonly removed: string[];
    readonly dirsRemoved: string[];
    /** The files backed up before they were removed, because they were edited by hand; missing when none. */
    readonly backedUp?: BackedUpFile[];
    readonly dryRun: boolean;
}

/** The payload of `compiler.wrote`. */
export interface CompilerWrotePayload {
    readonly files: readonly WrittenFile[];
    readonly dryRun: boolean;
}

/** The payload of `compiler.pruned`. */
export interface CompilerPrunedPayload {
    readonly removed: readonly string[];
    readonly dryRun: boolean;
}

declare module "@sous-io/sous-plugin-api" {
    interface SousServices {
        /** Include resolution. */
        "compiler.includes": CompilerIncludes;
        /** Aliases. */
        "compiler.aliases": CompilerAliases;
        /** The state file. */
        "compiler.state": CompilerState;
        /** Writing outputs. */
        "compiler.writer": CompilerWriter;
        /** The `~` sigil's resolver; registered by sous-plugin-recipes. */
        "compiler.namespace-resolver": NamespaceResolver;
    }

    interface SousIntents {
        /** Compiles every target's templates into outputs (internal). */
        "compiler.compile": { input: CompileInput; result: CompileResult };
        /** Removes outputs no target produces any more (internal). */
        "compiler.prune": { input: CompilerPruneInput; result: CompilerPruneResult };
    }

    interface SousEvents {
        /** What a compile wrote. */
        "compiler.wrote": CompilerWrotePayload;
        /** What a prune removed. */
        "compiler.pruned": CompilerPrunedPayload;
    }

    interface SousEntities {
        /** A change to an output before it is written. */
        "compilation-transform": CompilationTransformEntity;
    }

    interface SousConfig {
        compilation: CompilationSettings;
        _aliases: AliasesSettings;
    }
}
