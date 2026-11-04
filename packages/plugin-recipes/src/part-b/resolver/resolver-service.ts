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
import { NoVersionSatisfiesError, resolveWanted, UnknownRefError, wantedOf, type DependencyLists, type ResolverRepo, type WantedRequest } from "./resolve.js";

/** `recipes.resolver`. */
export class ResolverService implements RecipesResolver {
    private readonly linked = new Map<string, Promise<Map<string, LinkedRecipe>>>();
    /** The upstream reads made after a miss in this run, by the sorted repository names. */
    private readonly upstream = new Map<string, Promise<{ found: Map<string, IndexFile>; checked: Set<string> }>>();

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

        const run = (indexes: ReadonlyMap<string, IndexFile>, checkedNow?: ReadonlySet<string>): Promise<ResolveResult> =>
            resolveWanted(wanted, {
                indexes,
                repos,
                loadManifest: (recipe) => this.loadManifest(recipe),
                parseDependency: (written) => this.parseDependency(written),
                ...(options.prerelease === undefined ? {} : { prerelease: options.prerelease }),
                ...(options.keep === undefined ? {} : { keep: options.keep }),
                ...(options.keepPins === undefined ? {} : { keepPins: options.keepPins }),
                ...(checkedNow === undefined ? {} : { checkedNow }),
            });

        if (options.indexes !== undefined) {
            return run(options.indexes);
        }

        const names = Object.keys(repos);
        const latest = options.latest === true;
        const read = await this.indexes(names, latest, options.quiet === true);

        try {
            return await run(read.found, latest ? read.checked : undefined);
        } catch (error) {
            // A recipe or version released moments ago is missing only from a cached copy of the
            // index (#133): read every index upstream once, and try again before reporting it.
            if (latest || !(error instanceof UnknownRefError || error instanceof NoVersionSatisfiesError)) {
                throw error;
            }

            const fresh = await this.readUpstreamOnce(names, options.quiet === true);

            return run(fresh.found, fresh.checked);
        }
    }

    /**
     * The indexes read upstream, once per set of repositories in this run, so a ref that is truly
     * missing costs one read per repository, however many resolves ask for it.
     */
    private readUpstreamOnce(names: readonly string[], quiet: boolean): Promise<{ found: Map<string, IndexFile>; checked: Set<string> }> {
        const key = sortKeys(names).join("\n");
        let read = this.upstream.get(key);

        if (read === undefined) {
            read = this.indexes(names, true, quiet);
            this.upstream.set(key, read);
        }

        return read;
    }

    async resolveSubscriptions(options: ResolveOptions = {}): Promise<ResolveResult> {
        const subscriptions = enabledSubscriptions(this.ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions"));

        return this.resolve(
            sortKeys(Object.keys(subscriptions)).map((key) => this.subscriptionRequest(key)),
            options,
        );
    }

    subscriptionRequest(key: string): RecipeRequest {
        const entry = this.ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions")?.[key] ?? {};
        const format = this.ctx.services.get("refs.format");

        return {
            ref: format.parseNamedRef(key, "config"),
            ...(entry.range === undefined ? {} : { range: entry.range }),
            ...(entry.prerelease === true ? { prerelease: true } : {}),
            requestedBy: PROJECT_HOLDER,
            kind: "subscribes" as const,
        };
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

    /**
     * The index of every trusted repository that can be read; one that cannot is left out. With
     * `latest`, `checked` names the repositories whose index was read upstream just now.
     */
    private async indexes(names: readonly string[], latest: boolean, quiet: boolean): Promise<{ found: Map<string, IndexFile>; checked: Set<string> }> {
        const cache = this.ctx.services.get("recipes.index-cache");
        const found = new Map<string, IndexFile>();
        const checked = new Set<string>();

        for (const name of sortKeys(names)) {
            try {
                const read = await cache.get(name, { latest });

                // Upstream failed and the cached copy answers instead: say so, once per repository.
                if (read.source === "stale" && !quiet && cache.firstStaleNotice(name)) {
                    const problem = read.problem;

                    this.runtime.host.reporter.problem(
                        `Sous could not check the repository '${name}' for updates, so it is using the copy of its index that it already had.`,
                        problem === undefined ? {} : { cause: problem },
                    );
                }

                found.set(name, read.index);

                if (latest && read.source !== "stale") {
                    checked.add(name);
                }
            } catch {
                const cached = cache.cached(name);

                if (cached !== undefined) {
                    found.set(name, cached.index);
                }
            }
        }

        return { found, checked };
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
