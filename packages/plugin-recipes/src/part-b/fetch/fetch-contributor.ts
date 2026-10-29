/**
 * The `recipes.fetch` contributor (S2, "Downloads"): while the config is built, it makes sure every
 * locked recipe the subscriptions switched on here reach (S4, 3) has its files on disk, downloading
 * what the store lacks, and adds one `active-recipe` entity for each, so their config layers,
 * plugins and content join the loop. Downloads are cached in the store, so later passes and later
 * runs find them already there. When something cannot be downloaded, building the config fails
 * and says what (unless the plugin option `fetch.missing` is `skip`).
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, type ConfigBuilder, type ContributorDefinition } from "@sous-io/plugin-api";
import type { FormatsManifests, Lockfile, RecipeManifest } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeEntity, RepoEntry, RepositoryHostEntity, StoreSettings, SubscriptionEntry } from "../../types.js";
import { CONTRIBUTORS, CORE_RECIPE_KEY, LOCKFILE_NAME, OFFICIAL_REPO_IDENTITY } from "../constants.js";
import { emptyLockfile } from "../lock/lockfile-ops.js";
import { plainSubscriptionKey, reachability } from "../lock/reachable.js";
import { LinksFiles } from "../links/links-service.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf, splitStoredKey } from "../support.js";
import { mapLinkedRecipes, type LinkedRecipe } from "./linked-recipes.js";
import { ensureInStore } from "./restore.js";

/** This plugin's options, under `plugins.options."@sous-io/plugin-recipes"`. */
export interface RecipesPluginOptions {
    fetch?: {
        /** What to do when a recipe cannot be downloaded: `fail` the build (default), or `skip` it with a warning. */
        missing?: "fail" | "skip";
    };
    configLayers?: {
        /** More top-level keys a recipe's config layer may set. */
        allowedKeys?: string[];
    };
}

/** The `recipes.fetch` contributor. */
export function fetchContributor(runtime: PartBRuntime): ContributorDefinition {
    return {
        id: CONTRIBUTORS.fetch,
        after: [CONTRIBUTORS.core],
        monitors: [{ entities: "repository-host" }],

        async contribute(config) {
            const project = config.project;

            if (project === undefined) {
                return;
            }

            const hosts = config.entities("repository-host");
            const lockfile = readLockfile(runtime, path.join(project.sousDir, LOCKFILE_NAME), config, hosts);
            const repos = config.atPath("repos").get<Record<string, RepoEntry>>() ?? {};
            const { reached } = reachability({
                lockfile,
                subscriptions: config.atPath("subscriptions").get<Record<string, SubscriptionEntry>>(),
                repos,
                keyOf: (key) => subscriptionKey(runtime, key),
            });

            if (reached.length === 0) {
                return;
            }

            const missing = config.options<RecipesPluginOptions>()?.fetch?.missing ?? "fail";
            const recipes = await activeRecipes(runtime, config, lockfile, reached, repos, project.sousDir);

            if (recipes.failed.length > 0) {
                const lines = recipes.failed.map((failure) => `${failure.key}: ${failure.reason}`);

                if (missing === "fail") {
                    throw new ConfigError(`Sous could not download ${recipes.failed.length === 1 ? "a recipe" : `${recipes.failed.length} recipes`} this project's subscriptions need.`, {
                        details: [...lines, "Check the network and that the repositories are reachable, then run the command again."],
                    });
                }

                for (const line of lines) {
                    config.log("warning", `Skipped ${line}`);
                }
            }

            for (const entity of recipes.active) {
                config.addEntity("active-recipe", entity);
            }

            if (recipes.downloaded.length > 0) {
                await runtime.emit("recipes.fetched", { recipes: recipes.downloaded });
            }
        },
    };
}

/** The stored key a subscription key names, through `refs.format` when it is there. */
function subscriptionKey(runtime: PartBRuntime, key: string): string {
    try {
        const format = runtime.services.get("refs.format");

        return format.key(format.parseNamedRef(key, "config"));
    } catch {
        return plainSubscriptionKey(key);
    }
}

/** The project's lockfile, or an empty one; a damaged one is reported and treated as empty. */
function readLockfile(runtime: PartBRuntime, file: string, config: ConfigBuilder, hosts: readonly RepositoryHostEntity[]): Lockfile {
    let text: string;

    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return emptyLockfile();
    }

    try {
        const lockfile = runtime.services.get("formats.lockfile").parse(JSON.parse(text), file);
        const repos: Lockfile["repos"] = {};

        for (const [name, entry] of Object.entries(lockfile.repos)) {
            repos[name] = entry.identity === undefined ? { ...entry, ...identityOf(runtime, entry.url, hosts) } : entry;
        }

        return { ...lockfile, repos };
    } catch (error) {
        config.log("warning", `Sous could not read the lockfile at ${file}, so no recipes are active: ${messageOf(error)}`);

        return emptyLockfile();
    }
}

/** `{ identity }` for a URL, or nothing. */
function identityOf(runtime: PartBRuntime, url: string, hosts: readonly RepositoryHostEntity[]): { identity?: string } {
    const identity = runtime.tryIdentity(url, hosts);

    return identity === undefined ? {} : { identity };
}

/** What making the reached recipes active came to. */
interface ActiveRecipes {
    readonly active: ActiveRecipeEntity[];
    readonly downloaded: Array<{ key: string; version: string; dir: string }>;
    readonly failed: Array<{ key: string; reason: string }>;
}

/** Locates or downloads every reached recipe and reads its manifest. */
async function activeRecipes(
    runtime: PartBRuntime,
    config: ConfigBuilder,
    lockfile: Lockfile,
    reached: readonly string[],
    repos: Record<string, RepoEntry>,
    sousDir: string,
): Promise<ActiveRecipes> {
    const services = runtime.services;
    const manifests = services.get("formats.manifests");
    const links = new LinksFiles({ sousDir, globalFile: runtime.homePaths().links, parser: services.get("formats.links-map") }).all();
    const linked = new Map<string, Promise<Map<string, LinkedRecipe>>>();
    const hosts = config.entities("repository-host");
    const store = config.atPath("store").get<Partial<StoreSettings>>();
    const result: ActiveRecipes = { active: [], downloaded: [], failed: [] };

    for (const key of reached) {
        const entry = lockfile.recipes[key];
        const { namespace, name } = splitStoredKey(key);
        const locked = lockfile.repos[entry.repo];
        const identity = locked?.identity ?? (locked === undefined ? undefined : runtime.tryIdentity(locked.url, hosts)) ?? entry.repo;
        const base = { id: key, namespace, name, repo: entry.repo, identity, version: entry.version, hash: entry.hash, kind: entry.kind, requestedBy: [...entry.requestedBy] };

        try {
            const link = links[entry.repo];

            if (link !== undefined) {
                let map = linked.get(link.path);

                if (map === undefined) {
                    map = mapLinkedRecipes(link.path, manifests);
                    linked.set(link.path, map);
                }

                const found = (await map).get(key);

                if (found !== undefined) {
                    result.active.push({ ...base, dir: found.dir, source: "link", manifest: found.manifest });
                    continue;
                }
            }

            if (locked === undefined) {
                throw new Error(`the lockfile does not say where the repository '${entry.repo}' lives`);
            }

            const provider = repos[entry.repo]?.provider;
            const outcome = await ensureInStore(
                { key, entry, repo: entry.repo, url: locked.url, identity, ...(provider === undefined ? {} : { provider }) },
                {
                    store: services.get("recipes.store"),
                    cache: runtime.indexCore(),
                    hosts,
                    context: runtime.hostContext(),
                    ...(store?.freshnessSeconds === undefined ? {} : { freshnessSeconds: store.freshnessSeconds }),
                },
            );
            const manifest = await readManifest(manifests, outcome.dir, key);

            result.active.push({ ...base, dir: outcome.dir, source: key === CORE_RECIPE_KEY && identity === OFFICIAL_REPO_IDENTITY ? "core" : "store", manifest });

            if (outcome.downloaded) {
                result.downloaded.push({ key, version: entry.version, dir: outcome.dir });
            }
        } catch (error) {
            result.failed.push({ key, reason: messageOf(error) });
        }
    }

    return result;
}

/** A recipe's manifest from its directory. */
async function readManifest(manifests: FormatsManifests, dir: string, key: string): Promise<RecipeManifest> {
    try {
        return (await manifests.requireRecipe(dir)).manifest;
    } catch (error) {
        throw new Error(`the files of ${key} are in ${dir}, but its manifest could not be read: ${messageOf(error)}`);
    }
}
