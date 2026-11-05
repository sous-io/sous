/**
 * Which recipes are active on this machine.
 *
 * The active recipes are the `active-recipe` entities the `recipes.fetch` contributor adds once
 * their files are on disk: the locked recipes reached from the subscriptions switched on here. Every
 * other locked recipe is skipped, with one sentence saying why, and keeps its pins.
 */

import type { BuiltConfig, ServiceReader } from "@sous-io/plugin-api";
import type { ContentKind, Lockfile, VariableDefinition } from "@sous-io/plugin-formats/types";
import type { ActiveRecipeContent, ActiveRecipeEntity, RecipesActive, SkippedRecipe, StillBuiltRecipe } from "../types.js";
import { emptyLockfile, keysHeldBySubscription, lockedClosure, PROJECT_HOLDER } from "./lock-holds.js";
import { configuredRepos, configuredSubscriptions, setBy } from "./project.js";
import { compareBytewise } from "./util.js";

/** The lockfile keys reachable from the subscriptions switched on, by the holder lists. */
export function reachableKeys(lock: Lockfile, subscriptions: Record<string, { enabled?: boolean }>): string[] {
    const roots = Object.entries(subscriptions)
        .filter(([, entry]) => entry?.enabled !== false)
        .flatMap(([key]) => keysHeldBySubscription(lock, key));

    return lockedClosure(lock, roots);
}

/** Names joined for a sentence: `a`, `a and b`, `a, b and c`. */
function joinNames(names: readonly string[]): string {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The recipes of switched-off subscriptions that are built anyway, because built recipes depend
 * on them, each with one sentence saying so.
 *
 * ```ts
 * // acme/base switched off; built: acme/base, acme/widget, acme/gadget (both depend on acme/base)
 * stillBuilt(lock, subscriptions, built);
 * // -> [{ key: "acme/base", subscription: "acme/base", neededBy: ["acme/gadget", "acme/widget"],
 * //       message: "acme/base is switched off but still built: acme/gadget and acme/widget depend on it." }]
 * ```
 *
 * @param built - The keys built here: the active recipes, or the keys reached from the subscriptions switched on.
 * @param setByOf - The file that switched a subscription off, when known.
 */
export function stillBuilt(
    lock: Lockfile,
    subscriptions: Record<string, { enabled?: boolean } | undefined>,
    built: ReadonlySet<string>,
    setByOf: (subscription: string) => string | undefined = () => undefined,
): StillBuiltRecipe[] {
    const found: StillBuiltRecipe[] = [];
    const seen = new Set<string>();

    for (const subscription of Object.keys(subscriptions).sort(compareBytewise)) {
        if (subscriptions[subscription]?.enabled !== false) {
            continue;
        }

        for (const key of keysHeldBySubscription(lock, subscription)) {
            const neededBy = [...new Set(lock.recipes[key]!.requestedBy.filter((holder) => holder !== PROJECT_HOLDER && built.has(holder)))].sort(compareBytewise);

            if (seen.has(key) || !built.has(key) || neededBy.length === 0) {
                continue;
            }

            seen.add(key);

            const setBy = setByOf(subscription);

            found.push({
                key,
                subscription,
                neededBy,
                ...(setBy === undefined ? {} : { setBy }),
                message: `${key} is switched off but still built: ${joinNames(neededBy)} ${neededBy.length === 1 ? "depends" : "depend"} on it.`,
            });
        }
    }

    return found;
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

    switchedOffButBuilt(): StillBuiltRecipe[] {
        const active = new Set(this.config.entities.list("active-recipe").map((entity) => entity.id));

        return stillBuilt(this.lockfile(), configuredSubscriptions(this.config), active, (subscription) => setBy(this.config, ["subscriptions", subscription, "enabled"]));
    }

    contents(kind: ContentKind): ActiveRecipeContent[] {
        return this.services.get("recipes.contents").of(this.list(), kind);
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
                const where = file === undefined ? "" : ` (${file})`;
                // A recipe the switched-off subscription reaches only as a dependency has no subscription of its own.
                const indirect = !keysHeldBySubscription(lock, off).includes(key);

                skipped.push({
                    key,
                    reason: "subscription-disabled",
                    subscription: off,
                    ...(indirect ? { indirect: true } : {}),
                    ...(file === undefined ? {} : { setBy: file }),
                    message: indirect ? `Skipped ${key}: reached only through ${off}, which is switched off${where}.` : `Skipped ${key}: its subscription is switched off${where}.`,
                });
                continue;
            }

            skipped.push({ key, reason: "not-reached", message: `Skipped ${key}: no subscription in force reaches it.` });
        }

        return skipped;
    }
}
