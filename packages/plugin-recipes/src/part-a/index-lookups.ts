/**
 * The repository indexes as `ref-lookup` entities (ported from
 * `src/services/ref-resolver/lookups/cached-index-lookup.ts`, `fetched-index-lookup.ts` and
 * `catalog-matcher.ts`):
 *
 * - `recipes.cached-index` answers from the indexes already on this machine. It reads nothing
 *   upstream and never fails: a candidate no cached index publishes simply has no match.
 * - `recipes.fetched-index` (opt-in, tag `latest`) reads indexes upstream first. A candidate
 *   written as a location is matched against the index of the repository it names, trusted or
 *   not; any other candidate against every trusted repository's index, checked upstream.
 *
 * Names match the same way everywhere: the exact spelling first, then ignoring case, and a written
 * name may be a glob pattern. A match is returned in the spelling the index publishes.
 *
 * ```ts
 * resolver.resolve({ input: "beta", lookups: ["latest"] });
 * // asks recipes.fetched-index, which reads every trusted index upstream
 * ```
 */

import { ConfigError, type ServiceContext } from "@sous-io/plugin-api";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import { isGlobName, locationOf } from "@sous-io/plugin-refs";
import type { NamespaceRef, RecipeRef, RefLocation, RefLookupEntity, RefMatch, RepoRef, SousRef } from "@sous-io/plugin-refs/types";
import type { RepoEntry } from "../types.js";
import { repoSearchOrder } from "./catalog-context.js";
import { trustedRepos } from "./project.js";
import { describeError } from "./util.js";

/** The cached-index lookup's id. */
export const CACHED_INDEX_LOOKUP_ID = "recipes.cached-index";

/** The fetched-index lookup's id. */
export const FETCHED_INDEX_LOOKUP_ID = "recipes.fetched-index";

/** How long a fetched index is reused before it is read upstream again. */
const FETCHED_INDEX_REUSE_MS = 60_000;

/** One repository and what its index publishes. */
export interface IndexCatalogRepo {
    /** The short name this project calls it, when it has one. */
    readonly name?: string;
    /** Where it lives, which is how a ref written as a location finds it. */
    readonly location?: RefLocation;
    readonly namespaces: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
    readonly recipes: ReadonlyArray<{ readonly namespace: string; readonly name: string; readonly description?: string; readonly path?: string }>;
}

/** How a written name matched a published one. */
type NameMatch = "exact" | "folded" | undefined;

/** Matches a written name (perhaps a glob) against a published one. */
export type NameMatcher = (written: string, known: string) => NameMatch;

/** What matching needs from other plugins. */
export interface IndexMatchTools {
    readonly matchName: NameMatcher;
    /** The stored key of a ref (`refs.format`), which orders matches inside one repository. */
    readonly key: (ref: SousRef) => string;
}

/** The catalog entry for one repository's index. */
export function catalogRepoOfIndex(index: IndexFile, repo: { name?: string; location?: RefLocation } = {}): IndexCatalogRepo {
    return {
        ...(repo.name === undefined ? {} : { name: repo.name }),
        ...(repo.location === undefined ? {} : { location: repo.location }),
        namespaces: Object.entries(index.namespaces).map(([name, declared]) => ({
            name,
            ...(declared?.description === undefined ? {} : { description: declared.description }),
        })),
        recipes: Object.entries(index.recipes).map(([key, recipe]) => {
            const slash = key.indexOf("/");

            return {
                namespace: key.slice(0, slash),
                name: key.slice(slash + 1),
                path: recipe.path,
                ...(recipe.description === undefined ? {} : { description: recipe.description }),
            };
        }),
    };
}

/** A name matcher over `host.globs`: a glob matches with dots allowed, exactly first, then ignoring case. */
export function globNameMatcher(globs: Pick<HostGlobs, "hasGlob" | "isMatch">): NameMatcher {
    const isMatch = (known: string, pattern: string, nocase: boolean): boolean => globs.isMatch(known, pattern, { nocase, dot: true });

    return (written, known) => {
        if (isGlobName(written, globs)) {
            if (isMatch(known, written, false)) {
                return "exact";
            }

            return isMatch(known, written, true) ? "folded" : undefined;
        }

        if (written === known) {
            return "exact";
        }

        return written.toLowerCase() === known.toLowerCase() ? "folded" : undefined;
    };
}

/** The weaker of two matches: one folded part makes the whole thing folded. */
function both(left: NameMatch, right: NameMatch): NameMatch {
    if (left === undefined || right === undefined) {
        return undefined;
    }

    return left === "folded" || right === "folded" ? "folded" : "exact";
}

function knownRepo(repo: IndexCatalogRepo, revision?: string): RepoRef {
    return {
        kind: "repo",
        ...(repo.name === undefined ? {} : { name: repo.name }),
        ...(repo.location === undefined ? {} : { location: repo.location }),
        ...(revision === undefined ? {} : { revision }),
    };
}

function knownRecipe(repo: IndexCatalogRepo, recipe: IndexCatalogRepo["recipes"][number], revision?: string): RecipeRef {
    const namespace: NamespaceRef = { kind: "namespace", name: recipe.namespace, repo: knownRepo(repo, revision) };

    return { kind: "recipe", name: recipe.name, namespace, ...(recipe.description === undefined ? {} : { description: recipe.description }) };
}

/** What a candidate carries over to the ref it matched: its range and query values. */
function carry(candidate: SousRef, known: SousRef): SousRef {
    return {
        ...known,
        ...(candidate.kind === "recipe" && candidate.range !== undefined ? { range: candidate.range } : {}),
        ...(candidate.vars === undefined ? {} : { vars: candidate.vars }),
    } as SousRef;
}

/** How a repository qualifier matches one catalog repository; no qualifier matches every one. */
function qualifies(qualifier: RepoRef | undefined, repo: IndexCatalogRepo, matchName: NameMatcher): NameMatch {
    if (qualifier === undefined) {
        return "exact";
    }

    let result: NameMatch = "exact";

    if (qualifier.name !== undefined) {
        if (repo.name === undefined) {
            return undefined;
        }

        result = matchName(qualifier.name, repo.name);

        if (result === undefined) {
            return undefined;
        }
    }

    if (qualifier.location !== undefined && repo.location?.identity !== qualifier.location.identity) {
        return undefined;
    }

    return result;
}

/**
 * What a browser path names in one repository, through the folder each recipe lives in. The path
 * still carries the branch in front (which may hold slashes), so every split is tried: a recipe's
 * folder, or anything inside it, names that recipe; a folder holding recipes of exactly one
 * namespace names that namespace.
 *
 * ```ts
 * settleBrowsed("main/recipes/workflow/alpha/SKILL.md");
 * // the recipe workflow/alpha, with the revision "main"
 * ```
 */
function settleBrowsed(candidate: RepoRef, repo: IndexCatalogRepo): SousRef[] {
    if (candidate.location === undefined || repo.location?.identity !== candidate.location.identity) {
        return [];
    }

    const segments = (candidate.browsed ?? "").split("/").filter((segment) => segment.length > 0);
    const recipes = repo.recipes.map((recipe) => ({ recipe, path: (recipe.path ?? "").replace(/^\.?\/+|\/+$/g, "") })).filter((entry) => entry.path.length > 0);
    const range = candidate.range === undefined ? {} : { range: candidate.range };
    const found = new Map<string, SousRef>();

    // A recipe's folder, or a file inside it. The deepest recipe wins.
    for (let start = 1; start < segments.length; start++) {
        const folder = segments.slice(start).join("/");
        const deepest = recipes
            .filter((entry) => folder === entry.path || folder.startsWith(`${entry.path}/`))
            .sort((left, right) => right.path.length - left.path.length)[0];

        if (deepest !== undefined) {
            found.set(`${deepest.recipe.namespace}/${deepest.recipe.name}`, { ...knownRecipe(repo, deepest.recipe, segments.slice(0, start).join("/")), ...range });
        }
    }

    if (found.size > 0) {
        return [...found.values()];
    }

    // A folder above recipes: a namespace, when everything under it is one.
    for (let start = 1; start < segments.length; start++) {
        const folder = segments.slice(start).join("/");
        const namespaces = new Set(recipes.filter((entry) => entry.path.startsWith(`${folder}/`)).map((entry) => entry.recipe.namespace));

        if (namespaces.size === 1) {
            const name = [...namespaces][0]!;

            found.set(name, { kind: "namespace", name, repo: knownRepo(repo, segments.slice(0, start).join("/")) });
        }
    }

    return [...found.values()];
}

/** The recipes of one repository a recipe candidate names. */
function matchRecipes(candidate: RecipeRef, repo: IndexCatalogRepo, matchName: NameMatcher): Array<[RecipeRef, NameMatch]> {
    const qualifier = qualifies(candidate.namespace?.repo ?? candidate.repo, repo, matchName);

    return repo.recipes.map((recipe) => {
        const inNamespace = candidate.namespace === undefined ? "exact" : matchName(candidate.namespace.name, recipe.namespace);

        return [carry(candidate, knownRecipe(repo, recipe)) as RecipeRef, both(both(qualifier, inNamespace), matchName(candidate.name, recipe.name))];
    });
}

/**
 * Every repository, namespace, recipe or recipe file in the catalog a candidate names, in
 * repository order, then by key. Candidates of any other kind match nothing.
 */
export function matchIndexes(repos: readonly IndexCatalogRepo[], candidate: SousRef, tools: IndexMatchTools): RefMatch[] {
    const found: Array<RefMatch & { repoIndex: number }> = [];

    repos.forEach((repo, repoIndex) => {
        const add = (ref: SousRef, spelling: NameMatch): void => {
            if (spelling !== undefined) {
                found.push({ ref, exactSpelling: spelling === "exact", repoIndex });
            }
        };

        switch (candidate.kind) {
            case "repo":
                if (candidate.browsed !== undefined) {
                    for (const settled of settleBrowsed(candidate, repo)) {
                        add(settled, "exact");
                    }
                } else if (candidate.name !== undefined || candidate.location !== undefined) {
                    add({ ...knownRepo(repo), ...(candidate.vars === undefined ? {} : { vars: candidate.vars }) }, qualifies(candidate, repo, tools.matchName));
                }

                break;
            case "namespace": {
                const qualifier = qualifies(candidate.repo, repo, tools.matchName);

                for (const namespace of repo.namespaces) {
                    add(
                        carry(candidate, { kind: "namespace", name: namespace.name, repo: knownRepo(repo), ...(namespace.description === undefined ? {} : { description: namespace.description }) }),
                        both(qualifier, tools.matchName(candidate.name, namespace.name)),
                    );
                }

                break;
            }
            case "recipe":
                for (const [ref, spelling] of matchRecipes(candidate, repo, tools.matchName)) {
                    add(ref, spelling);
                }

                break;
            case "recipeFile":
                for (const [recipe, spelling] of matchRecipes(candidate.recipe, repo, tools.matchName)) {
                    add({ ...candidate, recipe }, spelling);
                }

                break;
            default:
                break;
        }
    });

    return found
        .sort((left, right) => {
            if (left.repoIndex !== right.repoIndex) {
                return left.repoIndex - right.repoIndex;
            }

            const a = tools.key(left.ref);
            const b = tools.key(right.ref);

            return a < b ? -1 : a > b ? 1 : 0;
        })
        .map(({ ref, exactSpelling }) => ({ ref, exactSpelling }));
}

/** The matching tools, from the services in force. */
function toolsOf(ctx: ServiceContext): IndexMatchTools {
    const globs = ctx.services.get("host.globs");
    const format = ctx.services.get("refs.format");

    return {
        matchName: globNameMatcher(globs),
        key: (ref) => format.key(ref),
    };
}

/** Where a trusted repository lives, when a host reads its URL. */
function locationOfEntry(ctx: ServiceContext, entry: RepoEntry | undefined): RefLocation | undefined {
    if (entry === undefined) {
        return undefined;
    }

    try {
        return ctx.services.get("refs.locations").fromUrl(entry.url, entry.provider);
    } catch {
        return undefined;
    }
}

/** The trusted repositories in search order, each with its location. */
function trustedInOrder(ctx: ServiceContext): Array<{ name: string; location: RefLocation | undefined }> {
    const trusted = trustedRepos(ctx.config);

    return repoSearchOrder(ctx).map((name) => ({ name, location: locationOfEntry(ctx, trusted[name]) }));
}

/** Whether the services the lookups read exist; while the config is built they do not. */
function ready(ctx: ServiceContext): boolean {
    return ctx.services.has("recipes.index-cache") && ctx.services.has("refs.format") && ctx.services.has("host.globs");
}

/** The catalog of every index cached on this machine for the project's trusted repositories. */
function cachedCatalog(ctx: ServiceContext): IndexCatalogRepo[] {
    const cache = ctx.services.get("recipes.index-cache");
    const repos: IndexCatalogRepo[] = [];

    for (const { name, location } of trustedInOrder(ctx)) {
        let cached;

        try {
            cached = cache.cached(name);
        } catch {
            cached = undefined;
        }

        if (cached !== undefined) {
            repos.push(catalogRepoOfIndex(cached.index, { name, ...(location === undefined ? {} : { location }) }));
        }
    }

    return repos;
}

/** The `ref-lookup` entity over the indexes cached on this machine. */
export function cachedIndexLookup(): RefLookupEntity {
    const findSync = (candidate: SousRef, ctx: ServiceContext): RefMatch[] => {
        if (!ready(ctx)) {
            return [];
        }

        try {
            return matchIndexes(cachedCatalog(ctx), candidate, toolsOf(ctx));
        } catch {
            // A cached index that cannot be read knows nothing; this lookup never fails.
            return [];
        }
    };

    return {
        id: CACHED_INDEX_LOOKUP_ID,
        description: "the repository indexes cached on this machine",
        kinds: ["repo", "namespace", "recipe", "recipeFile"],
        tags: ["cached", "index"],
        find: async (candidate, ctx) => findSync(candidate, ctx),
        findSync,
    };
}

/** What the fetched-index lookup is built with; tests hand in a reader. */
export interface FetchedIndexLookupOptions {
    /**
     * Reads the index of a repository upstream. Default: `recipes.index-cache`, through the
     * project's short name when the repository is trusted (refreshing the cached copy), otherwise
     * read without writing anything.
     */
    readonly read?: (ctx: ServiceContext, repo: { name?: string; location: RefLocation }) => Promise<IndexFile>;
    readonly now?: () => number;
}

/** Reads an index the default way. */
async function readThroughCache(ctx: ServiceContext, repo: { name?: string; location: RefLocation }): Promise<IndexFile> {
    const cache = ctx.services.get("recipes.index-cache");

    if (repo.name !== undefined) {
        return (await cache.get(repo.name, { latest: true })).index;
    }

    const core = (cache as { core?: { fetchUpstream(target: { name: string; url: string; identity: string; provider?: string }): Promise<IndexFile> } }).core;

    if (core === undefined) {
        throw new ConfigError(`Sous cannot read the index of ${repo.location.url}: the index cache in use reads only repositories this project trusts.`);
    }

    return core.fetchUpstream({ name: repo.location.identity, url: repo.location.url, identity: repo.location.identity, provider: repo.location.provider });
}

/**
 * The `ref-lookup` entity reading indexes upstream. Opt-in: asked when a caller names it or the
 * `latest` tag. Each repository's index is read once and reused for a minute.
 */
export function fetchedIndexLookup(options: FetchedIndexLookupOptions = {}): RefLookupEntity {
    const read = options.read ?? readThroughCache;
    const now = options.now ?? Date.now;
    const reads = new Map<string, { at: number; index: Promise<IndexFile> }>();

    const indexOf = (ctx: ServiceContext, repo: { name?: string; location: RefLocation }): Promise<IndexFile> => {
        const id = repo.location.identity;
        const known = reads.get(id);

        if (known !== undefined && now() - known.at < FETCHED_INDEX_REUSE_MS) {
            return known.index;
        }

        const index = read(ctx, repo);

        reads.set(id, { at: now(), index });
        index.catch(() => reads.delete(id));

        return index;
    };

    return {
        id: FETCHED_INDEX_LOOKUP_ID,
        description: "the repository indexes, read upstream",
        kinds: ["repo", "namespace", "recipe", "recipeFile"],
        tags: ["latest", "index"],
        optIn: true,

        async find(candidate, ctx) {
            if (!ready(ctx)) {
                return [];
            }

            const tools = toolsOf(ctx);
            const trusted = trustedInOrder(ctx);
            const location = locationOf(candidate);

            if (location !== undefined) {
                const name = trusted.find((repo) => repo.location?.identity === location.identity)?.name;
                let index: IndexFile;

                try {
                    index = await indexOf(ctx, { ...(name === undefined ? {} : { name }), location });
                } catch (error) {
                    const folder = candidate.kind === "repo" && candidate.browsed !== undefined;

                    throw new ConfigError(
                        `The ref reads ${folder ? "as a folder in" : "as something in"} the repository at ${location.url}, and its index could not be read, so sous cannot settle what it means.`,
                        { details: ["Sous never guesses past an index it could not read.", describeError(error)] },
                    );
                }

                return matchIndexes([catalogRepoOfIndex(index, { ...(name === undefined ? {} : { name }), location })], candidate, tools);
            }

            const repos: IndexCatalogRepo[] = [];

            for (const { name, location: at } of trusted) {
                if (at === undefined) {
                    continue;
                }

                try {
                    repos.push(catalogRepoOfIndex(await indexOf(ctx, { name, location: at }), { name, location: at }));
                } catch {
                    // A repository that cannot be read answers nothing here; the cached lookup still may.
                }
            }

            return matchIndexes(repos, candidate, tools);
        },
    };
}
