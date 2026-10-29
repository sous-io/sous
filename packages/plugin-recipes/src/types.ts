/**
 * The contract of plugin-recipes (S6, "Recipes: plugin-recipes"; S4): everything about getting
 * recipes into a project. Repositories and their hosts, trust, subscriptions, which recipes are
 * active on this machine, resolving versions, the lockfile, downloading during config building, the
 * store, the index cache, links and checkouts, the core recipe, recipe config layers, recipe
 * plugins, the catalog and update plans. It also implements `compiler.namespace-resolver`.
 *
 * Its contributors (no registry entries): `recipes.fetch`, `recipes.core`, `recipes.config-layers`,
 * `recipes.plugins`. During config building other contributors read the active recipes through
 * `active-recipe` entities (agent addition), since `config`-lifetime services exist only after.
 *
 * Other plugins import this file type-only.
 */

import type { Prompter, Reporter, ServiceContext } from "@sous-io/plugin-api";
import type {
    ContentHash,
    ContentKind,
    DependencyKind,
    IndexDependency,
    IndexFile,
    LinkOrigin,
    LockedRecipe,
    Lockfile,
    RecipeManifest,
    StoreEntry,
    VariableDefinition,
} from "@sous-io/plugin-formats/types";
import type {} from "@sous-io/plugin-compiler/types";
import type { CanonicalRepository, NamedRef, RepositoryLocator, SousRef } from "@sous-io/plugin-refs/types";

// =============================================================================================
// Config keys: repos, subscriptions, store
// =============================================================================================

/** One trusted repository, keyed under `repos` by the project's short name for it. Adding it trusts it. */
export interface RepoEntry {
    url: string;
    /** Default `true`; `false` opts out of a repository sous provides itself. */
    enabled?: boolean;
    /** The `repository-host` entity id; inferred from the URL when left out. */
    provider?: string;
    /** Install a newer in-range version whenever one exists. */
    alwaysPull?: boolean;
    addedAt?: string;
    /** `user`, or the ref of the recipe whose dependency pulled it in. */
    addedBy?: string;
}

/** One subscription, keyed under `subscriptions` by `namespace` or `namespace/recipe`. */
export interface SubscriptionEntry {
    /** Default `true`; `false` switches it off on this machine, keeping its pins (S4; C59). */
    enabled?: boolean;
    /** Default `*`. */
    range?: string;
    prerelease?: boolean;
    alwaysPull?: boolean;
    addedAt?: string;
    /** `user`, or the ref of the recipe that co-subscribed it. */
    addedBy?: string;
}

/** The `store` config key, defaults filled in. */
export interface StoreSettings {
    /** Size cap past which least-recently-used entries are collected. Default 1 GiB. */
    maxBytes: number;
    /** How long a fetched index stays fresh. Default 300. */
    freshnessSeconds: number;
    /** How often watch mode checks upstream. Default 300. */
    watchPollSeconds: number;
}

/** Who added a repository or subscription by hand. */
export type AddedByUser = "user";

// =============================================================================================
// The repository-host entity (S4: read strategies and token sources)
// =============================================================================================

/** What a host can do beyond reading. */
export type RepositoryHostFeature = "fetch" | "submit" | "proposals" | (string & {});

/** What a host's methods get. */
export interface RepositoryHostContext extends ServiceContext {
    /** Where to report; never print (L3). */
    readonly reporter: Reporter;
    readonly signal?: AbortSignal;
}

/** A token a token source found. */
export interface RepositoryToken {
    readonly value: string;
    /** Where it came from: `GITLAB_TOKEN`, `git credential fill`, `glab`. */
    readonly source: string;
}

/** One place a token may come from, tried in order (S4, "Token sources"). A missing source gives `undefined`. */
export interface RepositoryTokenSource {
    id: string;
    /** For the error that lists each attempt. */
    label: string;
    token(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<RepositoryToken | undefined>;
    /**
     * Like `token`, but saying why there is none (`GITLAB_TOKEN unset`), for the error that lists
     * each attempt. `missing: undefined` says nothing (a CLI that is not installed). Optional:
     * without it, the error says the source found none.
     */
    find?(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<{ readonly token: RepositoryToken } | { readonly missing: string | undefined }>;
    /** One command that would make this source work: `export GITLAB_TOKEN=<a token with read_repository>`. */
    fix?(repository: CanonicalRepository): string | undefined;
}

/** One file to read from a repository. */
export interface RepositoryReadRequest {
    readonly repository: CanonicalRepository;
    /** The file, relative to the root: `sous.index.json`. */
    readonly path: string;
    /** A branch, tag or `HEAD`. */
    readonly ref: string;
    /** The ETag of the cached copy, for a conditional request. */
    readonly etag?: string;
    /** The token found, for a strategy that uses one. */
    readonly token?: RepositoryToken;
}

/** What one read attempt gave. */
export type RepositoryReadOutcome =
    | { readonly ok: true; readonly text: string; readonly ref: string; readonly etag?: string }
    | { readonly ok: true; readonly notModified: true; readonly etag?: string }
    | { readonly ok: false; readonly reason: string };

/** One way to read a file, tried in order (S4, "Read strategies"); a plugin can add its own. */
export interface RepositoryReadStrategy {
    /** `http-token`, `http`, `git`. Remembered per repository in `$SOUS_HOME/cache/read-strategies.json`. */
    id: string;
    label: string;
    /** True when it needs a token; it is skipped when none is found. */
    usesToken?: boolean;
    read(request: RepositoryReadRequest, ctx: RepositoryHostContext): Promise<RepositoryReadOutcome>;
    /** One line that would make this strategy work: `set up git access to gitlab.com (an SSH key, or a credential helper)`. */
    fix?(repository: CanonicalRepository): string | undefined;
}

/** Whether the host's command line tool is signed in. */
export interface RepositoryAuthStatus {
    readonly ok: boolean;
    /** One plain sentence: who is signed in, or what to install or run. */
    readonly detail: string;
}

/** The host's command line tool (`gh`, `glab`), needed only to propose changes. */
export interface RepositoryHostCli {
    readonly command: string;
    readonly label: string;
    /** How to install it. */
    readonly install: string;
}

/** A fork made to propose changes from. */
export interface ForkedRepository {
    readonly owner: string;
    readonly name: string;
    readonly httpsUrl: string;
    readonly sshUrl: string;
}

/** A change to propose. */
export interface ChangeProposal {
    branch: string;
    base?: string;
    title: string;
    body: string;
    draft: boolean;
    /** The account the branch was pushed to, when not the repository itself. */
    head?: { owner: string };
}

/** A proposal made or updated. */
export interface ProposedChange {
    readonly url?: string;
    readonly detail: string;
}

/** A proposal's state. */
export type ProposalState = "open" | "merged" | "closed";

/** One proposal. */
export interface ProposalSummary {
    readonly id: string;
    readonly url?: string;
    readonly state: ProposalState;
    readonly title: string;
    readonly draft: boolean;
    readonly base?: string;
}

/** Finding the proposal of a branch. */
export interface ProposalQuery {
    branch: string;
    fromFork: boolean;
    forkOwner?: string;
}

/** A proposal's review state. */
export type ProposalReview = "approved" | "changes requested" | "review required";

/** A proposal's status, for `repo submit --status`. */
export interface ProposalStatus {
    readonly proposal: ProposalSummary;
    readonly review?: ProposalReview;
    readonly checks?: { readonly passed: number; readonly failed: number; readonly pending: number };
    readonly mergeable?: boolean;
}

/** One file a scaffold writes, relative to the new repository's root. */
export interface ScaffoldFile {
    readonly path: string;
    readonly content: string;
    /** Marks it executable. */
    readonly executable?: boolean;
}

/** What a scaffold is for, as a host's CI workflow sees it. */
export interface ScaffoldOptions {
    readonly name: string;
    readonly namespace?: string;
    /** The sous version the workflow installs. */
    readonly sousVersion: string;
}

/**
 * A `repository-host` entity (S6; S4): a host of recipe repositories, with its read strategies
 * and token sources. Write-path methods are present only on hosts that declare `submit` or
 * `proposals`. Nothing host-specific lives outside the host plugins (rule 5).
 */
export interface RepositoryHostEntity extends RepositoryLocator {
    /** What it can do. */
    features: readonly RepositoryHostFeature[];
    /** The read strategies, tried in order. */
    readStrategies: readonly RepositoryReadStrategy[];
    /** The token sources, tried in order. */
    tokenSources?: readonly RepositoryTokenSource[];
    /** Fetches one recipe's subtree at one tag into a directory, never the whole repository. */
    fetchRecipeTree(repository: CanonicalRepository, recipePath: string, tag: string, destination: string, ctx: RepositoryHostContext): Promise<void>;
    /** What it calls a proposal: `pull request`, `merge request`. */
    proposalNoun?: string;
    cli?: RepositoryHostCli;
    authStatus?(ctx: RepositoryHostContext): Promise<RepositoryAuthStatus>;
    /** Whether the user may push; `undefined` when it cannot tell. */
    canPush?(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<boolean | undefined>;
    fork?(repository: CanonicalRepository, ctx: RepositoryHostContext): Promise<ForkedRepository>;
    proposeChange?(repository: CanonicalRepository, proposal: ChangeProposal, ctx: RepositoryHostContext): Promise<ProposedChange>;
    findProposal?(repository: CanonicalRepository, query: ProposalQuery, ctx: RepositoryHostContext): Promise<ProposalSummary | undefined>;
    proposalStatus?(repository: CanonicalRepository, id: string, ctx: RepositoryHostContext): Promise<ProposalStatus>;
    updateProposal?(repository: CanonicalRepository, id: string, update: { title?: string; body?: string }, ctx: RepositoryHostContext): Promise<ProposedChange>;
    /** The CI workflow and other host files a new recipe repository gets (`repo.init`). */
    scaffoldFiles?(options: ScaffoldOptions): ScaffoldFile[];
}

// =============================================================================================
// The active-recipe entity, and recipes.active
// =============================================================================================

/** Where an active recipe's files come from. */
export type ActiveRecipeSource = "store" | "link" | "core" | "project";

/**
 * An `active-recipe` entity (agent addition): one locked recipe reached from the subscriptions
 * switched on on this machine (S4, 3), added by the `recipes.fetch` contributor once its files are
 * on disk. Plain data.
 */
export interface ActiveRecipeEntity {
    /** `namespace/recipe`. */
    id: string;
    namespace: string;
    name: string;
    /** The repository's short name. */
    repo: string;
    /** The repository's identity. */
    identity: string;
    version: string;
    hash: ContentHash;
    kind: DependencyKind;
    requestedBy: string[];
    /** The directory holding its files. */
    dir: string;
    source: ActiveRecipeSource;
    manifest: RecipeManifest;
}

/** A locked recipe that is not active here, and why (S4, 4: one line per skipped recipe). */
export interface SkippedRecipe {
    readonly key: string;
    readonly reason: "subscription-disabled" | "repository-disabled" | "untrusted" | "missing" | "not-reached";
    /** The subscription that switched it off. */
    readonly subscription?: string;
    /** The file that set it, when known (`conf.d/610-mac.jsonc`). */
    readonly setBy?: string;
    /** One plain sentence. */
    readonly message: string;
}

/** One file of an active recipe's content. */
export interface RecipeContentFile {
    /** Relative to the recipe, `/`-separated. */
    readonly path: string;
    /** Absolute. */
    readonly file: string;
}

/** One content block of an active recipe, its files listed. */
export interface ActiveRecipeContent {
    readonly recipe: ActiveRecipeEntity;
    readonly kind: ContentKind;
    readonly files: readonly RecipeContentFile[];
}

/** Which recipes are active on this machine (S6, `recipes.active`). */
export interface RecipesActive {
    /** Every active recipe, in lockfile order. */
    list(): ActiveRecipeEntity[];
    get(key: string): ActiveRecipeEntity | undefined;
    /** Locked recipes that are not active here, and why. */
    skipped(): SkippedRecipe[];
    /** Every active recipe's content of one kind, its files listed bytewise. */
    contents(kind: ContentKind): ActiveRecipeContent[];
    /** Every variable the active recipes define, with the recipe defining it. */
    variables(): Array<{ readonly recipe: ActiveRecipeEntity; readonly definition: VariableDefinition }>;
}

// =============================================================================================
// recipes.trust
// =============================================================================================

/** A repository a recipe needs that the project does not trust yet. */
export interface MissingRepo {
    readonly name: string;
    readonly url?: string;
    readonly identity?: string;
    readonly provider?: string;
    readonly requiredBy: ReadonlyArray<{ readonly ref: string; readonly requestedBy: string }>;
}

/** How to confirm trust. */
export interface ConfirmTrustOptions {
    /** `--yes`: trust without asking. */
    yes?: boolean;
    dryRun?: boolean;
}

/** What confirming trust did. */
export interface ConfirmTrustResult {
    readonly accepted: MissingRepo[];
    /** Names written to `conf.d/500-repos.jsonc`. */
    readonly added: string[];
    /** Repositories with no URL to trust. */
    readonly needUrl: string[];
}

/** Where trust questions go: the chain's own (`ctx` fits). */
export interface ChainIo {
    readonly prompter: Prompter;
    readonly reporter: Reporter;
}

/** Trust: which repositories the project accepts recipes from; nothing inside an untrusted one runs (S6, `recipes.trust`). */
export interface RecipesTrust {
    /** Every trusted, enabled repository, by short name. */
    trusted(): Record<string, RepoEntry>;
    /** Whether a repository (by short name, URL or identity) is trusted. */
    isTrusted(repository: string): boolean;
    /** The short name a URL or identity is trusted under. */
    nameOf(repository: string): string | undefined;
    /** Asks (or, with `yes`, does not ask) to trust repositories, then adds them; asks through `io` (L4: `--yes`). */
    confirm(missing: readonly MissingRepo[], options: ConfirmTrustOptions, io: ChainIo): Promise<ConfirmTrustResult>;
}

// =============================================================================================
// recipes.resolver and recipes.lock
// =============================================================================================

/** One recipe or namespace to resolve. */
export interface RecipeRequest {
    ref: NamedRef;
    range?: string;
    prerelease?: boolean;
    /** `project`, or the key of the recipe asking. */
    requestedBy: string;
    kind?: DependencyKind;
}

/** One recipe resolved to a version. */
export interface ResolvedRecipe {
    readonly key: string;
    readonly namespace: string;
    readonly name: string;
    readonly repo: string;
    readonly identity: string;
    readonly version: string;
    readonly hash: ContentHash;
    readonly tag: string;
    readonly path: string;
    readonly kind: DependencyKind;
    readonly requestedBy: string[];
    readonly ranges: ReadonlyArray<{ readonly range: string; readonly requestedBy: string }>;
    readonly prerelease: boolean;
    readonly dependencies?: Record<string, IndexDependency>;
    readonly variables?: VariableDefinition[];
    readonly declares?: { readonly depends: string[]; readonly subscribes: string[] };
}

/** How to resolve. */
export interface ResolveOptions {
    /** Lets prereleases match. */
    prerelease?: boolean;
    /** Versions to keep where they still satisfy every range, by key (holding the lock). */
    keep?: Readonly<Record<string, string>>;
    /** Indexes to use instead of the cached ones (a "what if" plan). */
    indexes?: ReadonlyMap<string, IndexFile>;
    /** Checks upstream for newer indexes first. */
    latest?: boolean;
}

/** What a resolve found. */
export interface ResolveResult {
    readonly resolved: ResolvedRecipe[];
    readonly missingRepos: MissingRepo[];
    /** Recipe keys whose manifests could not be read. */
    readonly unreadable: string[];
    /** Dependency cycles, each as the keys around it. */
    readonly cycles: string[][];
}

/** Resolving subscriptions to versions, and keeping only what is reachable (S6, `recipes.resolver`). */
export interface RecipesResolver {
    /** Resolves requests and everything they depend on. */
    resolve(requests: readonly RecipeRequest[], options?: ResolveOptions): Promise<ResolveResult>;
    /** Resolves every subscription in the config. */
    resolveSubscriptions(options?: ResolveOptions): Promise<ResolveResult>;
    /** The lockfile keys reachable from the subscriptions switched on here (S4, 3). */
    reachable(lockfile: Lockfile): string[];
}

/** One change between two lockfiles. */
export interface LockChange {
    readonly key: string;
    readonly from?: string;
    readonly to?: string;
}

/** What changed between two lockfiles. */
export interface LockDiff {
    readonly added: LockChange[];
    readonly removed: LockChange[];
    readonly updated: LockChange[];
    readonly reposAdded: string[];
    readonly reposRemoved: string[];
    readonly unchanged: boolean;
}

/** What restoring the store from the lockfile did. */
export interface RestoreReport {
    readonly restored: string[];
    readonly alreadyPresent: string[];
    readonly failed: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
}

/** The lockfile (S6, `recipes.lock`): read, write, diff, restore. Works out a missing identity after parsing. */
export interface RecipesLock {
    path(): string;
    /** The lockfile, or an empty one when there is none. */
    read(): Lockfile;
    /** Writes it in its one stable form; returns what changed. */
    write(lockfile: Lockfile, options?: { dryRun?: boolean }): Promise<LockDiff>;
    /** What changed between two lockfiles. */
    diff(before: Lockfile, after: Lockfile): LockDiff;
    /** The lockfile resolved recipes make, keeping entries for switched-off subscriptions (S4, 2). */
    fromResolved(resolved: readonly ResolvedRecipe[], previous?: Lockfile): Lockfile;
    /** Downloads every pinned recipe missing from the store. */
    restore(options?: { keys?: readonly string[]; signal?: AbortSignal }): Promise<RestoreReport>;
    /** One pinned recipe. */
    get(key: string): LockedRecipe | undefined;
}

// =============================================================================================
// recipes.store and recipes.index-cache
// =============================================================================================

/** One recipe version in the store. */
export interface StoreKey {
    identity: string;
    namespace: string;
    name: string;
    version: string;
}

/** A recipe version found in the store. */
export interface StoreHit {
    readonly dir: string;
    readonly entry: StoreEntry;
}

/** How to collect garbage. */
export interface StoreGcOptions {
    /** Default: `store.maxBytes`. */
    maxBytes?: number;
    /** Never evicts these. Default: every pinned recipe of this project. */
    keep?: readonly StoreKey[];
    dryRun?: boolean;
}

/** What a collection did. */
export interface StoreGcReport {
    readonly evicted: StoreEntry[];
    readonly kept: StoreEntry[];
    readonly bytesBefore: number;
    readonly bytesAfter: number;
    readonly dryRun: boolean;
}

/** The machine-wide recipe store (S6, `recipes.store`). */
export interface RecipesStore {
    readonly root: string;
    entryDir(key: StoreKey): string;
    /** Copies a fetched recipe in, checking its hash. */
    put(key: StoreKey, sourceDir: string, expectedHash?: ContentHash): Promise<StoreEntry>;
    get(key: StoreKey): Promise<StoreHit | undefined>;
    has(key: StoreKey): Promise<boolean>;
    remove(key: StoreKey): Promise<void>;
    list(): Promise<StoreEntry[]>;
    gc(options?: StoreGcOptions): Promise<StoreGcReport>;
}

/** Where an index came from. */
export type IndexSource = "cache" | "network" | "stale" | "link";

/** What sous knows about a cached index. */
export interface IndexMeta {
    readonly url: string;
    readonly identity: string;
    readonly fetchedAt: string;
    readonly lastCheckedAt: string;
    readonly etag?: string;
    readonly hash: ContentHash;
    /** The read strategy that worked (S4, "Sous remembers what worked"). */
    readonly strategy?: string;
}

/** An index, with where it came from. */
export interface CachedIndex {
    readonly repo: string;
    readonly index: IndexFile;
    readonly source: IndexSource;
    readonly meta?: IndexMeta;
}

/** How to get an index. */
export interface GetIndexOptions {
    /** Checks upstream even when the cache is fresh (`--latest`). */
    latest?: boolean;
    /** Never goes upstream (`--installed`). */
    offline?: boolean;
    signal?: AbortSignal;
}

/** A failed read, listing each attempt (S4, "When everything fails"). */
export interface IndexReadFailure {
    readonly repo: string;
    readonly attempts: ReadonlyArray<{ readonly strategy: string; readonly reason: string }>;
    readonly fixes: readonly string[];
}

/** Cached repository indexes, and when to look upstream (S6, `recipes.index-cache`). */
export interface RecipesIndexCache {
    /** The index of a trusted repository, by short name. Throws a `SousError` built from an `IndexReadFailure`. */
    get(repo: string, options?: GetIndexOptions): Promise<CachedIndex>;
    /** The indexes of every trusted, enabled repository; failures listed, not thrown. */
    getAll(options?: GetIndexOptions): Promise<{ indexes: CachedIndex[]; failed: IndexReadFailure[] }>;
    /** The cached index, never going upstream. */
    cached(repo: string): CachedIndex | undefined;
    /** Whether the cached index is still fresh (`store.freshnessSeconds`, `alwaysPull`). */
    isFresh(repo: string): boolean;
    meta(repo: string): IndexMeta | undefined;
    /** Forgets a cached index. */
    forget(repo: string): Promise<void>;
}

// =============================================================================================
// recipes.links and recipes.declarations
// =============================================================================================

/** Where a link is kept. */
export type LinkScope = "project" | "global";

/** A link in force. */
export interface ResolvedLink {
    readonly repo: string;
    readonly path: string;
    readonly origin: LinkOrigin;
    readonly linkedAt: string;
    readonly scope: LinkScope;
}

/** Links: the project and machine-wide links maps (S6, `recipes.links`). A project link wins over a global one. */
export interface RecipesLinks {
    /** Every link in force, by repository short name. */
    all(): Record<string, ResolvedLink>;
    get(repo: string): ResolvedLink | undefined;
    /** The links map file of a scope. */
    path(scope: LinkScope): string;
    /** Records a link. */
    set(repo: string, link: { path: string; origin: LinkOrigin }, scope: LinkScope, options?: { dryRun?: boolean }): Promise<ResolvedLink>;
    /** Forgets a link; returns the one removed. */
    remove(repo: string, scope: LinkScope, options?: { dryRun?: boolean }): Promise<ResolvedLink | undefined>;
}

/** One `depends` or `subscribes` entry. */
export interface DependencyDeclaration {
    /** The ref exactly as written. */
    readonly declared: string;
    readonly kind: DependencyKind;
    /** The ref it parses to (manifest form). */
    readonly ref: NamedRef;
    /** True when it names a recipe, false for a whole namespace. */
    readonly named: boolean;
}

/** How one recipe brings in another (S6, `recipes.declarations`). */
export interface RecipesDeclarations {
    /** Every declaration of a manifest or a published version, `subscribes` first. */
    of(source: { readonly depends?: readonly string[]; readonly subscribes?: readonly string[] }): DependencyDeclaration[];
    /** The declaration of a recipe that covers a key, or `undefined`. */
    covering(source: { readonly depends?: readonly string[]; readonly subscribes?: readonly string[] }, key: string): DependencyDeclaration | undefined;
}

// =============================================================================================
// Intents
// =============================================================================================

/** An intent a handler ran afterwards through `ctx.run` (`vars.ask`, `build`), and what it gave. */
export interface IntentFollowUp {
    readonly intent: string;
    /** The result, typed by the intent's own plugin. */
    readonly result?: unknown;
    /** Why it was not run (`--no-build`, `--dry-run`). */
    readonly skipped?: string;
}

/** Inputs every intent that changes recipes accepts. */
export interface RecipeChangeFlags {
    /** Shows what would change, writing nothing. */
    dryRun?: boolean;
    /** Skips the build afterwards. */
    noBuild?: boolean;
}

/** Inputs that answer recipe questions ahead of time (L4), passed on to `vars.ask`. */
export interface AnswerFlags {
    /** `--answer <name>=<value>`, repeatable. */
    answer?: string[];
    /** A file of answers. */
    answersFile?: string;
}

/** `repo.add`. */
export interface RepoAddInput {
    url: string;
    /** The short name; default from the URL. */
    name?: string;
    /** The `repository-host` id; default from the URL. */
    provider?: string;
    /** Trusts without asking (`--yes`, `--force`, `--trust`). */
    yes?: boolean;
    dryRun?: boolean;
}

/** The result of `repo.add`. */
export interface RepoAddResult {
    readonly name: string;
    readonly url: string;
    readonly provider: string;
    readonly alreadyTrusted: boolean;
    readonly namespaces: string[];
    readonly recipeCount: number;
    readonly dryRun: boolean;
}

/** `repo.remove`. */
export interface RepoRemoveInput extends RecipeChangeFlags {
    repo: string;
    yes?: boolean;
}

/** The result of `repo.remove`. Files it deletes are read from `compiler.state` (ruled 2026-10-29). */
export interface RepoRemoveResult {
    readonly name: string;
    readonly url: string;
    /** True when it was a repository sous provides, switched off instead of removed. */
    readonly optedOut: boolean;
    readonly subscriptions: string[];
    readonly keptSubscriptions: string[];
    readonly removedRecipes: string[];
    readonly stayed: ReadonlyArray<{ readonly key: string; readonly heldBy: string[] }>;
    /** The built files it deletes. */
    readonly outputs: string[];
    readonly diff: LockDiff;
    readonly linkedPath?: string;
    readonly linkIsGlobal: boolean;
    readonly dryRun: boolean;
    readonly followUps: IntentFollowUp[];
}

/** `repo.trust`. */
export interface RepoTrustInput {
    /** A short name, URL or identity. */
    repo: string;
    /** A URL, when `repo` is a name with none recorded. */
    url?: string;
    yes?: boolean;
    dryRun?: boolean;
}

/** The result of `repo.trust`. */
export interface RepoTrustResult {
    readonly name: string;
    readonly url: string;
    readonly trusted: boolean;
    readonly alreadyTrusted: boolean;
    readonly dryRun: boolean;
}

/** Inputs of every browsing intent. */
export interface BrowsingFlags {
    /** Checks upstream for newer indexes first (`--latest`, `--remote`). */
    latest?: boolean;
    /** Only what is installed, never going upstream. */
    installed?: boolean;
}

/** `repo.list`. */
export interface RepoListInput extends BrowsingFlags {
    verbose?: boolean;
}

/** One repository `repo.list` shows. */
export interface RepoListing {
    readonly name: string;
    readonly url: string;
    readonly provider: string;
    readonly enabled: boolean;
    readonly alwaysPull: boolean;
    readonly addedBy?: string;
    readonly addedAt?: string;
    readonly namespaces?: string[];
    readonly recipeCount?: number;
    readonly linkedPath?: string;
    readonly indexSource?: IndexSource;
    readonly lastCheckedAt?: string;
    /** Why its index could not be read. */
    readonly problem?: string;
}

/** `repo.search`. */
export interface RepoSearchInput extends BrowsingFlags {
    text: string;
    /** Default 20. */
    limit?: number;
}

/** One search match. */
export interface SearchMatch {
    readonly ref: SousRef;
    /** The stored key. */
    readonly key: string;
    readonly kind: "namespace" | "recipe" | "variable";
    readonly repo: string;
    readonly description?: string;
    /** Higher is a better match. */
    readonly score: number;
}

/** `repo.gc`. */
export interface RepoGcInput {
    maxBytes?: number;
    dryRun?: boolean;
}

/** Inputs shared by `repo.link`'s and `repo.contribute`'s checkout options. */
export interface CheckoutFlags {
    /** Check out this existing branch. */
    branch?: string;
    /** Create this branch. */
    createBranch?: string;
    /** Create a branch with a generated name. */
    generateBranch?: boolean;
    /** The branch or tag a new branch starts from. */
    from?: string;
}

/** `repo.link`. */
export interface RepoLinkInput extends CheckoutFlags {
    repo: string;
    /** An existing checkout; default: clone one under sous home or the project's repos directory. */
    path?: string;
    /** Records the link machine-wide. */
    global?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    /** Checks out the latest release tag instead of the pinned one. */
    latest?: boolean;
}

/** The result of `repo.link`. */
export interface RepoLinkResult {
    readonly repo: string;
    readonly path: string;
    readonly origin: LinkOrigin;
    readonly scope: LinkScope;
    readonly cloned: boolean;
    readonly branch?: string;
    readonly trusted: string[];
    readonly dryRun: boolean;
}

/** `repo.unlink`. */
export interface RepoUnlinkInput extends RecipeChangeFlags, AnswerFlags {
    repo: string;
    global?: boolean;
    /** Re-resolves the pins against the published index afterwards. */
    update?: boolean;
    /** Deletes a checkout sous cloned. */
    remove?: boolean;
    yes?: boolean;
}

/** The result of `repo.unlink`. */
export interface RepoUnlinkResult {
    readonly repo: string;
    readonly path: string;
    readonly scope: LinkScope;
    readonly removedCheckout: boolean;
    readonly diff?: LockDiff;
    readonly dryRun: boolean;
    readonly followUps: IntentFollowUp[];
}

/** `subscription.add`. */
export interface SubscriptionAddInput extends RecipeChangeFlags, AnswerFlags {
    /** A recipe or namespace, in any form the command line allows. */
    ref: string;
    prerelease?: boolean;
    alwaysPull?: boolean;
    /** Trusts new repositories without asking (`--yes`, `--force`, `--trust`). */
    yes?: boolean;
    /** Takes the first match of an ambiguous ref. */
    acceptFirst?: boolean;
    /** Installs npm plugins the recipe requires (S1). */
    installPlugins?: boolean;
}

/** The result of `subscription.add`. It runs `vars.ask` and `build` afterwards through `ctx.run`. */
export interface SubscriptionAddResult {
    readonly ref: string;
    /** The key written under `subscriptions`. */
    readonly key: string;
    readonly resolvedFrom?: string;
    readonly resolved: ResolvedRecipe[];
    readonly trusted: string[];
    readonly diff: LockDiff;
    readonly unreadable: string[];
    readonly cycles: string[][];
    readonly dryRun: boolean;
    readonly followUps: IntentFollowUp[];
}

/** `subscription.remove`. */
export interface SubscriptionRemoveInput extends RecipeChangeFlags {
    ref: string;
}

/** The result of `subscription.remove`. */
export interface SubscriptionRemoveResult {
    readonly key: string;
    readonly diff: LockDiff;
    readonly stayed: ReadonlyArray<{ readonly key: string; readonly heldBy: string[] }>;
    /** True when it was a subscription sous adds itself, switched off instead of removed. */
    readonly optedOut: boolean;
    readonly dryRun: boolean;
    readonly followUps: IntentFollowUp[];
}

/** `subscription.enable` and `subscription.disable`: overwrite `enabled`, keeping every other field (S2). */
export interface SubscriptionToggleInput extends RecipeChangeFlags {
    ref: string;
}

/** The result of `subscription.enable` and `subscription.disable`. */
export interface SubscriptionToggleResult {
    readonly key: string;
    readonly enabled: boolean;
    readonly file: string;
    readonly changed: boolean;
    readonly dryRun: boolean;
    readonly followUps: IntentFollowUp[];
}

/** One subscription `subscription.list` shows. */
export interface SubscriptionListing {
    readonly key: string;
    readonly range: string | undefined;
    /** Whether it is switched on on this machine. */
    readonly enabled: boolean;
    readonly addedBy: string | undefined;
    readonly pinned: ReadonlyArray<{ readonly key: string; readonly version: string }>;
    /** A newer version in range, when `--latest` checked. */
    readonly newer?: ReadonlyArray<{ readonly key: string; readonly version: string }>;
}

/** What an update would change (C60). */
export type RecipeUpdateScope =
    | { kind: "all" }
    | { kind: "repository"; repo: string }
    | { kind: "namespace"; repo: string; namespace: string }
    | { kind: "recipe"; repo: string; key: string };

/** `recipe.update`: plans an update of pinned versions, writing nothing. */
export interface RecipeUpdateInput {
    /** A recipe, namespace or repository; default everything. */
    ref?: string;
    acceptFirst?: boolean;
}

/** An update plan: what the lockfile would become, and everything worth knowing first. */
export interface RecipeUpdatePlan {
    readonly scope: RecipeUpdateScope;
    readonly diff: LockDiff;
    /** The lockfile the update would write. */
    readonly lockfile: Lockfile;
    readonly missingRepos: MissingRepo[];
    /** Variables the new versions declare that have no answer yet. */
    readonly newVariables: ReadonlyArray<{ readonly recipe: string; readonly name: string }>;
    readonly unreadable: string[];
    readonly unreachable: ReadonlyArray<{ readonly repo: string; readonly reason: string }>;
    /** Recipes held by a link, not updated. */
    readonly linked: string[];
    /** Recipes that ship with sous. */
    readonly builtIn: ReadonlyArray<{ readonly key: string; readonly version?: string }>;
    readonly switchedOff: string[];
    readonly failed: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
    readonly cycles: string[][];
}

/** `subscription.update`: plans with `recipe.update`, then applies. */
export interface SubscriptionUpdateInput extends RecipeChangeFlags, AnswerFlags {
    ref?: string;
    yes?: boolean;
    acceptFirst?: boolean;
}

/** The result of `subscription.update`. */
export interface SubscriptionUpdateResult {
    readonly plan: RecipeUpdatePlan;
    readonly applied: boolean;
    readonly nothingToUpdate: boolean;
    readonly trusted: string[];
    readonly dryRun: boolean;
    readonly followUps: IntentFollowUp[];
}

/** `lock.rebuild`: resolves every subscription again and rewrites the lockfile. */
export interface LockRebuildInput {
    dryRun?: boolean;
}

/** The result of `lock.rebuild`. */
export interface LockRebuildResult {
    readonly diff: LockDiff;
    readonly lockfile: Lockfile;
    readonly missingRepos: MissingRepo[];
    readonly restored: RestoreReport;
    readonly dryRun: boolean;
}

/** The result of `lock.show`. */
export interface LockShowResult {
    readonly path: string;
    readonly lockfile: Lockfile;
    /** Each pinned recipe, with whether it is active here. */
    readonly recipes: ReadonlyArray<{ readonly key: string; readonly entry: LockedRecipe; readonly active: boolean; readonly skipped?: SkippedRecipe }>;
}

/** How much of a namespace the project subscribes to. */
export type NamespaceCoverage = "whole namespace" | "some recipes" | "none";

/** One namespace `namespace.list` shows. */
export interface NamespaceListing {
    readonly repo: string;
    readonly namespace: string;
    readonly description?: string;
    readonly recipeCount: number;
    readonly subscribed: NamespaceCoverage;
}

/** One recipe `recipe.list` and `namespace.show` show. */
export interface RecipeListing {
    readonly key: string;
    readonly namespace: string;
    readonly name: string;
    readonly repo: string;
    readonly latest?: string;
    readonly pinned?: string;
    readonly linkedPath?: string;
    readonly subscribed: boolean;
    readonly description?: string;
}

/** What `namespace.show` shows. */
export interface NamespaceDetail {
    readonly repo: string;
    readonly repoUrl?: string;
    readonly namespace: string;
    readonly description?: string;
    readonly subscribed: NamespaceCoverage;
    readonly recipes: RecipeListing[];
}

/** How a version relates to the project. */
export type VersionStatus = "latest" | "pinned" | "latest and pinned" | "other";

/** What `recipe.show` shows. */
export interface RecipeDetail {
    readonly key: string;
    readonly namespace: string;
    readonly name: string;
    readonly repo: string;
    readonly repoUrl?: string;
    readonly description?: string;
    readonly path: string;
    readonly latest?: string;
    readonly pinned?: string;
    readonly linkedPath?: string;
    readonly subscribed: boolean;
    /** The version the detail describes. */
    readonly describing?: string;
    readonly versions: ReadonlyArray<{ readonly version: string; readonly status: VersionStatus; readonly prerelease: boolean; readonly releasedAt?: string }>;
    readonly dependencies: ReadonlyArray<{
        readonly key: string;
        readonly declared?: string;
        readonly kind?: DependencyKind;
        readonly resolvedVersion?: string;
        readonly resolvedRange?: string;
        readonly repo?: string;
    }>;
    readonly dependenciesRecorded: boolean;
    readonly contents: ReadonlyArray<{ readonly kind: ContentKind; readonly include: string[]; readonly destinations: string[] }>;
    readonly variables: VariableDefinition[];
    readonly manifestRead: boolean;
}

/** `namespace.show` and `recipe.show`. */
export interface CatalogShowInput extends BrowsingFlags {
    ref: string;
    acceptFirst?: boolean;
}

// =============================================================================================
// Events
// =============================================================================================

/** The payload of `recipes.fetched`: recipes downloaded into the store during config building. */
export interface RecipesFetchedPayload {
    readonly recipes: ReadonlyArray<{ readonly key: string; readonly version: string; readonly dir: string }>;
}

/** The payload of `recipes.locked`: the lockfile was written. */
export interface RecipesLockedPayload {
    readonly path: string;
    readonly diff: LockDiff;
}

// =============================================================================================
// Declarations
// =============================================================================================

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Trust. */
        "recipes.trust": RecipesTrust;
        /** The active recipes. */
        "recipes.active": RecipesActive;
        /** Resolving versions. */
        "recipes.resolver": RecipesResolver;
        /** The lockfile. */
        "recipes.lock": RecipesLock;
        /** The store. */
        "recipes.store": RecipesStore;
        /** The index cache. */
        "recipes.index-cache": RecipesIndexCache;
        /** Links. */
        "recipes.links": RecipesLinks;
        /** Recipe declarations. */
        "recipes.declarations": RecipesDeclarations;
    }

    interface SousIntents {
        "repo.add": { input: RepoAddInput; result: RepoAddResult };
        "repo.remove": { input: RepoRemoveInput; result: RepoRemoveResult };
        "repo.trust": { input: RepoTrustInput; result: RepoTrustResult };
        "repo.list": { input: RepoListInput; result: RepoListing[] };
        "repo.search": { input: RepoSearchInput; result: SearchMatch[] };
        "repo.gc": { input: RepoGcInput; result: StoreGcReport };
        "repo.link": { input: RepoLinkInput; result: RepoLinkResult };
        "repo.unlink": { input: RepoUnlinkInput; result: RepoUnlinkResult };
        "subscription.add": { input: SubscriptionAddInput; result: SubscriptionAddResult };
        "subscription.remove": { input: SubscriptionRemoveInput; result: SubscriptionRemoveResult };
        "subscription.enable": { input: SubscriptionToggleInput; result: SubscriptionToggleResult };
        "subscription.disable": { input: SubscriptionToggleInput; result: SubscriptionToggleResult };
        "subscription.list": { input: BrowsingFlags; result: SubscriptionListing[] };
        "subscription.update": { input: SubscriptionUpdateInput; result: SubscriptionUpdateResult };
        "recipe.update": { input: RecipeUpdateInput; result: RecipeUpdatePlan };
        "lock.rebuild": { input: LockRebuildInput; result: LockRebuildResult };
        "lock.show": { input: Record<string, never>; result: LockShowResult };
        "namespace.list": { input: BrowsingFlags; result: NamespaceListing[] };
        "namespace.show": { input: CatalogShowInput; result: NamespaceDetail };
        "recipe.list": { input: BrowsingFlags; result: RecipeListing[] };
        "recipe.show": { input: CatalogShowInput; result: RecipeDetail };
    }

    interface SousEvents {
        "recipes.fetched": RecipesFetchedPayload;
        "recipes.locked": RecipesLockedPayload;
    }

    interface SousEntities {
        /** A host of recipe repositories. */
        "repository-host": RepositoryHostEntity;
        /** A recipe active on this machine. */
        "active-recipe": ActiveRecipeEntity;
    }

    interface SousConfig {
        repos: Record<string, RepoEntry>;
        subscriptions: Record<string, SubscriptionEntry>;
        store: StoreSettings;
    }
}
