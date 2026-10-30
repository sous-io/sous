/**
 * `recipes.resolver`: resolving the project's requests against the indexes of the repositories it
 * trusts, and which locked recipes the subscriptions switched on here reach.
 */

import type { ServiceContext } from "@sous-io/plugin-api";
import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import type { SousRef } from "@sous-io/plugin-refs/types";
import type { RecipeRequest, RecipesResolver, ResolvedRecipe, ResolveOptions, ResolveResult, SubscriptionEntry } from "../../types.js";
import { PROJECT_HOLDER } from "../constants.js";
import { mapLinkedRecipes, type LinkedRecipe } from "../fetch/linked-recipes.js";
import { storeKeyOf } from "../fetch/restore.js";
import { trustedRepos } from "../lock/lock-service.js";
import { plainSubscriptionKey, reachability } from "../lock/reachable.js";
import { enabledSubscriptions, sortKeys } from "../support.js";
import type { PartBRuntime } from "../runtime.js";
import { resolveWanted, wantedOf, type DependencyLists, type ResolverRepo, type WantedRequest } from "./resolve.js";

/** `recipes.resolver`. */
export class ResolverService implements RecipesResolver {
    private readonly linked = new Map<string, Promise<Map<string, LinkedRecipe>>>();

    constructor(
        private readonly ctx: ServiceContext,
        private readonly runtime: PartBRuntime,
    ) {}

    async resolve(requests: readonly RecipeRequest[], options: ResolveOptions = {}): Promise<ResolveResult> {
        const trusted = trustedRepos(this.ctx);
        const repos: Record<string, ResolverRepo> = {};

        for (const [name, entry] of Object.entries(trusted)) {
            const identity = this.runtime.tryIdentity(entry.url);

            if (identity !== undefined) {
                repos[name] = { url: entry.url, identity, ...(entry.provider === undefined ? {} : { provider: entry.provider }) };
            }
        }

        const indexes = options.indexes ?? (await this.indexes(Object.keys(repos), options.latest === true, options.quiet === true));
        const wanted: WantedRequest[] = [];

        for (const request of requests) {
            const parts = wantedOf(request.ref);

            if (parts === undefined) {
                continue;
            }

            wanted.push({
                ...parts,
                ...(request.range !== undefined && parts.range === undefined ? { range: request.range } : {}),
                requestedBy: request.requestedBy,
                ...(request.kind === undefined ? {} : { kind: request.kind }),
                ...(request.prerelease === undefined ? {} : { prerelease: request.prerelease }),
                written: this.format(request),
            });
        }

        return resolveWanted(wanted, {
            indexes,
            repos,
            loadManifest: (recipe) => this.loadManifest(recipe),
            parseDependency: (written) => this.parseDependency(written),
            ...(options.prerelease === undefined ? {} : { prerelease: options.prerelease }),
            ...(options.keep === undefined ? {} : { keep: options.keep }),
        });
    }

    async resolveSubscriptions(options: ResolveOptions = {}): Promise<ResolveResult> {
        const subscriptions = enabledSubscriptions(this.ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions"));
        const format = this.ctx.services.get("refs.format");
        const requests: RecipeRequest[] = sortKeys(Object.keys(subscriptions)).map((key) => {
            const entry = subscriptions[key];

            return {
                ref: format.parseNamedRef(key, "config"),
                ...(entry.range === undefined ? {} : { range: entry.range }),
                ...(entry.prerelease === true ? { prerelease: true } : {}),
                requestedBy: PROJECT_HOLDER,
                kind: "subscribes" as const,
            };
        });

        return this.resolve(requests, options);
    }

    reachable(lockfile: Lockfile): string[] {
        return reachability({
            lockfile,
            subscriptions: this.ctx.config.get("subscriptions"),
            repos: this.ctx.config.get("repos"),
            keyOf: (key) => this.keyOf(key),
        }).reached;
    }

    /** The stored key a subscription key names. */
    keyOf(subscription: string): string {
        try {
            const format = this.ctx.services.get("refs.format");

            return format.key(format.parseNamedRef(subscription, "config"));
        } catch {
            return plainSubscriptionKey(subscription);
        }
    }

    /** The index of every trusted repository that can be read; one that cannot is left out. */
    private async indexes(names: readonly string[], latest: boolean, quiet: boolean): Promise<Map<string, IndexFile>> {
        const cache = this.ctx.services.get("recipes.index-cache");
        const found = new Map<string, IndexFile>();

        for (const name of sortKeys(names)) {
            try {
                const read = await cache.get(name, { latest });

                // Upstream failed and the cached copy answers instead: say so, as before the refactor.
                if (read.source === "stale" && !quiet) {
                    const problem = (read as { problem?: string }).problem;

                    this.runtime.host.reporter.warning(
                        `Sous could not check the repository '${name}' for updates, so it is using the copy of its index that it already had.${problem === undefined ? "" : `\n${problem}`}`,
                    );
                }

                found.set(name, read.index);
            } catch {
                const cached = cache.cached(name);

                if (cached !== undefined) {
                    found.set(name, cached.index);
                }
            }
        }

        return found;
    }

    /** A resolved recipe's lists from its files: a linked checkout, else the store. */
    private async loadManifest(recipe: ResolvedRecipe): Promise<DependencyLists | undefined> {
        const manifests = this.ctx.services.get("formats.manifests");
        const link = this.ctx.services.get("recipes.links").get(recipe.repo);

        if (link !== undefined) {
            let map = this.linked.get(link.path);

            if (map === undefined) {
                map = mapLinkedRecipes(link.path, manifests);
                this.linked.set(link.path, map);
            }

            const found = (await map).get(recipe.key);

            if (found !== undefined) {
                return { depends: found.manifest.depends ?? [], subscribes: found.manifest.subscribes ?? [] };
            }
        }

        const hit = await this.ctx.services.get("recipes.store").get(storeKeyOf(recipe.key, recipe.identity, recipe.version));

        if (hit === undefined) {
            return undefined;
        }

        const manifest = await manifests.readRecipe(hit.dir);

        return manifest === undefined ? undefined : { depends: manifest.manifest.depends ?? [], subscribes: manifest.manifest.subscribes ?? [] };
    }

    /** Every reading of a dependency as a manifest wrote it. */
    private parseDependency(written: string): SousRef[] {
        try {
            return this.ctx.services.get("refs.resolver").resolveSync({ input: written, from: "manifest", lookups: false, refusedIsEmpty: true }).refs;
        } catch {
            return [];
        }
    }

    /** How a request is written in messages. */
    private format(request: RecipeRequest): string {
        try {
            return this.ctx.services.get("refs.format").format(request.ref);
        } catch {
            return request.ref.name;
        }
    }
}
