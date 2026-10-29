/**
 * A stand-in for the index lookups plugin-recipes adds: a `ref-lookup` entity over a list of
 * repositories, each with its namespaces and recipes, matched the way today's `CatalogMatcher`
 * matches them (exact spelling first, ignoring case otherwise, browser paths settled through each
 * recipe's folder).
 */

import { refKey } from "../src/format.js";
import type { NamespaceRef, RecipeRef, RefLocation, RefLookupEntity, RefMatch, RepoRef, SousRef } from "../src/types.js";

/** One repository a catalog knows. */
export interface CatalogRepo {
    name?: string;
    location?: RefLocation;
    namespaces: Array<{ name: string; description?: string }>;
    recipes: Array<{ namespace: string; name: string; description?: string; path?: string }>;
}

type NameMatch = "exact" | "folded" | undefined;

/** A glob as a regular expression: `*` and `?` only, which is all these tests write. */
function globPattern(pattern: string, flags: string): RegExp {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".");

    return new RegExp(`^${body}$`, flags);
}

function matchName(written: string, known: string): NameMatch {
    if (/[*?]/.test(written)) {
        if (globPattern(written, "").test(known)) {
            return "exact";
        }

        return globPattern(written, "i").test(known) ? "folded" : undefined;
    }

    if (written === known) {
        return "exact";
    }

    return written.toLowerCase() === known.toLowerCase() ? "folded" : undefined;
}

function both(left: NameMatch, right: NameMatch): NameMatch {
    if (left === undefined || right === undefined) {
        return undefined;
    }

    return left === "folded" || right === "folded" ? "folded" : "exact";
}

function qualifies(qualifier: RepoRef | undefined, repo: CatalogRepo): NameMatch {
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

function knownRepo(repo: CatalogRepo, revision?: string): RepoRef {
    return {
        kind: "repo",
        ...(repo.name === undefined ? {} : { name: repo.name }),
        ...(repo.location === undefined ? {} : { location: repo.location }),
        ...(revision === undefined ? {} : { revision }),
    };
}

function knownRecipe(repo: CatalogRepo, recipe: CatalogRepo["recipes"][number], revision?: string): RecipeRef {
    const namespace: NamespaceRef = { kind: "namespace", name: recipe.namespace, repo: knownRepo(repo, revision) };

    return { kind: "recipe", name: recipe.name, namespace, ...(recipe.description === undefined ? {} : { description: recipe.description }) };
}

function carry(candidate: SousRef, known: SousRef): SousRef {
    return {
        ...known,
        ...(candidate.kind === "recipe" && candidate.range !== undefined ? { range: candidate.range } : {}),
        ...(candidate.vars === undefined ? {} : { vars: candidate.vars }),
    } as SousRef;
}

function settleBrowsed(candidate: RepoRef, repo: CatalogRepo): SousRef[] {
    if (candidate.location === undefined || repo.location?.identity !== candidate.location.identity) {
        return [];
    }

    const segments = (candidate.browsed ?? "").split("/").filter((segment) => segment.length > 0);
    const recipes = repo.recipes
        .map((recipe) => ({ recipe, path: (recipe.path ?? "").replace(/^\.?\/+|\/+$/g, "") }))
        .filter((entry) => entry.path.length > 0);
    const range = candidate.range === undefined ? {} : { range: candidate.range };
    const found = new Map<string, SousRef>();

    for (let start = 1; start < segments.length; start++) {
        const folder = segments.slice(start).join("/");
        const deepest = recipes
            .filter((entry) => folder === entry.path || folder.startsWith(`${entry.path}/`))
            .sort((left, right) => right.path.length - left.path.length)[0];

        if (deepest !== undefined) {
            found.set(`${deepest.recipe.namespace}/${deepest.recipe.name}`, {
                ...knownRecipe(repo, deepest.recipe, segments.slice(0, start).join("/")),
                ...range,
            });
        }
    }

    return [...found.values()];
}

/** Every known ref a candidate names in the catalog, in repository order, then by key. */
export function matchCatalog(repos: readonly CatalogRepo[], candidate: SousRef): RefMatch[] {
    const found: Array<RefMatch & { repoIndex: number }> = [];

    repos.forEach((repo, repoIndex) => {
        const add = (ref: SousRef, spelling: NameMatch): void => {
            if (spelling !== undefined) {
                found.push({ ref, exactSpelling: spelling === "exact", repoIndex });
            }
        };

        if (candidate.kind === "repo") {
            if (candidate.browsed !== undefined) {
                for (const settled of settleBrowsed(candidate, repo)) {
                    add(settled, "exact");
                }
            } else if (candidate.name !== undefined || candidate.location !== undefined) {
                add({ ...knownRepo(repo), ...(candidate.vars === undefined ? {} : { vars: candidate.vars }) }, qualifies(candidate, repo));
            }
        }

        if (candidate.kind === "namespace") {
            const qualifier = qualifies(candidate.repo, repo);

            for (const namespace of repo.namespaces) {
                add(
                    carry(candidate, { kind: "namespace", name: namespace.name, repo: knownRepo(repo), ...(namespace.description === undefined ? {} : { description: namespace.description }) }),
                    both(qualifier, matchName(candidate.name, namespace.name)),
                );
            }
        }

        if (candidate.kind === "recipe") {
            const qualifier = qualifies(candidate.namespace?.repo ?? candidate.repo, repo);

            for (const recipe of repo.recipes) {
                const inNamespace = candidate.namespace === undefined ? "exact" : matchName(candidate.namespace.name, recipe.namespace);

                add(carry(candidate, knownRecipe(repo, recipe)), both(both(qualifier, inNamespace), matchName(candidate.name, recipe.name)));
            }
        }
    });

    return found
        .sort((left, right) => left.repoIndex - right.repoIndex || (refKey(left.ref) < refKey(right.ref) ? -1 : refKey(left.ref) > refKey(right.ref) ? 1 : 0))
        .map(({ ref, exactSpelling }) => ({ ref, exactSpelling }));
}

/** A `ref-lookup` entity over a catalog, answering both ways. */
export function catalogLookup(repos: readonly CatalogRepo[], extra: Partial<RefLookupEntity> = {}): RefLookupEntity {
    return {
        id: "catalog",
        kinds: ["repo", "namespace", "recipe"],
        tags: ["latest"],
        find: (candidate) => Promise.resolve(matchCatalog(repos, candidate)),
        findSync: (candidate) => matchCatalog(repos, candidate),
        ...extra,
    };
}

/** A repository publishing the given `namespace/recipe` keys, each with a description. */
export function catalogRepo(name: string, keys: string[], extraNamespaces: string[] = []): CatalogRepo {
    const namespaces = new Set(extraNamespaces);
    const recipes = keys.map((key) => {
        const slash = key.indexOf("/");

        namespaces.add(key.slice(0, slash));

        return { namespace: key.slice(0, slash), name: key.slice(slash + 1), description: `The ${key} recipe` };
    });

    return { name, namespaces: [...namespaces].map((namespace) => ({ name: namespace })), recipes };
}
