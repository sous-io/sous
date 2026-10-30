/**
 * The contract of plugin-refs: parsing a written ref into every
 * reading it could have, deciding which readings count where it was written, settling which match a
 * run proceeds with, `#` names, and repository locations and identity.
 *
 * Refs are plain data, never class instances, so they survive a JSON round trip. Other plugins
 * import this file type-only.
 */

import type { Prompter, Reporter, ServiceContext } from "@sous-io/plugin-api";

// ---------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------

/** Where a ref says a repository lives. */
export interface RefLocation {
    /** The id of the `repository-host` entity that reads the location (`github`, `gitlab`, `local`). */
    provider: string;
    /** The host, such as `github.com`. */
    host: string;
    /** The repository's path on the host, such as `sous-io/sous-recipes`. */
    repoPath: string;
    /** The repository's canonical identity, as the store and the lockfile key it. */
    identity: string;
    /** The repository's HTTPS URL, which is what adding it is handed. */
    url: string;
}

/** What every ref may carry. */
export interface RefBase {
    /** True when any name or path part of the ref (a parent's included) is a glob pattern. */
    glob?: true;
    /** The `?name=value` pairs the ref was written with, percent-decoded. */
    vars?: Record<string, string>;
    /** What the publisher says the thing is, in one line; filled in by a lookup, never parsed. */
    description?: string;
}

/** A repository: by the project's short name for it, by where it lives, or both. */
export interface RepoRef extends RefBase {
    kind: "repo";
    /** The project's short name for the repository (may be a glob). */
    name?: string;
    /** Where the repository lives, when the ref said so. */
    location?: RefLocation;
    /** A branch or tag, once a lookup has told it apart from the path after it. */
    revision?: string;
    /** A folder or file path copied from a host's file view, branch still in front of it. */
    browsed?: string;
    /** The version range a browsed path was written with. */
    range?: string;
}

/** A namespace published by a repository. */
export interface NamespaceRef extends RefBase {
    kind: "namespace";
    /** The namespace name (may be a glob). */
    name: string;
    /** The repository qualifier, when one was written. */
    repo?: RepoRef;
    /** True when the namespace was spelled out as `namespace/*`. */
    wildcard?: true;
}

/** A recipe published in a namespace. */
export interface RecipeRef extends RefBase {
    kind: "recipe";
    /** The recipe name (may be a glob). */
    name: string;
    /** The namespace, when the ref named it. */
    namespace?: NamespaceRef;
    /** The repository qualifier, set here only when there is no namespace to hold it. */
    repo?: RepoRef;
    /** The semantic version range, when one was given. */
    range?: string;
}

/** A file inside a recipe. */
export interface RecipeFileRef extends RefBase {
    kind: "recipeFile";
    /** The path inside the recipe, `/`-separated (may be a glob). */
    path: string;
    /** The recipe holding it. */
    recipe: RecipeRef;
    /** The semantic version range, when one was given. */
    range?: string;
}

/** A variable a recipe declares, written `namespace/recipe.variableName`. */
export interface VariableRef extends RefBase {
    kind: "variable";
    /** The variable's own name, as its author wrote it (may be a glob). */
    name: string;
    /** The recipe declaring it, when the ref named it. */
    recipe?: RecipeRef;
    /** The repository qualifier, set here only when there is no recipe to hold it. */
    repo?: RepoRef;
}

/** An environment variable name, held whole. */
export interface EnvVarRef extends RefBase {
    kind: "envVar";
    /** The name, exactly as written. */
    name: string;
    /** The variables this name answers, once a lookup has said. */
    variables?: VariableRef[];
}

/** Anything a written ref can name. */
export type SousRef = RepoRef | NamespaceRef | RecipeRef | RecipeFileRef | VariableRef | EnvVarRef;

/** One kind of ref. */
export type RefKind = SousRef["kind"];

/** A namespace or a recipe: what a subscription key names. */
export type NamedRef = NamespaceRef | RecipeRef;

/**
 * Where a ref was written, which decides the forms allowed there. Plugins may add places of their
 * own, with a `ref-pruner` entity for each.
 */
export type RefSource = "commandLine" | "config" | "manifest" | "lockfile" | "include" | (string & {});

// ---------------------------------------------------------------------------------------------
// Parsing: the ref-splitter entity
// ---------------------------------------------------------------------------------------------

/** A reading in progress; finished when `ref` is set and `rest` is empty. */
export interface PartialRef {
    /** The whole input, trimmed. Never changes. */
    input: string;
    /** The text no splitter has read yet. */
    rest: string;
    /** The `?name=value` pairs read so far. */
    vars?: Record<string, string>;
    /** The version range read so far. */
    range?: string;
    /** The repository qualifier read so far. */
    repo?: RepoRef;
    /** The finished ref, once a splitter has made one. */
    ref?: SousRef;
    /** Why a splitter turned the text down, shared by every reading of one input. */
    problems: string[];
}

/**
 * A `ref-splitter` entity: one step of the parser. It reads what it recognizes of `rest` and
 * returns every way to read it; one that recognizes nothing returns the state unchanged.
 */
export interface RefSplitterEntity {
    id: string;
    /** Where it runs among the others: lowest first. Built-ins: query 10, range 20, location 30, qualifier 40, env var 50, name/path 60. */
    order: number;
    /**
     * Advances one reading. A finished reading must be returned as it is. `ctx` is the parser's own
     * context, for a splitter that reads entities (the location splitter reads `repository-host`).
     */
    split(state: PartialRef, ctx: ServiceContext): PartialRef[];
}

/** Every reading of one written ref. */
export interface RefParseResult {
    readonly input: string;
    /** Every finished reading, in splitter order. */
    readonly readings: SousRef[];
    /** Why splitters turned the text down; quoted only when nothing reads. */
    readonly problems: string[];
}

/** Reads a written ref into every reading it could have. */
export interface RefsParser {
    /** Every reading, with no regard to where it was written. */
    parse(input: string): RefParseResult;
}

// ---------------------------------------------------------------------------------------------
// Pruning and lookups: the ref-pruner and ref-lookup entities
// ---------------------------------------------------------------------------------------------

/** One reading a place refused. */
export interface DroppedRef {
    readonly ref: SousRef;
    /** Why the place does not allow it, as a sentence. */
    readonly reason: string;
    /** What to write there instead, as it would appear after "Write". */
    readonly instead?: string;
}

/** What a pruner decided about a list of readings. */
export interface RefPruneResult {
    /** The readings the place allows, in the order they came (possibly rewritten, such as lowercased). */
    readonly kept: SousRef[];
    readonly dropped: DroppedRef[];
    /** Sentences about readings kept all the same. */
    readonly warnings: string[];
}

/**
 * A `ref-pruner` entity: decides which readings count in one place. Several pruners for one place
 * run in the order they were added, each given what the one before kept.
 */
export interface RefPrunerEntity {
    id: string;
    /** The place it speaks for. */
    source: RefSource;
    /** What the place is called in a sentence: `in an include line`. */
    place: string;
    /** Splits the readings into those allowed and those refused; throws a `ConfigError` for a reading that must fail at once. */
    prune(candidates: readonly SousRef[], input: string, ctx: ServiceContext): RefPruneResult;
}

/** One thing a candidate reading turned out to name. */
export interface RefMatch {
    /** The known ref, spelled the way it is published, with every parent it has. */
    ref: SousRef;
    /** True when every part matched in exactly the case it was written. */
    exactSpelling: boolean;
}

/**
 * A `ref-lookup` entity: what exists, as a queryable object (the cached indexes, the lockfile, the
 * variables in play). `find` returns `[]` when nothing matches, and throws when it could not look.
 */
export interface RefLookupEntity {
    id: string;
    /** What it knows about, in a few words, for errors and `plugins show`. */
    description?: string;
    /** The kinds it answers for. Default: every kind. */
    kinds?: readonly RefKind[];
    /** Words callers select lookups by: `installed`, `latest`, `lockfile`, `variables`. */
    tags?: readonly string[];
    /** Asked only when a caller names it or one of its tags. Default `false`: asked whenever lookups are on. */
    optIn?: boolean;
    /** Every known ref a candidate names. */
    find(candidate: SousRef, ctx: ServiceContext): Promise<RefMatch[]>;
    /** The same, at once, for callers that cannot wait (a template include). */
    findSync?(candidate: SousRef, ctx: ServiceContext): RefMatch[];
}

// ---------------------------------------------------------------------------------------------
// refs.resolver
// ---------------------------------------------------------------------------------------------

/** Which lookups a resolve asks: none, every default one, or those named by id or tag. */
export type RefLookupSelection = boolean | readonly string[];

/** What `refs.resolver` is asked. */
export interface RefResolveRequest {
    /** The ref exactly as written. */
    input: string;
    /** Where it was written. Default `commandLine`. */
    from?: RefSource;
    /** The kinds the caller accepts; other readings and matches are set aside. */
    kinds?: readonly RefKind[];
    /** Which `ref-lookup` entities narrow the readings to what exists. Default `true`. */
    lookups?: RefLookupSelection;
    /**
     * Lookups the caller holds itself, such as a release's fetched index, asked before the selected
     * entities. Any given turns lookups on even when `lookups` is `false`.
     */
    extraLookups?: readonly RefLookupEntity[];
    /** True when a ref the place refuses in every reading names nothing instead of throwing. */
    refusedIsEmpty?: boolean;
}

/** What a resolve found. */
export interface RefResolution {
    readonly input: string;
    /** The refs it names, best first. Empty when no lookup knew any reading. */
    readonly refs: SousRef[];
    readonly dropped: DroppedRef[];
    readonly warnings: string[];
    /** True when `refs` were narrowed against what exists. */
    readonly usedLookup: boolean;
}

/** One ref found inside a longer text. */
export interface RefInString {
    /** The text that parsed, punctuation around it removed. */
    readonly text: string;
    /** Where it starts in the string. */
    readonly index: number;
    readonly result: RefResolution;
}

/** Which readings count where a ref is written, and what exists. */
export interface RefsResolver {
    /** Parses and prunes, with no lookup. Throws a `ConfigError` listing every reason when every reading is refused. */
    parse(input: string, from?: RefSource): RefResolution;
    /** Parses, prunes and narrows to what the selected lookups know. */
    resolve(request: RefResolveRequest): Promise<RefResolution>;
    /** The same, through each lookup's `findSync`; a lookup without one is skipped. */
    resolveSync(request: RefResolveRequest): RefResolution;
    /** Whether the text reads as a ref in a place. */
    isValid(input: string, from?: RefSource): boolean;
    /** Every ref inside a longer text. */
    findInString(text: string, from?: RefSource): RefInString[];
}

// ---------------------------------------------------------------------------------------------
// refs.picker
// ---------------------------------------------------------------------------------------------

/** The facts one resolved ref carries, for a front end to show. */
export interface ResolvedRefFacts {
    /** What was written. */
    readonly search: string;
    /** The fully qualified key it resolved to. */
    readonly resolvedTo: string;
    /** The kind, as a word: `recipe`, `environment variable`. */
    readonly kind: string;
    readonly variable?: string;
    readonly recipe?: string;
    readonly namespace?: string;
    readonly repository?: string;
    /** A repository's URL. */
    readonly location?: string;
    readonly description?: string;
    /** The sentence saying why this candidate won. */
    readonly reason?: string;
}

/** How a pick behaves. */
export interface RefPickOptions {
    /** The ref exactly as written, for every message. */
    search: string;
    /** Takes the first match instead of asking (`--accept-first`). */
    acceptFirst?: boolean;
    /** The question asked when there is more than one match. Default: ``Which '<search>' did you mean?`` */
    prompt?: string;
    /** Reports the facts of the ref picked, with `facts` as the message details. Default `true`. */
    announce?: boolean;
    /** More lines for the error a ref that matched nothing raises. */
    details?: readonly string[];
}

/** Where a pick asks and reports: the chain's own (`ctx` fits). */
export interface RefPickIo {
    readonly prompter: Prompter;
    readonly reporter: Reporter;
}

/** Settling which of several matches a run proceeds with. */
export interface RefsPicker {
    /** The one ref a run proceeds with; asks through the prompter, naming `--accept-first`. */
    pick(matches: readonly SousRef[], options: RefPickOptions, io: RefPickIo): Promise<SousRef>;
    /** The facts a resolved ref carries. */
    facts(ref: SousRef, search: string, reason?: string): ResolvedRefFacts;
}

// ---------------------------------------------------------------------------------------------
// refs.format (agent addition: writing refs and keys back out)
// ---------------------------------------------------------------------------------------------

/** Writing refs back out, and reading the stored `namespace/recipe` keys. */
export interface RefsFormat {
    /** The stored key: `workflow/task-files`, `workflow/task-files.branchPattern`. */
    key(ref: SousRef): string;
    /** The key with its repository identity in front, unique across repositories. */
    identity(ref: SousRef): string;
    /** The canonical written form, locators included. */
    format(ref: SousRef): string;
    /** The shortest spelling that names it fully. */
    spelling(ref: SousRef): string;
    /** One line for a list of matches: the spelling, the kind and the description. */
    describe(ref: SousRef): string;
    /** The kind, as a word. */
    kindLabel(ref: SousRef): string;
    /** Splits a stored recipe key into its namespace and name. */
    splitRecipeKey(key: string): { namespace: string; name: string };
    /** The namespace of a stored key. */
    namespaceOfKey(key: string): string;
    /** A namespace ref, optionally under a repository name. */
    namespaceRef(name: string, repo?: string): NamespaceRef;
    /** A recipe ref, optionally under a repository name and with a range. */
    recipeRef(namespace: string, name: string, options?: { repo?: string; range?: string }): RecipeRef;
    /** Parses a namespace or recipe as written in a place; throws a `ConfigError` for anything else. */
    parseNamedRef(input: string, from?: RefSource): NamedRef;
    /** The repository, namespace and recipe a ref sits in, whatever its kind. */
    partsOf(ref: SousRef): { repo?: RepoRef; namespace?: NamespaceRef; recipe?: RecipeRef; range?: string };
}

// ---------------------------------------------------------------------------------------------
// refs.locations, and the part of a repository-host entity it reads
// ---------------------------------------------------------------------------------------------

/** A repository in its canonical form. */
export interface CanonicalRepository {
    /** `github.com`. */
    host: string;
    /** The owner, or the whole group path of a nested group (`acme/platform`). */
    owner: string;
    name: string;
    httpsUrl: string;
    sshUrl: string;
}

/** A location as written, before a host reads it. */
export interface WrittenLocation {
    host: string;
    segments: string[];
}

/** One way a host reads a location inside one of its repositories. */
export interface LocationReading {
    /** Where the repository path ends. */
    repoPath: string;
    /** What the segments after it name: a namespace, a namespace and a recipe, or a namespace and `*`. */
    named?: string[];
    /** A browser URL's path inside the repository, branch still in front of it. */
    browsed?: string;
}

/**
 * The part of a `repository-host` entity (a kind `plugin-recipes` defines) that `refs.locations`
 * reads. Declared here so plugin-refs needs no dependency on the plugin above it; the full entity
 * extends it.
 */
export interface RepositoryLocator {
    id: string;
    /** The host a locator such as `github://owner/repo` means when it names none. */
    defaultHost?: string;
    /** The locator schemes it reads (`github`). Default: its id. */
    schemes?: readonly string[];
    /** Every way it reads a location inside one of its repositories. */
    readLocation(location: WrittenLocation): LocationReading[];
    /** The canonical locator for something inside one of its repositories. */
    formatLocator(host: string, repoPath: string, rest: string): string;
    /** Whether a URL is one of its repositories. */
    matches(url: string): boolean;
    /** The canonical form of one of its repositories' URLs. */
    canonicalize(url: string): CanonicalRepository;
}

/** Repository locations (`github://...`) and canonical identity. */
export interface RefsLocations {
    /**
     * The location a repository URL or locator names, or `undefined` when no host reads it.
     * `provider` names the host outright, for a self-hosted instance no host recognizes.
     */
    fromUrl(url: string, provider?: string): RefLocation | undefined;
    /** The location of a repository a host reads; throws a `ConfigError` when the host is unknown or cannot read it. */
    locationFor(provider: string, host: string, repoPath: string): RefLocation;
    /**
     * The canonical form of a URL; throws a `ConfigError` naming the hosts known when none reads it.
     * `provider` names the host outright; it is refused only when a different host plainly owns the URL.
     */
    canonicalize(url: string, provider?: string): CanonicalRepository;
    /** The canonical identity of a URL: `github.com/sous-io/sous-recipes`. */
    identity(url: string, provider?: string): string;
    /** The identity of a canonical repository. */
    identityOf(repository: CanonicalRepository): string;
    /** The host that reads a URL, or `undefined`. */
    hostFor(url: string): RepositoryLocator | undefined;
    /** The host with an id, or `undefined`. */
    host(id: string): RepositoryLocator | undefined;
    /** A short name made from an identity, for a repository a project has not named yet. */
    shortName(identity: string): string;
    /** Every host known, in plugin order. */
    hosts(): RepositoryLocator[];
}

// ---------------------------------------------------------------------------------------------
// The hash-name entity
// ---------------------------------------------------------------------------------------------

/** One file a `#` view lists. */
export interface HashViewFile {
    /** The path inside the view, without the `#name/` prefix, `/`-separated. */
    readonly path: string;
    /** The real file's absolute path. */
    readonly file: string;
}

/** What a `#` name's methods get: the services' context, and the variable scope of the include. */
export interface HashNameContext extends ServiceContext {
    /** The variables in scope where the name was written. */
    readonly scope: Readonly<Record<string, string>>;
}

/**
 * A `hash-name` entity: a `#` name (`#project`, `#memories`) and what it stands for. It either
 * stands for directories (`bases`) or lists virtual files (`view`).
 */
export interface HashNameEntity {
    /** The name without its `#`: lowercase kebab case. */
    id: string;
    /** What the name is, in one sentence. */
    description: string;
    /** The directories it stands for, tried in order; `[]` when it stands for nothing in this project. */
    bases?(ctx: HashNameContext): string[];
    /** The files it lists, in order; an include of `#name/<glob>` selects among them. */
    view?(ctx: HashNameContext): HashViewFile[];
}

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Reading a ref into every reading. */
        "refs.parser": RefsParser;
        /** Which readings count, and what exists. */
        "refs.resolver": RefsResolver;
        /** Settling one match. */
        "refs.picker": RefsPicker;
        /** Writing refs and keys. */
        "refs.format": RefsFormat;
        /** Repository locations and identity. */
        "refs.locations": RefsLocations;
    }

    interface SousEntities {
        /** One step of the ref parser. */
        "ref-splitter": RefSplitterEntity;
        /** Which readings count in one place. */
        "ref-pruner": RefPrunerEntity;
        /** What exists, for narrowing readings. */
        "ref-lookup": RefLookupEntity;
        /** A `#` name. */
        "hash-name": HashNameEntity;
    }
}
