/**
 * Part A of plugin-recipes: repositories, trust, subscriptions, the active recipes, the store,
 * recipe declarations, the catalog and update plans, and their intents. Part B (`../part-b/`) holds
 * the lockfile, the resolver, the index cache, the core recipe, links, downloads and recipe plugins.
 */

import { jsonSchema, type ServiceReader, type Sous } from "@sous-io/plugin-api";
import { createDirectories } from "@sous-io/plugin-host";
import type { HostDirectories } from "@sous-io/plugin-host/types";
import { ActiveRecipes } from "./active.js";
import { configKeys, DEFAULT_STORE_MAX_BYTES } from "./config-keys.js";
import { Declarations } from "./declarations.js";
import { registerCatalogIntents } from "./intents/catalog.js";
import { registerRepoIntents } from "./intents/repo.js";
import { registerSubscriptionIntents } from "./intents/subscription.js";
import { cachedIndexLookup, fetchedIndexLookup } from "./index-lookups.js";
import { RecipeStore } from "./store.js";
import { Trust } from "./trust.js";
import type { StoreKey } from "../types.js";
import { splitRecipeKey } from "./catalog.js";

/** The entity kinds plugin-recipes defines, when part B has not defined them already. */
export function defineEntityKinds(sous: Sous): void {
    const kinds = new Set(sous.entities.kinds());
    const anyObject = jsonSchema({ type: "object", required: ["id"], additionalProperties: true });

    if (!kinds.has("repository-host")) {
        sous.entities.define("repository-host", anyObject, { description: "A host of recipe repositories, with its read strategies and token sources." });
    }

    if (!kinds.has("active-recipe")) {
        sous.entities.define("active-recipe", anyObject, { description: "A locked recipe reached from the subscriptions switched on on this machine." });
    }
}

/** Registers part A. */
export function registerPartA(sous: Sous): void {
    for (const key of configKeys()) {
        sous.entities.add("config-key", key);
    }

    sous.services.add("recipes.trust", (config, ctx) => new Trust(config, ctx.services), { lifetime: "config" });
    sous.services.add("recipes.active", (_config, ctx) => new ActiveRecipes(ctx.config, ctx.services), { lifetime: "config" });
    sous.services.add("recipes.declarations", (_config, ctx) => new Declarations(() => ctx.services.get("refs.resolver"), () => ctx.services.get("refs.format")), {
        lifetime: "singleton",
    });
    sous.services.add(
        "recipes.store",
        (config, ctx) => {
            const hash = () => ctx.services.get("formats.recipe-hash");
            const entries = () => ctx.services.get("formats.store-entry");

            return new RecipeStore({
                root: ctx.services.get("host.sous-home").paths(ctx.env).store,
                hashDirectory: (directory) => hash().hashDirectory(directory),
                hashesEqual: (left, right) => hash().equal(left, right),
                parseEntry: (value, source) => entries().parse(value, source),
                stringifyEntry: (entry) => entries().stringify(entry),
                ensureRoot: (root) => storeDirectories(sous).ensureKnown("store", root),
                maxBytes: () => config.get("store")?.maxBytes ?? DEFAULT_STORE_MAX_BYTES,
                pinned: () => pinnedStoreKeys(ctx.services),
                warn: (message) => sous.reporter.warning(message),
            });
        },
        { lifetime: "singleton" },
    );

    sous.entities.add("ref-lookup", cachedIndexLookup());
    sous.entities.add("ref-lookup", fetchedIndexLookup());

    registerRepoIntents(sous);
    registerSubscriptionIntents(sous);
    registerCatalogIntents(sous);
}

/**
 * The self-describing directories service the store creates its root with. `host.directories` is a
 * `config` service, which does not exist while the config is built, yet downloads and core seeding
 * write to the store then; so, when it is not there, the same service is made directly from the
 * singleton `host.sous-home` and the entities in force.
 */
export function storeDirectories(sous: Pick<Sous, "services" | "entities">): HostDirectories {
    try {
        return sous.services.get("host.directories");
    } catch {
        return createDirectories({ entities: sous.entities, sousHome: sous.services.get("host.sous-home") });
    }
}

/** Every recipe version this project's lockfile pins, as store keys. */
function pinnedStoreKeys(services: ServiceReader): StoreKey[] {
    try {
        const lock = services.get("recipes.lock").read();

        return Object.entries(lock.recipes).flatMap(([key, entry]) => {
            const identity = lock.repos[entry.repo]?.identity;

            return identity === undefined ? [] : [{ identity, ...splitRecipeKey(key), version: entry.version }];
        });
    } catch {
        return [];
    }
}
