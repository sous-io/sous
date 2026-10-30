/**
 * Planning an update of pinned versions (S6, `recipe.update`; C60; ported from `planUpdate` and its
 * helpers in `src/lib/repos/subscription-service.ts`). It writes nothing.
 *
 * Every trusted repository's index is read fresh; one that cannot be reached is reported, and its
 * pins stay. A ref narrows what may move; everything outside it is held at its locked version for as
 * long as its ranges allow. Subscriptions sous provides itself (`core`) never move: their range is
 * the running sous version. Switched-off subscriptions take no part, and keep their pins (S4, 2).
 */

import { SousError, type Context } from "@sous-io/plugin-api";
import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import type { MissingRepo, RecipeRequest, RecipeUpdateInput, RecipeUpdatePlan, RecipeUpdateScope, ResolvedRecipe } from "../types.js";
import { findInCatalog, namespaceOfKey, type CatalogInputs } from "./catalog.js";
import { identityOf, pickMatch, readingsOf, repoSearchOrder } from "./catalog-context.js";
import { isBuiltInEntry } from "./defaults.js";
import { applyResolution, keysHeldBySubscription, lockedClosure, mergeHolders, PROJECT_HOLDER, releaseDroppedHolds, type LockRepoInput } from "./lock-holds.js";
import { configuredSubscriptions, enabledSubscriptions, trustedRepos } from "./project.js";
import { compareBytewise, describeError, sortBytewise } from "./util.js";

/** The scope in words, for a sentence that says what was updated. */
export function describeUpdateScope(scope: RecipeUpdateScope): string {
    switch (scope.kind) {
        case "all":
            return "every subscription in this project";
        case "repository":
            return `the recipes this project takes from the repository '${scope.repo}'`;
        case "namespace":
            return `the recipes in the namespace '${scope.repo}:${scope.namespace}'`;
        case "recipe":
            return `the recipe '${scope.repo}:${scope.key}'`;
    }
}

/** Whether a locked recipe falls inside an update's scope. */
export function recipeInScope(scope: RecipeUpdateScope, key: string, repo: string): boolean {
    switch (scope.kind) {
        case "all":
            return true;
        case "repository":
            return repo === scope.repo;
        case "namespace":
            return repo === scope.repo && namespaceOfKey(key) === scope.namespace;
        case "recipe":
            return repo === scope.repo && key === scope.key;
    }
}

/** Whether a subscription key's cover falls inside the scope, by its key alone. */
function coverInScope(scope: RecipeUpdateScope, cover: string, qualifier: string | undefined): boolean {
    if (scope.kind === "all") {
        return true;
    }

    if (qualifier !== undefined && qualifier !== scope.repo) {
        return false;
    }

    switch (scope.kind) {
        case "repository":
            return qualifier === scope.repo;
        case "namespace":
            return cover === scope.namespace || cover.startsWith(`${scope.namespace}/`);
        case "recipe":
            return cover === scope.key || scope.key.startsWith(`${cover}/`);
    }
}

/** True when nothing would change: no pin moves and no new repository is needed. */
export function isEmptyUpdate(plan: Pick<RecipeUpdatePlan, "diff" | "missingRepos">): boolean {
    return plan.diff.unchanged && plan.missingRepos.length === 0;
}

/** Every trusted repository's index, read from upstream; unreachable ones fall back to the cache. */
async function freshIndexes(ctx: Context): Promise<{ indexes: Map<string, IndexFile>; unreachable: Array<{ repo: string; reason: string }>; urls: Map<string, string | undefined> }> {
    const cache = ctx.services.get("recipes.index-cache");
    const repos = trustedRepos(ctx.config);
    const indexes = new Map<string, IndexFile>();
    const unreachable: Array<{ repo: string; reason: string }> = [];

    for (const name of repoSearchOrder(ctx)) {
        try {
            const read = await cache.get(name, { latest: true });

            // Upstream failed and the cached copy came back instead: plan with it, and say so.
            if (read.source === "stale") {
                unreachable.push({ repo: name, reason: (read as { problem?: string }).problem ?? "The repository could not be reached." });
            }

            indexes.set(name, read.index);
        } catch (error) {
            unreachable.push({ repo: name, reason: describeError(error) });

            const cached = cache.cached(name);

            if (cached !== undefined) {
                indexes.set(name, cached.index);
            }
        }
    }

    return { indexes, unreachable, urls: new Map(Object.entries(repos).map(([name, entry]) => [name, entry.url])) };
}

/** Settles what an update covers: everything, or the repository, namespace or recipe a ref names. */
export async function resolveUpdateScope(ctx: Context, input: RecipeUpdateInput, catalog: CatalogInputs): Promise<RecipeUpdateScope> {
    if (input.ref === undefined || input.ref.trim() === "") {
        return { kind: "all" };
    }

    const readings = readingsOf(ctx, input.ref);
    const trusted = trustedRepos(ctx.config);

    for (const reading of readings) {
        if (reading.kind !== "repo") {
            continue;
        }

        if (reading.name !== undefined && Object.hasOwn(trusted, reading.name)) {
            return { kind: "repository", repo: reading.name };
        }

        const identity = reading.location?.identity.toLowerCase();
        const byIdentity = catalog.repos.find((repo) => identity !== undefined && repo.identity?.toLowerCase() === identity);

        if (byIdentity !== undefined) {
            return { kind: "repository", repo: byIdentity.name };
        }
    }

    const matches = findInCatalog(catalog, readings, ["namespace", "recipe"]);
    const chosen = await pickMatch(ctx, matches, input.ref.trim(), input.acceptFirst, () => {
        return new SousError(`No trusted repository, namespace or recipe is called '${input.ref}'.`, {
            details: [`Searched: ${catalog.repos.map((repo) => repo.name).join(", ") || "nothing (no index could be read)"}.`],
        });
    });

    return chosen.ref.kind === "namespace"
        ? { kind: "namespace", repo: chosen.repo.name, namespace: chosen.key }
        : { kind: "recipe", repo: chosen.repo.name, key: chosen.key };
}

/** `recipe.update`: what the lockfile would become, and everything worth knowing first. */
export async function planUpdate(input: RecipeUpdateInput, ctx: Context): Promise<RecipeUpdatePlan> {
    const lockService = ctx.services.get("recipes.lock");
    const resolver = ctx.services.get("recipes.resolver");
    const format = ctx.services.get("refs.format");
    const { indexes, unreachable, urls } = await freshIndexes(ctx);
    const catalog: CatalogInputs = {
        repos: [...indexes.entries()].map(([name, index]) => {
            const url = urls.get(name);
            const identity = url === undefined ? undefined : identityOf(ctx, url);

            return { name, index, ...(url === undefined ? {} : { url }), ...(identity === undefined ? {} : { identity }) };
        }),
        lock: lockService.read(),
        subscriptions: [],
    };
    const scope = await resolveUpdateScope(ctx, input, catalog);
    const before = catalog.lock;
    const configured = configuredSubscriptions(ctx.config);
    const subscriptions = enabledSubscriptions(ctx.config);
    const unreachableNames = new Set(unreachable.map((entry) => entry.repo));
    const builtInKeys = Object.keys(subscriptions).filter((key) => isBuiltInEntry(subscriptions[key]));
    const builtInHeld = new Set(builtInKeys.flatMap((key) => keysHeldBySubscription(before, key)));

    const movable = (key: string, repo: string): boolean => !unreachableNames.has(repo) && !builtInHeld.has(key) && recipeInScope(scope, key, repo);
    const keep: Record<string, string> = {};

    for (const [key, entry] of Object.entries(before.recipes)) {
        if (!movable(key, entry.repo)) {
            keep[key] = entry.version;
        }
    }

    const coverOf = (key: string): { cover: string; qualifier: string | undefined } | undefined => {
        try {
            const ref = format.parseNamedRef(key, "config");

            return { cover: format.key(ref), qualifier: format.partsOf(ref).repo?.name };
        } catch {
            return undefined;
        }
    };

    const touches = (key: string): boolean => {
        if (scope.kind === "all") {
            return true;
        }

        const parsed = coverOf(key);

        if (parsed === undefined) {
            return false;
        }

        const closure = lockedClosure(before, keysHeldBySubscription(before, parsed.cover));

        return closure.some((held) => movable(held, before.recipes[held]!.repo)) || coverInScope(scope, parsed.cover, parsed.qualifier);
    };

    const targets = sortBytewise(Object.keys(subscriptions)).filter((key) => !isBuiltInEntry(subscriptions[key]) && touches(key));
    const merged = new Map<string, ResolvedRecipe>();
    const resolvedSubscriptions: string[] = [];
    const missing = new Map<string, MissingRepo>();
    const failed: Array<{ key: string; reason: string }> = [];
    const cycles: string[][] = [];
    const unreadable = new Set<string>();

    for (const key of targets) {
        const entry = subscriptions[key]!;
        let request: RecipeRequest;

        try {
            request = {
                ref: format.parseNamedRef(key, "config"),
                ...(entry.range === undefined ? {} : { range: entry.range }),
                ...(entry.prerelease === true ? { prerelease: true } : {}),
                requestedBy: PROJECT_HOLDER,
                kind: "subscribes",
            };
        } catch (error) {
            failed.push({ key, reason: describeError(error) });
            continue;
        }

        let result;

        try {
            result = await resolver.resolve([request], { keep, indexes, ...(entry.prerelease === true ? { prerelease: true } : {}) });
        } catch (error) {
            failed.push({ key, reason: describeError(error) });
            continue;
        }

        cycles.push(...result.cycles);
        result.unreadable.forEach((item) => unreadable.add(item));

        for (const repo of result.missingRepos) {
            const known = missing.get(repo.name);

            missing.set(repo.name, known === undefined ? repo : { ...known, requiredBy: [...known.requiredBy, ...repo.requiredBy] });
        }

        const conflict = result.resolved.find((recipe) => merged.has(recipe.key) && merged.get(recipe.key)!.version !== recipe.version);

        if (conflict !== undefined) {
            failed.push({ key, reason: `It wants version ${conflict.version} of '${conflict.key}', and another subscription wants ${merged.get(conflict.key)!.version}.` });
            continue;
        }

        for (const recipe of result.resolved) {
            const already = merged.get(recipe.key);

            merged.set(recipe.key, already === undefined ? recipe : mergeHolders(already, recipe));
        }

        resolvedSubscriptions.push(key);
    }

    const repoInputs: Record<string, LockRepoInput> = {};

    for (const [name, url] of urls) {
        if (url !== undefined) {
            const identity = identityOf(ctx, url);

            repoInputs[name] = { url, ...(identity === undefined ? {} : { identity }) };
        }
    }

    const settled = [...merged.values()];
    const covers = (keys: readonly string[]): string[] => keys.map((key) => coverOf(key)?.cover).filter((cover): cover is string => cover !== undefined);
    const after = releaseDroppedHolds(
        applyResolution(before, settled, repoInputs),
        merged,
        covers(resolvedSubscriptions),
        covers(Object.keys(configured).filter((key) => !resolvedSubscriptions.includes(key))),
    );
    const changed = settled.filter((recipe) => before.recipes[recipe.key]?.version !== recipe.version);
    const links = ctx.services.has("recipes.links") ? ctx.services.get("recipes.links") : undefined;

    return {
        scope,
        diff: lockService.diff(before, after),
        lockfile: after,
        missingRepos: [...missing.values()].sort((left, right) => compareBytewise(left.name, right.name)),
        newVariables: newVariables(changed, before, indexes),
        unreadable: sortBytewise(unreadable),
        unreachable,
        linked: sortBytewise(new Set(changed.map((recipe) => recipe.repo).filter((repo) => links?.get(repo) !== undefined))),
        builtIn: builtInKeys
            .filter((key) => keysHeldBySubscription(before, key).some((held) => recipeInScope(scope, held, before.recipes[held]!.repo)))
            .map((key) => ({ key, ...(subscriptions[key]?.range === undefined ? {} : { version: subscriptions[key]!.range }) })),
        switchedOff: sortBytewise(
            Object.keys(configured).filter((key) => {
                const parsed = coverOf(key);

                return configured[key]?.enabled === false && parsed !== undefined && coverInScope(scope, parsed.cover, parsed.qualifier);
            }),
        ),
        failed,
        cycles,
    };
}

/** Variables a changed recipe's new version declares that its pinned version did not. */
function newVariables(changed: readonly ResolvedRecipe[], before: Lockfile, indexes: ReadonlyMap<string, IndexFile>): Array<{ recipe: string; name: string }> {
    const found: Array<{ recipe: string; name: string }> = [];

    for (const recipe of changed) {
        const pinned = before.recipes[recipe.key];
        const old = pinned === undefined ? undefined : indexes.get(pinned.repo)?.recipes[recipe.key]?.versions[pinned.version]?.variables;
        const known = new Set((old ?? []).map((variable) => variable.name));

        for (const variable of recipe.variables ?? []) {
            if (!known.has(variable.name)) {
                found.push({ recipe: recipe.key, name: variable.name });
            }
        }
    }

    return found;
}
