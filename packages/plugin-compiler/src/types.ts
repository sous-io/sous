/**
 * The contract of plugin-compiler: compiling every compilation
 * target in the config into outputs, include resolution (`@`, `~`, `#`), aliases, the compilation
 * settings, the built-in tags and filter, the state file, writing every build output, and pruning.
 *
 * Among the built-in plugins only the compiler writes build outputs; others add
 * compilation targets to the config. It compiles whatever targets the config holds, with a
 * scope and a namespace resolver, so it depends on no recipe plugin.
 *
 * Other plugins import this file type-only.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type { VarScope } from "@sous-io/plugin-variables/types";

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
    /** Writes only when every named variable equals the value. */
    _if?: Record<string, { eq: string }>;
    /** Variables of this output's scope. */
    _vars?: Record<string, string>;
    /** Where a single output goes. One of `destinationFile` and `destinationDir`. */
    destinationFile?: string;
    /** Where a glob target's files go, mirroring their paths under the glob's base. */
    destinationDir?: string;
    /** `compilation-transform` ids applied to this output, after the target's own. */
    transforms?: string[];
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
    /** Asks plugin-build to write the runtime context file before this target compiles. */
    generateRuntimeContext?: boolean;
    /** `compilation-transform` ids applied to every output. */
    transforms?: string[];
    /** Who added it. */
    origin?: CompilationOrigin;
    outputs: CompilationOutput[];
}

/** The `compilation` config key, with its defaults filled in. */
export interface CompilationSettings {
    /** Variables of the compilation scope. */
    _vars?: Record<string, string>;
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
// compiler.namespace-resolver (implemented by plugin-recipes)
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

/** The resolver the `~` sigil uses: declared here, registered by plugin-recipes. */
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
    /** The files included, in order (a glob's in bytewise order). */
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
    /** Whether a line is a well-formed include line. */
    isIncludeLine(line: string): boolean;
    /** Whether a line looks like an include but is not well formed (a compile error). */
    looksLikeIncludeLine(line: string): boolean;
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
    /** Absolute. */
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
    /** The file mode to give it (a copied source's own). Default: `0o755` for `.sh`, otherwise left as it is. */
    mode?: number;
}

/**
 * Writing outputs: overwrites and takes ownership, unless
 * `compilation.overwriteUntracked` is `false`. Every write is recorded in the state file.
 * The one way any plugin writes a build output (the runtime context file included).
 */
export interface CompilerWriter {
    write(file: string, content: string, options: WriteOptions): Promise<WrittenFile>;
    /** Removes files the compiler wrote, and directories it created that are left empty. */
    remove(files: readonly string[], options?: { dryRun?: boolean }): Promise<{ removed: string[]; dirsRemoved: string[] }>;
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
    /** The column on `line`, from 1, when known (a Liquid error says where it is). */
    readonly column?: number;
}

/** One output compiled. */
export interface CompiledOutput extends WrittenFile {
    readonly source: string;
    /**
     * Its size in tokens (`o200k_base`), when counted: always for a created or updated output, and
     * for every output, dry run and unchanged included, under `countTokens`.
     */
    readonly tokens?: number;
    /** The text built for it (what is, or would be, written), under `includeContent`. */
    readonly content?: string;
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
    /** Puts each output's built text in `content`, dry run and unchanged outputs included. Default `false`. */
    includeContent?: boolean;
    /** Counts every output's tokens, dry run and unchanged outputs included. Default `false`: only written outputs are counted. */
    countTokens?: boolean;
    /** Reports progress and problems as it compiles (`true` unless `false`); a caller that shows the result itself passes `false`. */
    report?: boolean;
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
    readonly dryRun: boolean;
}

/** The input of `compiler.tokens`. */
export interface CompilerTokensInput {
    /** Only these targets, by id or index. Default: every target. */
    targets?: string[];
}

/** One output's size, as `compiler.tokens` gives it. */
export interface OutputSize {
    /** The output, absolute. */
    readonly file: string;
    readonly target?: string;
    readonly tokens: number;
    readonly bytes: number;
}

/** The result of `compiler.tokens`: what an agent reads, output by output. */
export interface CompilerTokensResult {
    readonly outputs: OutputSize[];
    readonly totalTokens: number;
    readonly totalBytes: number;
    readonly problems: CompileProblem[];
}

// ---------------------------------------------------------------------------------------------
// compiler.targets and compiler.render
// ---------------------------------------------------------------------------------------------

/** One output of one source of a target, as the build resolves it. */
export interface CompilationEntry {
    /** The target's id, or its index as text. */
    readonly target: string;
    /** The target's index in `compilation.targets`. */
    readonly targetIndex: number;
    /** The source file, absolute; for a `content` target, a path named after its id under the project root. */
    readonly source: string;
    /** The template text of a `content` target; `undefined` for a source on disk. */
    readonly content?: string;
    /** The file it writes, absolute (before any transform changes it). */
    readonly output: string;
    /** The output's index in the target's `outputs`. */
    readonly outputIndex: number;
    /** The `compilation-transform` ids applied, the target's then the output's. */
    readonly transforms: readonly string[];
    /** Who added the target. */
    readonly origin?: CompilationOrigin;
}

/** Every entry, and what went wrong expanding the targets. */
export interface CompilationEntries {
    readonly entries: CompilationEntry[];
    readonly problems: CompileProblem[];
}

/**
 * The config's targets expanded as the build expands them: globs matched, `${var}` substituted,
 * `_if` applied, one entry per output. Reads the disk only to match globs.
 */
export interface CompilerTargets {
    /** Every entry; `targets` keeps only those targets, by id or index. */
    expand(options?: { targets?: ReadonlyArray<string | number> }): CompilationEntries;
}

/** What `compiler.render` renders. */
export interface TemplateRenderRequest {
    /** The source file, absolute. Need not belong to a target, nor exist when `source` is given. */
    file: string;
    /** The text to render instead of the file's (an unsaved edit). Rendered exactly as given. */
    source?: string;
    /** Values layered over the real scope ("try another value"). */
    scope?: Record<string, unknown>;
    /** Whose scope to use, by id or index, when several targets read the file. Default: the first that does. */
    target?: string | number;
    /** Which of that target's outputs, by its index in `outputs`. Default: the first. */
    output?: number;
}

/** What `compiler.render` rendered. */
export interface TemplateRenderResult {
    /** The text the build would produce for the file (before transforms), includes expanded. */
    readonly text: string;
    /** Errors and warnings, with the line and column when known. */
    readonly problems: CompileProblem[];
    /** The target whose scope was used, when one reads the file. */
    readonly target?: string;
    /** The output whose scope was used. */
    readonly outputIndex?: number;
    /** Every file the render read beside `file` (its includes), absolute. */
    readonly included: string[];
}

/** Renders one template as the build would, writing nothing. */
export interface CompilerRender {
    render(request: TemplateRenderRequest): Promise<TemplateRenderResult>;
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

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Include resolution. */
        "compiler.includes": CompilerIncludes;
        /** Aliases. */
        "compiler.aliases": CompilerAliases;
        /** The state file. */
        "compiler.state": CompilerState;
        /** Writing outputs. */
        "compiler.writer": CompilerWriter;
        /** The targets expanded into concrete sources and outputs. */
        "compiler.targets": CompilerTargets;
        /** Rendering one template as the build would. */
        "compiler.render": CompilerRender;
        /** The `~` sigil's resolver; registered by plugin-recipes. */
        "compiler.namespace-resolver": NamespaceResolver;
    }

    interface SousIntents {
        /** Compiles every target's templates into outputs (internal). */
        "compiler.compile": { input: CompileInput; result: CompileResult };
        /** Removes outputs no target produces any more (internal). */
        "compiler.prune": { input: CompilerPruneInput; result: CompilerPruneResult };
        /** Every output's size in tokens and bytes, from a dry run: what an agent reads. */
        "compiler.tokens": { input: CompilerTokensInput; result: CompilerTokensResult };
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
