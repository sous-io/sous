/**
 * Wiring the catalog to a running intent (ported from `src/lib/repos/catalog-inputs.ts`): the
 * trusted repositories and their indexes from `recipes.index-cache`, the pins from `recipes.lock`,
 * the links from `recipes.links`, and settling which match a ref means through `refs.picker`.
 *
 * By default nothing is downloaded: a repository whose index was never fetched is left out and
 * named. `latest` reads every index from upstream first; `installed` never goes upstream and keeps
 * only what the lockfile pins.
 */

import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type { RecipeManifest } from "@sous-io/plugin-formats/types";
import type { SousRef } from "@sous-io/plugin-refs/types";
import type { BrowsingFlags, CachedIndex } from "../types.js";
import { findInCatalog, narrowToInstalled, type CatalogInputs, type CatalogMatch, type CatalogRepo, type RecipeLocation } from "./catalog.js";
import { isBuiltInEntry } from "./defaults.js";
import { emptyLockfile } from "./lock-holds.js";
import { enabledSubscriptions, trustedRepos } from "./project.js";
import { describeError } from "./util.js";

/** The catalog's inputs, and what could not be read. */
export interface CatalogContext {
    readonly inputs: CatalogInputs;
    /** Trusted repositories with no index at all. */
    readonly notFetched: string[];
    /** Repositories whose upstream read failed, listed from the cache instead. */
    readonly notChecked: ReadonlyArray<{ readonly repo: string; readonly reason: string }>;
    /** Where each index came from. */
    readonly sources: ReadonlyMap<string, CachedIndex>;
}

type Reader = Pick<Context, "config" | "services">;

/** The trusted repositories in the order a one-word ref searches them: built-in first, then config order. */
export function repoSearchOrder(ctx: Pick<Context, "config">): string[] {
    const repos = trustedRepos(ctx.config);
    const names = Object.keys(repos);
    const builtIn = names.filter((name) => isBuiltInEntry(repos[name]));

    return [...builtIn, ...names.filter((name) => !builtIn.includes(name))];
}

/** The canonical identity of a URL, or `undefined` when no host reads it. */
export function identityOf(ctx: Pick<Context, "services">, url: string): string | undefined {
    try {
        return ctx.services.get("refs.locations").identity(url);
    } catch {
        return undefined;
    }
}

/** Every trusted repository's index, read the way the flags say. */
export async function readIndexes(ctx: Reader, flags: BrowsingFlags): Promise<Pick<CatalogContext, "notFetched" | "notChecked" | "sources">> {
    const cache = ctx.services.get("recipes.index-cache");
    const sources = new Map<string, CachedIndex>();
    const notFetched: string[] = [];
    const notChecked: Array<{ repo: string; reason: string }> = [];

    for (const name of repoSearchOrder(ctx)) {
        if (flags.latest === true && flags.installed !== true) {
            try {
                sources.set(name, await cache.get(name, { latest: true }));
                continue;
            } catch (error) {
                notChecked.push({ repo: name, reason: describeError(error) });
            }
        }

        const cached = cache.cached(name);

        if (cached === undefined) {
            notFetched.push(name);
        } else {
            sources.set(name, cached);
        }
    }

    return { notFetched: notFetched.filter((name) => !sources.has(name)), notChecked, sources };
}

/** The catalog's inputs for this project. */
export async function loadCatalog(ctx: Reader, flags: BrowsingFlags = {}): Promise<CatalogContext> {
    const read = await readIndexes(ctx, flags);
    const trusted = trustedRepos(ctx.config);
    const repos: CatalogRepo[] = [...read.sources.entries()].map(([name, cached]) => {
        const url = trusted[name]?.url;
        const identity = cached.meta?.identity ?? (url === undefined ? undefined : identityOf(ctx, url));

        return { name, index: cached.index, ...(url === undefined ? {} : { url }), ...(identity === undefined ? {} : { identity }) };
    });

    const linked: Record<string, string> = {};

    if (ctx.services.has("recipes.links")) {
        for (const [name, link] of Object.entries(ctx.services.get("recipes.links").all())) {
            linked[name] = link.path;
        }
    }

    let lock = emptyLockfile();

    try {
        lock = ctx.services.get("recipes.lock").read();
    } catch {
        // A browsing intent works without a lockfile; every other reader reports a broken one.
    }

    const declarations = ctx.services.has("recipes.declarations") ? ctx.services.get("recipes.declarations") : undefined;
    const inputs: CatalogInputs = {
        repos,
        lock,
        subscriptions: Object.keys(enabledSubscriptions(ctx.config)).sort(),
        linked,
        ...(declarations === undefined
            ? {}
            : {
                  declarationFor: (source, key) => {
                      const found = declarations.covering(source, key);

                      return found === undefined ? undefined : { declared: found.declared, kind: found.kind };
                  },
              }),
    };

    return { ...read, inputs: flags.installed === true ? narrowToInstalled(inputs) : inputs };
}

/** The directory one published recipe's files are read from: a linked checkout, or its store entry. */
export function recipeFilesDirectory(ctx: Reader, catalog: CatalogInputs, location: RecipeLocation): string | undefined {
    const checkout = catalog.linked?.[location.repo];

    if (checkout !== undefined) {
        return path.join(checkout, location.path);
    }

    const identity = catalog.repos.find((repo) => repo.name === location.repo)?.identity ?? catalog.lock.repos[location.repo]?.identity;

    if (identity === undefined) {
        return undefined;
    }

    try {
        return ctx.services.get("recipes.store").entryDir({ identity, namespace: location.namespace, name: location.name, version: location.version });
    } catch {
        return undefined;
    }
}

/** One published recipe's manifest, when its files are on this machine. Nothing is downloaded. */
export async function readPublishedManifest(ctx: Reader, catalog: CatalogInputs, location: RecipeLocation): Promise<RecipeManifest | undefined> {
    const directory = recipeFilesDirectory(ctx, catalog, location);

    if (directory === undefined) {
        return undefined;
    }

    try {
        return (await ctx.services.get("formats.manifests").readRecipe(directory))?.manifest;
    } catch {
        return undefined;
    }
}

/** Every reading of a ref as typed on the command line. */
export function readingsOf(ctx: Pick<Context, "services">, input: string): SousRef[] {
    return ctx.services.get("refs.resolver").parse(input.trim(), "commandLine").refs;
}

/**
 * The one match a run proceeds with: one is used, several are chosen between through the chain's
 * prompter (`--accept-first` takes the first), none is the error the caller builds.
 */
export async function pickMatch(
    ctx: Pick<Context, "services" | "prompter" | "reporter">,
    matches: readonly CatalogMatch[],
    search: string,
    acceptFirst: boolean | undefined,
    none: () => Error,
): Promise<CatalogMatch> {
    if (matches.length === 0) {
        throw none();
    }

    if (matches.length === 1 || acceptFirst === true) {
        return matches[0]!;
    }

    const exact = matches.filter((match) => match.exact);

    if (exact.length === 1) {
        return exact[0]!;
    }

    const picked = await ctx.services
        .get("refs.picker")
        .pick(matches.map((match) => match.ref), { search, ...(acceptFirst === undefined ? {} : { acceptFirst }) }, ctx);

    return matches.find((match) => match.ref === picked) ?? matches[0]!;
}

/** Finds and settles a namespace or recipe in the catalog. */
export async function resolveInCatalog(
    ctx: Pick<Context, "services" | "prompter" | "reporter">,
    catalog: CatalogContext,
    input: string,
    kinds: ReadonlyArray<"namespace" | "recipe">,
    acceptFirst: boolean | undefined,
    none: () => Error,
): Promise<CatalogMatch> {
    const matches = findInCatalog(catalog.inputs, readingsOf(ctx, input), kinds);

    return pickMatch(ctx, matches, input.trim(), acceptFirst, none);
}
