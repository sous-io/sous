/**
 * Which recipes are active on this machine.
 *
 * The active recipes are the `active-recipe` entities the `recipes.fetch` contributor adds once
 * their files are on disk: the locked recipes reached from the subscriptions switched on here. Every
 * other locked recipe is skipped, with one sentence saying why, and keeps its pins.
 */

import path from "node:path";
import type { BuiltConfig, ServiceReader } from "@sous-io/plugin-api";
import type { ContentKind, Lockfile, VariableDefinition } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeContent, ActiveRecipeEntity, RecipeContentFile, RecipesActive, SkippedRecipe } from "../types.js";
import { emptyLockfile, keysHeldBySubscription, lockedClosure } from "./lock-holds.js";
import { configuredRepos, configuredSubscriptions, setBy } from "./project.js";
import { compareBytewise } from "./util.js";

/** The lockfile keys reachable from the subscriptions switched on, by the holder lists. */
export function reachableKeys(lock: Lockfile, subscriptions: Record<string, { enabled?: boolean }>): string[] {
    const roots = Object.entries(subscriptions)
        .filter(([, entry]) => entry?.enabled !== false)
        .flatMap(([key]) => keysHeldBySubscription(lock, key));

    return lockedClosure(lock, roots);
}

/** `recipes.active`, for one built config. */
export class ActiveRecipes implements RecipesActive {
    private skippedCache: SkippedRecipe[] | undefined;

    constructor(
        private readonly config: BuiltConfig,
        private readonly services: ServiceReader,
    ) {}

    list(): ActiveRecipeEntity[] {
        const order = Object.keys(this.lockfile().recipes);
        const position = (id: string): number => {
            const index = order.indexOf(id);

            return index === -1 ? order.length : index;
        };

        return [...this.config.entities.list("active-recipe")].sort(
            (left, right) => position(left.id) - position(right.id) || compareBytewise(left.id, right.id),
        );
    }

    get(key: string): ActiveRecipeEntity | undefined {
        return this.config.entities.get("active-recipe", key);
    }

    skipped(): SkippedRecipe[] {
        this.skippedCache ??= this.findSkipped();

        return this.skippedCache;
    }

    contents(kind: ContentKind): ActiveRecipeContent[] {
        const globs = this.services.get("host.globs");
        const found: ActiveRecipeContent[] = [];

        for (const recipe of this.list()) {
            for (const content of recipe.manifest.contents ?? []) {
                if (content.kind !== kind) {
                    continue;
                }

                const relative = globs.matchSync(content.include, {
                    cwd: recipe.dir,
                    dot: true,
                    ignore: content.exclude ?? [],
                });
                const files: RecipeContentFile[] = globs
                    .sortBytewise(relative)
                    .map((file) => ({ path: globs.toPosix(file), file: path.join(recipe.dir, file) }));

                found.push({ recipe, kind, files });
            }
        }

        return found;
    }

    variables(): Array<{ readonly recipe: ActiveRecipeEntity; readonly definition: VariableDefinition }> {
        return this.list().flatMap((recipe) => (recipe.manifest.variables ?? []).map((definition) => ({ recipe, definition })));
    }

    private lockfile(): Lockfile {
        try {
            return this.services.get("recipes.lock").read();
        } catch {
            return emptyLockfile();
        }
    }

    private reachable(lock: Lockfile): Set<string> {
        try {
            return new Set(this.services.get("recipes.resolver").reachable(lock));
        } catch {
            return new Set(reachableKeys(lock, configuredSubscriptions(this.config)));
        }
    }

    private findSkipped(): SkippedRecipe[] {
        const lock = this.lockfile();
        const active = new Set(this.config.entities.list("active-recipe").map((entity) => entity.id));
        const reachable = this.reachable(lock);
        const repos = configuredRepos(this.config);
        const subscriptions = configuredSubscriptions(this.config);
        const skipped: SkippedRecipe[] = [];

        for (const [key, entry] of Object.entries(lock.recipes)) {
            if (active.has(key)) {
                continue;
            }

            const repo = repos[entry.repo];

            if (repo === undefined) {
                skipped.push({ key, reason: "untrusted", message: `Skipped ${key}: this project does not trust its repository '${entry.repo}'.` });
                continue;
            }

            if (repo.enabled === false) {
                const file = setBy(this.config, ["repos", entry.repo, "enabled"]);

                skipped.push({
                    key,
                    reason: "repository-disabled",
                    ...(file === undefined ? {} : { setBy: file }),
                    message: `Skipped ${key}: its repository '${entry.repo}' is switched off${file === undefined ? "" : ` (${file})`}.`,
                });
                continue;
            }

            if (reachable.has(key)) {
                skipped.push({ key, reason: "missing", message: `Skipped ${key}: its files are not on this machine yet.` });
                continue;
            }

            const off = Object.keys(subscriptions)
                .sort(compareBytewise)
                .find((subscription) => subscriptions[subscription]?.enabled === false && lockedClosure(lock, keysHeldBySubscription(lock, subscription)).includes(key));

            if (off !== undefined) {
                const file = setBy(this.config, ["subscriptions", off, "enabled"]);

                skipped.push({
                    key,
                    reason: "subscription-disabled",
                    subscription: off,
                    ...(file === undefined ? {} : { setBy: file }),
                    message: `Skipped ${key}: its subscription is switched off${file === undefined ? "" : ` (${file})`}.`,
                });
                continue;
            }

            skipped.push({ key, reason: "not-reached", message: `Skipped ${key}: no subscription in force reaches it.` });
        }

        return skipped;
    }
}
