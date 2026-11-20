/**
 * The contract of sous-plugin-formats: one parser per on-disk format,
 * reading a manifest file from disk, and the recipe content hash. Parsing is pure: it never works
 * out a repository identity or reads another file.
 *
 * Other plugins import this file type-only.
 */

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** The only format version sous reads and writes. */
export type FormatVersion = 1;

/** A content hash: `sha256-` and 64 lowercase hexadecimal characters. */
export type ContentHash = `sha256-${string}`;

/** How one recipe brings in another: `subscribes` (the project subscribes to it too) or `depends`. */
export type DependencyKind = "subscribes" | "depends";

/** Keys starting `x-`, which every extensible format keeps and ignores (forward compatibility). */
export type Extensions = { [key: `x-${string}`]: unknown };

/** Whether a repository or recipe accepts proposed changes, and where to send them instead. */
export interface Submissions {
    /** Default `true`. */
    allowed: boolean;
    /** Where to propose changes instead, when not allowed here. */
    instead?: string;
}

/**
 * One format: parse and check a value read from disk, and write it back in its one stable form
 * ("The robustness principle": many forms read, one written).
 */
export interface FormatParser<T> {
    /** The format's name in messages: `lockfile`, `recipe manifest`. */
    readonly label: string;
    /** The file name it lives in, when it has a fixed one (`sous.lock.json`). */
    readonly fileName?: string;
    /** Checks a parsed value; throws a `ConfigError` naming `sourceLabel` and every problem. */
    parse(value: unknown, sourceLabel: string): T;
    /** The same, returning the problems instead of throwing. */
    check(value: unknown, sourceLabel: string): { value: T; issues?: undefined } | { value?: undefined; issues: string[] };
}

/** A format sous also writes: stable JSON with sorted keys and a trailing newline. */
export interface WritableFormatParser<T> extends FormatParser<T> {
    stringify(value: T): string;
    /** An empty file of this format. */
    empty(): T;
}

// ---------------------------------------------------------------------------------------------
// The lockfile (`sous.lock.json`)
// ---------------------------------------------------------------------------------------------

/** The holder name a subscription of the project itself is recorded under in `requestedBy`. */
export type ProjectHolder = "project";

/** One repository the lockfile describes, keyed by the project's short name for it. */
export interface LockedRepo {
    url: string;
    /** Its canonical identity; filled in by `recipes.lock` when an older file lacks it, never by the parser. */
    identity?: string;
    /** The hash of the index the pins were resolved against. */
    indexHash?: ContentHash;
}

/** One pinned recipe, keyed by `namespace/recipe`. */
export interface LockedRecipe {
    /** The short name of its repository, a key of `repos`. */
    repo: string;
    version: string;
    hash: ContentHash;
    /** Who asked for it: `project`, or the keys of the recipes that depend on it. */
    requestedBy: string[];
    kind: DependencyKind;
    /**
     * Versions pinned for one holder alone, keyed by the holder's recipe key (ADR 0023, decision 4):
     * a holder whose range does not allow `version`, of a recipe it reaches only through `depends`.
     * Every key is also in `requestedBy`. Absent when every holder uses `version`.
     */
    pins?: Record<string, LockedPin>;
}

/** A version of a recipe pinned for one holder alone. */
export interface LockedPin {
    version: string;
    hash: ContentHash;
}

/** The lockfile: every pinned recipe and the repositories they come from. */
export interface Lockfile {
    formatVersion: FormatVersion;
    repos: Record<string, LockedRepo>;
    recipes: Record<string, LockedRecipe>;
    /** The version of sous whose migrations the project last ran; every later migration is pending. */
    migratedVersion?: string;
}

// ---------------------------------------------------------------------------------------------
// Variable definitions (in recipe manifests and the index)
// ---------------------------------------------------------------------------------------------

/** The type of a recipe variable. */
export type VariableType = "string" | "number" | "boolean" | "enum" | "path" | "url";

/** Where an answer is stored: `shared` in `.sous/.env`, `local` in the gitignored `.sous/.env.local`. */
export type VariableScope = "shared" | "local";

/** A scalar a definition may give as a default or an example. */
export type VariableScalar = string | number | boolean;

/** How an answer is checked. */
export interface VariableValidation extends Extensions {
    /** A regular expression, run with a time limit. */
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    /** The options of an `enum`. */
    enum?: string[];
}

/** A variable a recipe declares. */
export interface VariableDefinition extends Extensions {
    /** camelCase. */
    name: string;
    /** The environment variable that answers it, when the recipe names one. */
    env?: string;
    type: VariableType;
    /** The question. */
    prompt: string;
    /** A sentence or two shown above the question. */
    description: string;
    /** What a real answer looks like; documentation only. */
    example: VariableScalar;
    default?: VariableScalar;
    /** Default `true`. */
    required: boolean;
    /** Default `false`; a secret's scope must be `local`. */
    secret: boolean;
    /** Default `shared`. */
    scope: VariableScope;
    validate?: VariableValidation;
}

// ---------------------------------------------------------------------------------------------
// The recipe manifest (`sous.recipe.yaml`)
// ---------------------------------------------------------------------------------------------

/** A kind of content a recipe publishes. A plugin adds a kind with a `content-kind` entity. */
export type ContentKind = "skills" | "memories" | "prompts" | "config" | (string & {});

/**
 * An object holding a config expression key (`$if`, `$elseif`, `$else`, `$expr`, each optionally
 * qualified) or `$file`. In a manifest it is evaluated when a subscriber's config is built
 * (specification S12), so the manifest itself holds it as written.
 */
export type ManifestExpression = { readonly [key: `$${string}`]: unknown };

/** A value as a manifest may write it: the value itself, or an expression that gives it. */
export type Expressible<T> = T | ManifestExpression;

/** Content written in place of a file; `path` is the path it is treated as having. */
export interface InlineContent {
    $inline: string;
    path: string;
}

/** One block of content a recipe publishes, after its expressions are evaluated. */
export interface RecipeContentGroup extends Extensions {
    kind: ContentKind;
    /** Glob patterns relative to the recipe, or inline content. */
    include: Array<string | InlineContent>;
    exclude?: string[];
}

/** One block of content as a manifest writes it: any value may be an expression. */
export interface RecipeContent extends Extensions {
    kind: Expressible<ContentKind>;
    /** Glob patterns relative to the recipe, inline content, or expressions giving either. */
    include: Array<Expressible<string | InlineContent>>;
    exclude?: Expressible<Array<Expressible<string>>>;
}

/**
 * One declared edit to a document file, as a manifest writes it (spec of the editor): `file` and
 * one or more operation keys, or a file-less operation. The editor plugin checks the operations.
 */
export type RecipeEdit = Readonly<Record<string, unknown>>;

/** The plugin a recipe ships: one bundled file, and optionally its types. */
export interface RecipePluginEntry {
    /** The bundle, relative to the recipe: `plugin/index.js`. */
    bundle: string;
    /** Its `.d.ts`, copied to `.sous/types/`. */
    types?: string;
}

/** What a recipe needs that is not a recipe. */
export interface RecipeRequirements {
    /** npm plugins, each with a version range. */
    plugins?: Record<string, string>;
}

/** A recipe's manifest. */
export interface RecipeManifest extends Extensions {
    formatVersion: FormatVersion;
    namespace: string;
    name: string;
    version: string;
    description?: string;
    submissions?: Submissions;
    /** Refs of recipes it uses (manifest form). */
    depends?: string[];
    /** Refs of recipes the project also subscribes to. */
    subscribes?: string[];
    /** Default `[]`. A group may itself be an expression. */
    contents: Array<Expressible<RecipeContent>>;
    variables?: VariableDefinition[];
    plugin?: RecipePluginEntry;
    requires?: RecipeRequirements;
    /** Each purpose's handlers, run in the order listed. */
    handlers?: RecipeHandlers;
    /** Declared edits to document files; each entry may be an expression. */
    edits?: Array<Expressible<RecipeEdit>>;
}

/** One handler a recipe lists: a file in the recipe and the function it exports. */
export interface RecipeHandlerEntry extends Extensions {
    /** Relative to the recipe: `handlers/prerequisites.js`. */
    file: string;
    /** The exported function: `checkCommands`. */
    handler: string;
}

/** A recipe manifest's `handlers` block: each purpose's handlers, in run order. */
export interface RecipeHandlers extends Extensions {
    check?: RecipeHandlerEntry[];
    configure?: RecipeHandlerEntry[];
    beforeBuild?: RecipeHandlerEntry[];
    afterBuild?: RecipeHandlerEntry[];
    uninstall?: RecipeHandlerEntry[];
    migrate?: RecipeHandlerEntry[];
}

// ---------------------------------------------------------------------------------------------
// The repository manifest (`sous.repo.yaml`)
// ---------------------------------------------------------------------------------------------

/** A namespace a repository publishes. */
export interface RepoNamespace extends Extensions {
    description?: string;
}

/** A recipe repository's manifest. */
export interface RepoManifest extends Extensions {
    formatVersion: FormatVersion;
    name: string;
    description?: string;
    /** Where to read how to contribute. */
    contribute?: string;
    submissions?: Submissions;
    namespaces: Record<string, RepoNamespace>;
    /** Each recipe's directory, relative to the repository root. */
    recipes: string[];
    /**
     * The recipes this repository published once and retired, keyed `namespace/recipe`. A recipe
     * no longer listed under `recipes` is retired whether or not it has an entry here; an entry
     * only adds what the release records about it.
     */
    retired?: Record<string, RepoRetirement>;
}

/** What a repository manifest says about one recipe it retired. */
export interface RepoRetirement extends Extensions {
    /**
     * The recipes subscribers are offered in its place, each a recipe ref as `depends` takes one:
     * `acme/gadget` in this repository, or a locator naming a recipe in another one. Zero or more.
     */
    replacements?: string[];
}

// ---------------------------------------------------------------------------------------------
// The index (`sous.index.json`)
// ---------------------------------------------------------------------------------------------

/** One dependency a published version recorded. */
export interface IndexDependency {
    /** The exact version it resolved to at release. */
    version?: string;
    /** The range the recipe declared. */
    range?: string;
    /** The identity of another repository it lives in. */
    repo?: string;
    /** The ref exactly as the manifest wrote it. */
    declared?: string;
    kind?: DependencyKind;
}

/** One published version of a recipe. */
export interface IndexVersion {
    hash: ContentHash;
    /** `namespace/recipe@version`. */
    tag: string;
    prerelease: boolean;
    seeded?: boolean;
    releasedAt?: string;
    dependencies?: Record<string, IndexDependency>;
    variables?: VariableDefinition[];
    depends?: string[];
    subscribes?: string[];
    /** Unknown keys of a newer format are kept. */
    [key: string]: unknown;
}

/** One recipe an index lists. */
export interface IndexRecipe {
    path: string;
    description?: string;
    /** At least one, keyed by version. */
    versions: Record<string, IndexVersion>;
    [key: string]: unknown;
}

/** One replacement an index suggests for a retired recipe. */
export interface IndexReplacement {
    /** `namespace/recipe`. */
    key: string;
    /** The identity of another repository it lives in; absent for this same repository. */
    repo?: string;
    /** The entry exactly as `sous.repo.yaml` wrote it. */
    declared: string;
    [key: string]: unknown;
}

/** One recipe an index keeps as retired: every version it published, and what replaces it. */
export interface IndexRetiredRecipe {
    path: string;
    description?: string;
    /** In the order `sous.repo.yaml` lists them; absent or empty when there are none. */
    replacements?: IndexReplacement[];
    /** At least one, keyed by version. */
    versions: Record<string, IndexVersion>;
    [key: string]: unknown;
}

/** One namespace an index lists. */
export interface IndexNamespace {
    description?: string;
    [key: string]: unknown;
}

/** A repository's index: every recipe and version it publishes. */
export interface IndexFile {
    $comment?: string;
    formatVersion: FormatVersion;
    name: string;
    generatedAt: string;
    /** The sous version that wrote it. */
    generator: string;
    namespaces: Record<string, IndexNamespace>;
    recipes: Record<string, IndexRecipe>;
    /** Recipes it published once and no longer does; never a key `recipes` also holds. */
    retired?: Record<string, IndexRetiredRecipe>;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// The links map (`sous.links.json`) and the store entry (`.sous.entry.json`)
// ---------------------------------------------------------------------------------------------

/** How a link was made: a checkout sous cloned, or a path the user named. */
export type LinkOrigin = "clone" | "path";

/** One linked repository. */
export interface RepoLink {
    /** Absolute. */
    path: string;
    linkedAt: string;
    origin: LinkOrigin;
}

/** A links map, project or machine-wide, keyed by repository short name. */
export interface LinksMap {
    formatVersion: FormatVersion;
    links: Record<string, RepoLink>;
}

/** The marker of one recipe version in the store. */
export interface StoreEntry {
    formatVersion: FormatVersion;
    /** The repository identity. */
    repo: string;
    namespace: string;
    name: string;
    version: string;
    hash: ContentHash;
    fetchedAt: string;
    lastAccessAt: string;
    sizeBytes: number;
    /** A digest of every file's name, size and modification time when the hash last matched. */
    statFingerprint?: string;
}

// ---------------------------------------------------------------------------------------------
// formats.manifests and formats.recipe-hash
// ---------------------------------------------------------------------------------------------

/** Which manifest to look for. */
export type ManifestKind = "recipe" | "repo";

/** A manifest found on disk. */
export interface FoundManifest<T> {
    /** The file it was read from (`sous.recipe.yaml`, `.yml`, `.json` or `.jsonc`). */
    readonly path: string;
    readonly manifest: T;
}

/** Reading files in the formats sous reads, from disk. */
export interface FormatsManifests {
    /** The manifest file in a directory, or `undefined`. */
    find(directory: string, kind: ManifestKind): string | undefined;
    /** Reads and checks the recipe manifest in a directory; `undefined` when there is none. */
    readRecipe(directory: string): Promise<FoundManifest<RecipeManifest> | undefined>;
    /** Reads and checks the repository manifest at a repository root; `undefined` when there is none. */
    readRepo(directory: string): Promise<FoundManifest<RepoManifest> | undefined>;
    /** The same as `readRecipe`, throwing a `NotFoundError` when there is none. */
    requireRecipe(directory: string): Promise<FoundManifest<RecipeManifest>>;
    /** The same as `readRepo`, throwing a `NotFoundError` when there is none. */
    requireRepo(directory: string): Promise<FoundManifest<RepoManifest>>;
    /** Parses YAML, JSON or JSONC text by the file's extension, unchecked. */
    parseText(text: string, fileName: string): unknown;
    /** Reads and parses a YAML, JSON or JSONC file, unchecked. */
    readFile(path: string): Promise<unknown>;
}

/** The content hash a release writes and the store checks. */
export interface FormatsRecipeHash {
    /** The hash of a recipe directory's files, names and contents, in bytewise order. */
    hashDirectory(directory: string): Promise<ContentHash>;
    /** The same, blocking. */
    hashDirectorySync(directory: string): ContentHash;
    /** Whether two hashes are equal, ignoring case. */
    equal(left: string, right: string): boolean;
    /** Whether text is a well-formed content hash. */
    isHash(text: string): text is ContentHash;
}

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

declare module "@sous-io/sous-plugin-api" {
    interface SousServices {
        /** `sous.lock.json`. */
        "formats.lockfile": WritableFormatParser<Lockfile>;
        /** `sous.recipe.yaml`. */
        "formats.recipe-manifest": FormatParser<RecipeManifest>;
        /** `sous.repo.yaml`. */
        "formats.repo-manifest": FormatParser<RepoManifest>;
        /** `sous.index.json`. */
        "formats.index-file": WritableFormatParser<IndexFile>;
        /** `sous.links.json`. */
        "formats.links-map": WritableFormatParser<LinksMap>;
        /** `.sous.entry.json`. */
        "formats.store-entry": WritableFormatParser<StoreEntry>;
        /** One variable definition, as a manifest or an index holds it. */
        "formats.variable-definition": FormatParser<VariableDefinition>;
        /** Reading manifest files from disk. */
        "formats.manifests": FormatsManifests;
        /** The recipe content hash. */
        "formats.recipe-hash": FormatsRecipeHash;
    }
}
