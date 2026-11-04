/**
 * The `recipes.fetch` contributor: while the config is built, it makes sure every
 * locked recipe the subscriptions switched on here reach has its files on disk, downloading
 * what the store lacks, and adds one `active-recipe` entity for each, so their config layers,
 * plugins and content join the loop. Downloads are cached in the store, so later passes and later
 * runs find them already there. When something cannot be downloaded, building the config fails
 * and says what (unless the plugin option `fetch.missing` is `skip`).
 *
 * Only a command that reads recipe files downloads them (an intent that declares
 * `needsRecipeFiles`, or a command the front end could not read before the build). Any other
 * command (help, the version, `repo list`, `subscription list`) uses the recipe files already on
 * this machine and leaves out the rest without a word, so it works offline and without credentials.
 */

import fs from "node:fs";
import path from "node:path";
import type { ConfigBuilder, ContributorDefinition } from "@sous-io/plugin-api";
import type { FormatsManifests, Lockfile, RecipeManifest } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeEntity, RepoEntry, RepositoryHostEntity, StoreSettings, SubscriptionEntry } from "../../types.js";
import { CONTRIBUTORS, CORE_RECIPE_KEY, LOCKFILE_NAME, OFFICIAL_REPO_IDENTITY } from "../constants.js";
import { emptyLockfile, lockedVersions, restoredLabel } from "../lock/lockfile-ops.js";
import { plainSubscriptionKey, reachability } from "../lock/reachable.js";
import { LinksFiles } from "../links/links-service.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf, splitStoredKey } from "../support.js";
import { mapLinkedRecipes, type LinkedRecipe } from "./linked-recipes.js";
import { describeFailures, downloadFailureError, type RecipeFailure } from "./download-failures.js";
import { ensureInStore, findInStore } from "./restore.js";

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
            // A command that reads no recipe files (help, `repo list`, `subscription list`) uses the
            // ones already on this machine, and leaves out the rest without a word.
            const download = runtime.downloadsRecipeFiles(config.plan);
            const recipes = await activeRecipes(runtime, config, lockfile, reached, repos, project.sousDir, download);

            runtime.noteLeftOut(download ? 0 : recipes.failed.length);

            if (download && recipes.failed.length > 0) {
                if (missing === "fail") {
                    throw downloadFailureError(recipes.failed);
                }

                for (const failure of recipes.failed) {
                    config.warn(`Skipped ${describeFailures([failure]).lines.join("\n")}`);
                }

                const { fixes } = describeFailures(recipes.failed);

                if (fixes.length > 0) {
                    config.warn(fixes.join("\n"));
                }
            }

            for (const entity of recipes.active) {
                config.addEntity("active-recipe", entity);
            }

            // No listener hears an event while the config is built; the next restore reports these.
            runtime.noteFetched(recipes.downloaded.map((recipe) => recipe.label));
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
        config.warn(`Sous could not read the lockfile at ${file}, so no recipes are active: ${messageOf(error)}`);

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
    /** `label` is how a restore names the version (`restoredLabel`). */
    readonly downloaded: Array<{ key: string; label: string; version: string; dir: string }>;
    /** Recipes that could not be made active; when nothing may be downloaded, those whose files are not here. */
    readonly failed: RecipeFailure[];
}

/**
 * Locates or downloads every reached recipe and reads its manifest. With `download` false, only the
 * copies already in the store (or a linked working copy) count; nothing is downloaded.
 */
async function activeRecipes(
    runtime: PartBRuntime,
    config: ConfigBuilder,
    lockfile: Lockfile,
    reached: readonly string[],
    repos: Record<string, RepoEntry>,
    sousDir: string,
    download: boolean,
): Promise<ActiveRecipes> {
    const services = runtime.services;
    const manifests = services.get("formats.manifests");
    const links = new LinksFiles({ sousDir, globalFile: runtime.homePaths().links, parser: services.get("formats.links-map") }).all();
    const linked = new Map<string, Promise<Map<string, LinkedRecipe>>>();
    const hosts = config.entities("repository-host");
    const store = config.atPath("store").get<Partial<StoreSettings>>();
    const result: ActiveRecipes = { active: [], downloaded: [], failed: [] };

    const reachedSet = new Set(reached);
    const storeDeps = {
        store: services.get("recipes.store"),
        cache: runtime.indexCore(),
        hosts,
        context: runtime.hostContext(),
        ...(store?.freshnessSeconds === undefined ? {} : { freshnessSeconds: store.freshnessSeconds }),
    };

    // Every recipe is looked up at once (a read of the store or a download), then listed in the order reached.
    const settled = await Promise.all(
        reached.map(async (key): Promise<{ active?: ActiveRecipeEntity; downloaded?: ActiveRecipes["downloaded"]; failed?: RecipeFailure }> => {
            const entry = lockfile.recipes[key];
            const { namespace, name } = splitStoredKey(key);
            const locked = lockfile.repos[entry.repo];
            const identity = locked?.identity ?? (locked === undefined ? undefined : runtime.tryIdentity(locked.url, hosts)) ?? entry.repo;
            const base = { id: key, namespace, name, repo: entry.repo, identity, version: entry.version, hash: entry.hash, kind: entry.kind, requestedBy: [...entry.requestedBy] };
            // Only the pins of holders active here are needed.
            const versions = lockedVersions(entry).filter((one) => one.holder === undefined || reachedSet.has(one.holder));

            try {
                const link = links[entry.repo];

                if (link !== undefined) {
                    let map = linked.get(link.path);

                    if (map === undefined) {
                        map = mapLinkedRecipes(link.path, manifests);
                        linked.set(link.path, map);
                    }

                    const found = (await map).get(key);

                    // A linked working copy answers for every version pinned, a holder's own included.
                    if (found !== undefined) {
                        const pins = versions.flatMap((one) =>
                            one.holder === undefined ? [] : [{ holder: one.holder, version: one.version, hash: one.hash, dir: found.dir, manifest: found.manifest }],
                        );

                        return { active: { ...base, dir: found.dir, source: "link", manifest: found.manifest, ...(pins.length === 0 ? {} : { pins }) } };
                    }
                }

                if (locked === undefined) {
                    throw new Error(`the lockfile does not say where the repository '${entry.repo}' lives`);
                }

                const provider = repos[entry.repo]?.provider;
                const found = await Promise.all(
                    versions.map(async (one) => {
                        const target = { key, entry: { ...entry, version: one.version, hash: one.hash }, repo: entry.repo, url: locked.url, identity, ...(provider === undefined ? {} : { provider }) };
                        const outcome = download ? await ensureInStore(target, storeDeps) : await findInStore(target, storeDeps.store);

                        return outcome === undefined ? undefined : { one, outcome, manifest: await readManifest(manifests, outcome.dir, key) };
                    }),
                );
                const fetched = found.filter((one) => one !== undefined);

                if (fetched.length < found.length) {
                    return { failed: { key, error: new Error(`the files of ${key} are not on this machine`) } };
                }

                const shared = fetched[0]!;
                const pins = fetched.slice(1).map(({ one, outcome, manifest }) => ({ holder: one.holder as string, version: one.version, hash: one.hash, dir: outcome.dir, manifest }));
                const active: ActiveRecipeEntity = {
                    ...base,
                    dir: shared.outcome.dir,
                    source: key === CORE_RECIPE_KEY && identity === OFFICIAL_REPO_IDENTITY ? "core" : "store",
                    manifest: shared.manifest,
                    ...(pins.length === 0 ? {} : { pins }),
                };
                const downloaded = fetched.filter(({ outcome }) => outcome.downloaded).map(({ one, outcome }) => ({ key, label: restoredLabel(key, one), version: one.version, dir: outcome.dir }));

                return downloaded.length === 0 ? { active } : { active, downloaded };
            } catch (error) {
                return { failed: { key, error } };
            }
        }),
    );

    for (const one of settled) {
        if (one.active !== undefined) result.active.push(one.active);
        if (one.downloaded !== undefined) result.downloaded.push(...one.downloaded);
        if (one.failed !== undefined) result.failed.push(one.failed);
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
