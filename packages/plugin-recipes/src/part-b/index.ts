/**
 * Part B of plugin-recipes: the lockfile, resolving versions, restoring, the index cache and
 * freshness, the core recipe and seeding, links and editable checkouts, downloading recipes while
 * the config is built, recipe config layers, recipe plugins and the `~` namespace resolver.
 *
 * Registered by the plugin's `register` (`../index.ts`), before part A.
 */

import fs from "node:fs";
import type { Sous } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-compiler/types";
import type { StoreSettings } from "../types.js";
import { CONTRIBUTORS, DEFAULT_FRESHNESS_SECONDS } from "./constants.js";
import { configLayersContributor } from "./config-layers/config-layers.js";
import { coreIndexOverlay, packagedCoreRecipeDir } from "./core/core-recipe.js";
import { CoreSeeder, coreContributor } from "./core/core-contributor.js";
import { fetchContributor } from "./fetch/fetch-contributor.js";
import { IndexCacheService } from "./index-cache/index-cache.js";
import { collectStore, rebuildLock, showLock } from "./intents/lock-intents.js";
import { linkRepo } from "./links/link-intent.js";
import { LinksFiles } from "./links/links-service.js";
import { unlinkRepo } from "./links/unlink-intent.js";
import { LockService, trustedRepos } from "./lock/lock-service.js";
import { lockfileLookup } from "./lookups/lockfile-lookup.js";
import { explainMissing } from "./namespaces/explain-missing.js";
import { ActiveNamespaceResolver } from "./namespaces/namespace-resolver.js";
import { pluginsContributor, writeRecipeTypes } from "./plugins/recipe-plugins.js";
import { ResolverService } from "./resolver/resolver-service.js";
import { PartBRuntime } from "./runtime.js";
import { activeRecipeSchema, lockRebuildInputSchema, lockShowInputSchema, repoGcInputSchema, repoLinkInputSchema, repoUnlinkInputSchema } from "./schemas.js";

export { CONTRIBUTORS, PartBRuntime };

/** Registers part B. */
export async function registerPartB(sous: Sous): Promise<void> {
    const runtime = new PartBRuntime(sous);
    const seeder = new CoreSeeder(runtime);

    if (!sous.entities.kinds().includes("active-recipe")) {
        sous.entities.define("active-recipe", activeRecipeSchema, { description: "A locked recipe reached from the subscriptions switched on on this machine, its files on disk." });
    }

    registerServices(sous, runtime);
    registerContributors(sous, runtime, seeder);
    registerIntents(sous, runtime);

    sous.entities.add("ref-lookup", lockfileLookup());

    // Rewrites `.sous/types/` from the recipe plugins of every real build (S1).
    sous.on("config.built", (event) => {
        const project = sous.project;

        if (project === undefined || !fs.existsSync(project.sousDir)) {
            return;
        }

        try {
            writeRecipeTypes(project.sousDir, event.payload.config.entities.list("active-recipe"));
        } catch (error) {
            sous.reporter.warning(`Sous could not write the recipe plugin types into ${project.sousDir}/types: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}

/** The services part B provides. */
function registerServices(sous: Sous, runtime: PartBRuntime): void {
    sous.services.add("recipes.lock", (_config, ctx) => new LockService(ctx, runtime), { lifetime: "config" });
    sous.services.add("recipes.resolver", (_config, ctx) => new ResolverService(ctx, runtime), { lifetime: "config" });

    sous.services.add(
        "recipes.links",
        (_config, ctx) => new LinksFiles({ sousDir: ctx.project?.sousDir, globalFile: runtime.homePaths().links, parser: ctx.services.get("formats.links-map") }),
        { lifetime: "config" },
    );

    // A singleton keyed by short name: it reads the config in force at each call, so the
    // `recipes.fetch` contributor and every chain share one cache.
    sous.services.add(
        "recipes.index-cache",
        () => {
            const core = runtime.indexCore();

            installPackagedOverlay(runtime);

            return new IndexCacheService(core, {
                trusted: () => trustedRepos({ services: sous.services, config: sous.engine.config }),
                identity: (url) => runtime.tryIdentity(url) ?? url,
                freshnessSeconds: () => sous.engine.config.get<Partial<StoreSettings>>("store")?.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS,
                linkedPath: (repo) => {
                    try {
                        return sous.services.get("recipes.links").get(repo)?.path;
                    } catch {
                        return undefined;
                    }
                },
            });
        },
        { lifetime: "singleton" },
    );

    sous.services.add(
        "compiler.namespace-resolver",
        (_config, ctx) => {
            const resolver = ctx.services.get("refs.resolver");
            const globs = ctx.services.get("host.globs");
            const recipesResolver = ctx.services.get("recipes.resolver") as ResolverService;

            return new ActiveNamespaceResolver({
                recipes: ctx.entities.list("active-recipe"),
                parse: (reference) => resolver.resolveSync({ input: reference, from: "include", kinds: ["recipeFile"], lookups: false, refusedIsEmpty: true }),
                isMatch: (name, pattern, options) => globs.isMatch(name, pattern, { nocase: options.nocase, dot: true }),
                explainMissing: (recipe) =>
                    explainMissing(recipe, {
                        subscriptions: ctx.config.get("subscriptions"),
                        keyOf: (key) => recipesResolver.keyOf(key),
                        lockfile: () => ctx.services.get("recipes.lock").read(),
                        cachedIndex: (identity) => runtime.indexCore().readCached(identity),
                    }),
            });
        },
        { lifetime: "config" },
    );
}

/** Folds the packaged core version into the official index from the first read, hashed lazily, until seeding installs its own. */
function installPackagedOverlay(runtime: PartBRuntime): void {
    let hash: string | null | undefined;

    try {
        const identity = runtime.services.get("host.package").identity();
        const dir = packagedCoreRecipeDir(identity.root);

        if (dir === undefined) {
            return;
        }

        runtime.indexCore().setOverlayIfNone(
            coreIndexOverlay({
                version: identity.version,
                hash: () => {
                    if (hash === undefined) {
                        try {
                            hash = runtime.services.get("formats.recipe-hash").hashDirectorySync(dir);
                        } catch {
                            hash = null;
                        }
                    }

                    return hash ?? undefined;
                },
            }),
        );
    } catch {
        // No package identity: nothing to fold in.
    }
}

/** The contributors part B adds. */
function registerContributors(sous: Sous, runtime: PartBRuntime, seeder: CoreSeeder): void {
    sous.config.contribute(coreContributor(runtime, seeder));
    sous.config.contribute(fetchContributor(runtime));
    sous.config.contribute(configLayersContributor(runtime));
    sous.config.contribute(pluginsContributor());
}

/** The intents part B adds. */
function registerIntents(sous: Sous, runtime: PartBRuntime): void {
    sous.intents.add({
        intent: "lock.rebuild",
        summary: "Rebuild this project's lockfile from its subscriptions and the cached repository indexes",
        input: lockRebuildInputSchema,
        changesConfig: true,
        cli: { aliases: [["locks", "rebuild"]], examples: ["sous lock rebuild", "sous lock rebuild --dry-run"] },
        handle: (input, ctx) => rebuildLock(input, ctx),
    });

    sous.intents.add({
        intent: "lock.show",
        summary: "Show every recipe version this project's lockfile pins",
        input: lockShowInputSchema,
        parallel: true,
        cli: { aliases: [["locks", "show"]], examples: ["sous lock show"] },
        handle: (_input, ctx) => showLock(ctx),
    });

    sous.intents.add({
        intent: "repo.gc",
        summary: "Collect the machine-wide recipe store back down to its size cap",
        input: repoGcInputSchema,
        cli: { aliases: [["repos", "gc"]], examples: ["sous repo gc", "sous repo gc --dry-run", "sous repo gc --max-bytes 268435456"] },
        handle: (input, ctx) => collectStore(input, ctx),
    });

    sous.intents.add({
        intent: "repo.link",
        summary: "Point a repository at a working copy on this machine instead of a published version",
        description:
            "'sous repo link <path>' links the checkout already at that path, where it is, adding the repository to this project first if it has not been added yet. " +
            "'sous repo link <name-or-url>' clones the repository into .sous/repos and links that clone. " +
            "'sous repo link <name-or-url> <path>' links the checkout at that path to that repository, and clones nothing. " +
            "A checkout that was already on disk is fetched and compared with upstream; only the branch flags and --latest change it.",
        input: repoLinkInputSchema,
        changesConfig: true,
        cli: {
            aliases: [["repos", "link"]],
            positional: ["repo", "path"],
            flags: { yes: { short: "y", aliases: ["force", "trust"] } },
            examples: [
                "sous repo link ../sous-recipes",
                "sous repo link sous-recipes",
                "sous repo link sous-recipes ~/Projects/sous-recipes",
                "sous repo link https://github.com/sous-io/sous-recipes",
                "sous repo link sous-recipes --global",
                "sous repo link sous-recipes --latest",
                "sous repo link sous-recipes --generate-branch",
                "sous repo link sous-recipes --branch my-change --latest",
            ],
        },
        agent: { usage: "Use to edit a repository's recipes in a working copy. Pass yes: true to trust a repository the project does not trust yet." },
        handle: (input, ctx) => linkRepo(input, ctx, runtime),
    });

    sous.intents.add({
        intent: "repo.unlink",
        summary: "Stop reading a repository from a working copy and go back to its pinned versions",
        input: repoUnlinkInputSchema,
        changesConfig: true,
        cli: {
            aliases: [["repos", "unlink"]],
            positional: ["repo"],
            flags: { yes: { short: "y", aliases: ["force", "trust"] } },
            examples: ["sous repo unlink sous-recipes", "sous repo unlink sous-recipes --update", "sous repo unlink sous-recipes --remove", "sous repo unlink sous-recipes --global"],
        },
        handle: (input, ctx) => unlinkRepo(input, ctx, runtime),
    });
}
