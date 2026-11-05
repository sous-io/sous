/**
 * Planning an update of pinned versions. It writes nothing.
 *
 * Every trusted repository's index is read fresh; one that cannot be reached is reported, and its
 * pins stay. A ref narrows what may move; everything outside it is held at its locked version for as
 * long as its ranges allow. Subscriptions sous provides itself (`core`) follow the installed sous:
 * their range is exactly the running sous version, so their pins move only when the lockfile pins
 * another version, whatever the ref names, as the next build would move them anyway. Switched-off
 * subscriptions take no part, and keep their pins.
 */

import { SousError, type Context } from "@sous-io/plugin-api";
import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import type { IndexReadFailure, PlannedQuestion, RecipeRequest, RecipeUpdateInput, RecipeUpdatePlan, RecipeUpdateScope, ResolvedRecipe, ResolveResult } from "../types.js";
import { findInCatalog, namespaceOfKey, type CatalogInputs } from "./catalog.js";
import { identityOf, pickMatch, readingsOf, repoSearchOrder } from "./catalog-context.js";
import { isBuiltInEntry } from "./defaults.js";
import { applyResolution, builtInMoves, keysHeldBySubscription, lockedClosure, PROJECT_HOLDER, releaseDroppedHolds, type LockRepoInput } from "./lock-holds.js";
import { definedVariables, plannedQuestionsOf } from "./questions.js";
import { configuredSubscriptions, enabledSubscriptions, trustedRepos } from "./project.js";
import { compareBytewise, describeError, sortBytewise } from "./util.js";
import { NoVersionSatisfiesError } from "../part-b/resolver/resolve.js";
import { IndexReadError, readFailureSentence } from "../part-b/index-cache/read-chain.js";

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

/**
 * The headline of a plan that moves no pin. When an index could not be read, it does not claim
 * every pin is the newest, since the pins from that repository were not checked (#204 bug 33).
 *
 * ```ts
 * emptyUpdateHeadline({ scope: { kind: "all" }, unreachable: [{ repo: "sous-recipes", ... }], checked: [] });
 * // -> "Sous could not check for updates: it could not read the index of 'sous-recipes'."
 * ```
 */
export function emptyUpdateHeadline(plan: Pick<RecipeUpdatePlan, "scope" | "unreachable" | "checked">): string {
    if (plan.unreachable.length === 0) {
        return `Nothing to update: every pin in ${describeUpdateScope(plan.scope)} is already the newest published version its range allows.`;
    }

    const names = plan.unreachable.map((entry) => `'${entry.repo}'`);
    const listed = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const indexes = names.length === 1 ? `the index of ${listed}` : `the indexes of ${listed}`;

    if ((plan.checked ?? []).length === 0) {
        return `Sous could not check for updates: it could not read ${indexes}.`;
    }

    return `No updates found in the repositories sous could read. It could not read ${indexes}, so the pins from ${names.length === 1 ? "it" : "them"} were not checked.`;
}

/**
 * Why an index could not be read: a failed read through the host's strategies as one full sentence
 * naming each attempt, any other error as its own message.
 */
function unreadableReason(failure: IndexReadFailure | undefined, problem: string | undefined): string {
    if (failure !== undefined) {
        return readFailureSentence(failure);
    }

    return problem === undefined || problem.trim() === "" ? "The repository could not be reached." : problem;
}

/** Every trusted repository's index, read from upstream; unreachable ones fall back to the cache. */
async function freshIndexes(
    ctx: Context,
): Promise<{ indexes: Map<string, IndexFile>; unreachable: Array<{ repo: string; reason: string }>; checked: string[]; urls: Map<string, string | undefined> }> {
    const cache = ctx.services.get("recipes.index-cache");
    const repos = trustedRepos(ctx.config);
    const indexes = new Map<string, IndexFile>();
    const unreachable: Array<{ repo: string; reason: string }> = [];
    const checked: string[] = [];

    for (const name of repoSearchOrder(ctx)) {
        try {
            const read = await cache.get(name, { latest: true });

            // Upstream failed and the cached copy came back instead: plan with it, and say so.
            if (read.source === "stale") {
                const stale = read as { problem?: string; failure?: IndexReadFailure };

                unreachable.push({ repo: name, reason: unreadableReason(stale.failure, stale.problem) });
            } else {
                checked.push(name);
            }

            indexes.set(name, read.index);
        } catch (error) {
            unreachable.push({ repo: name, reason: unreadableReason(error instanceof IndexReadError ? error.failure : undefined, describeError(error)) });

            const cached = cache.cached(name);

            if (cached !== undefined) {
                indexes.set(name, cached.index);
            }
        }
    }

    return { indexes, unreachable, checked, urls: new Map(Object.entries(repos).map(([name, entry]) => [name, entry.url])) };
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
    const { indexes, unreachable, checked, urls } = await freshIndexes(ctx);
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
    // The built-in pins the installed sous moves: those are resolved again, and nothing else of theirs.
    const moves = builtInMoves(before, subscriptions);
    const moving = new Set(moves.map((move) => move.key));
    const builtInMoving = new Set(moves.map((move) => move.subscription));

    const movable = (key: string, repo: string): boolean => moving.has(key) || (!unreachableNames.has(repo) && !builtInHeld.has(key) && recipeInScope(scope, key, repo));
    const held = lockService.held(
        before,
        Object.entries(before.recipes)
            .filter(([key, entry]) => movable(key, entry.repo))
            .map(([key]) => key),
    );

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

    const targets = sortBytewise(Object.keys(subscriptions)).filter((key) => (isBuiltInEntry(subscriptions[key]) ? builtInMoving.has(key) : touches(key)));
    const failed: Array<{ key: string; reason: string }> = [];
    const requests: Array<{ key: string; request: RecipeRequest }> = [];

    for (const key of targets) {
        try {
            requests.push({ key, request: resolver.subscriptionRequest(key) });
        } catch (error) {
            failed.push({ key, reason: describeError(error) });
        }
    }

    const together = await resolveTogether(requests, (asked) => resolver.resolve(asked, { ...held, indexes }));
    const resolvedSubscriptions = together.resolved;
    const result = together.result;
    const merged = new Map<string, ResolvedRecipe>(result.resolved.map((recipe) => [recipe.key, recipe]));

    failed.push(...together.failed);

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
    const changed = settled.filter((recipe) => before.recipes[recipe.key]?.version !== recipe.version || (recipe.pins ?? []).some((pin) => before.recipes[recipe.key]?.pins?.[pin.holder]?.version !== pin.version));
    const links = ctx.services.has("recipes.links") ? ctx.services.get("recipes.links") : undefined;

    return {
        scope,
        diff: lockService.diff(before, after),
        lockfile: after,
        missingRepos: [...result.missingRepos].sort((left, right) => compareBytewise(left.name, right.name)),
        newVariables: await newVariables(ctx, changed, before, indexes),
        unreadable: sortBytewise(result.unreadable),
        unreachable,
        checked,
        linked: sortBytewise(new Set(changed.map((recipe) => recipe.repo).filter((repo) => links?.get(repo) !== undefined))),
        builtIn: sortBytewise(builtInMoving)
            .filter((key) => resolvedSubscriptions.includes(key))
            .map((key) => ({ key, ...(subscriptions[key]?.range === undefined ? {} : { version: subscriptions[key]!.range }) })),
        switchedOff: sortBytewise(
            Object.keys(configured).filter((key) => {
                const parsed = coverOf(key);

                return configured[key]?.enabled === false && parsed !== undefined && coverInScope(scope, parsed.cover, parsed.qualifier);
            }),
        ),
        failed,
        cycles: result.cycles,
    };
}

/** Questions a changed recipe's new version asks that its pinned version did not, as `recipe show` builds them. */
async function newVariables(ctx: Context, changed: readonly ResolvedRecipe[], before: Lockfile, indexes: ReadonlyMap<string, IndexFile>): Promise<PlannedQuestion[]> {
    const { defined } = await definedVariables(ctx, changed);
    const known = new Set<string>();

    for (const recipe of changed) {
        const pinned = before.recipes[recipe.key];
        const old = pinned === undefined ? undefined : indexes.get(pinned.repo)?.recipes[recipe.key]?.versions[pinned.version]?.variables;

        for (const variable of old ?? []) {
            known.add(`${recipe.key}.${variable.name}`);
        }
    }

    const added = defined.filter((variable) => !known.has(variable.key));

    return plannedQuestionsOf(ctx, added);
}

/** What resolving the subscriptions together settled. */
interface ResolvedTogether {
    /** The result covering every subscription that could be resolved. */
    readonly result: ResolveResult;
    /** The keys of those subscriptions. */
    readonly resolved: string[];
    /** Each subscription refused, and why. */
    readonly failed: Array<{ key: string; reason: string }>;
}

/**
 * Resolves the subscriptions together, so each recipe several of them reach takes one version that
 * satisfies every holder's range at once (ADR 0023): the locked version while it does, else the
 * newest that does, with a holder that reaches it only through `depends` pinned on its own when its
 * range does not allow that version. When they cannot all be resolved at once, they are added one
 * at a time in order, and each one that cannot join the others is refused with the reason, leaving
 * its pins where they are. The one owner of resolving the project's subscriptions together: an
 * update resolves those it covers, and `subscription add` resolves the new one after every other.
 *
 * @param requests - One request per subscription, keyed by the subscription.
 * @param resolve - Resolves a set of requests in one pass.
 */
export async function resolveTogether(
    requests: ReadonlyArray<{ key: string; request: RecipeRequest }>,
    resolve: (requests: RecipeRequest[]) => Promise<ResolveResult>,
): Promise<ResolvedTogether> {
    const empty: ResolveResult = { resolved: [], missingRepos: [], unreadable: [], cycles: [] };

    if (requests.length === 0) {
        return { result: empty, resolved: [], failed: [] };
    }

    try {
        return { result: await resolve(requests.map((entry) => entry.request)), resolved: requests.map((entry) => entry.key), failed: [] };
    } catch {
        // Something cannot be resolved alongside the rest; find out which, one at a time.
    }

    const accepted: Array<{ key: string; request: RecipeRequest }> = [];
    const failed: Array<{ key: string; reason: string }> = [];
    let result = empty;

    for (const entry of requests) {
        try {
            result = await resolve([...accepted, entry].map((each) => each.request));
            accepted.push(entry);
        } catch (error) {
            failed.push({ key: entry.key, reason: failureReason(error) });
        }
    }

    return { result, resolved: accepted.map((entry) => entry.key), failed };
}

/** Why a subscription could not be resolved, in one sentence; a version conflict names each holder and its range. */
function failureReason(error: unknown): string {
    if (!(error instanceof NoVersionSatisfiesError)) {
        return describeError(error);
    }

    const holders = error.ranges.map(({ range, requestedBy }) => `'${range}' from ${requestedBy === PROJECT_HOLDER ? "a subscription of this project" : `'${requestedBy}'`}`);

    return `No published version of '${error.key}' satisfies every recipe that needs it: ${holders.join(", ")}.`;
}
