/**
 * The contract of plugin-formats: one parser per on-disk format,
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
}

/** The lockfile: every pinned recipe and the repositories they come from. */
export interface Lockfile {
    formatVersion: FormatVersion;
    repos: Record<string, LockedRepo>;
    recipes: Record<string, LockedRecipe>;
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

/** A kind of content a recipe publishes. Plugins may read kinds of their own. */
export type ContentKind = "skills" | "memories" | "prompts" | "config" | (string & {});

/** One block of content a recipe publishes. */
export interface RecipeContent extends Extensions {
    kind: ContentKind;
    /** Glob patterns, relative to the recipe. */
    include: string[];
    exclude?: string[];
}

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
    /** Default `[]`. */
    contents: RecipeContent[];
    variables?: VariableDefinition[];
    plugin?: RecipePluginEntry;
    requires?: RecipeRequirements;
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

declare module "@sous-io/plugin-api" {
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
