/**
 * The memories the active recipes publish, and the config's selection of them.
 *
 * Only a recipe whose lockfile kind is `subscribes` publishes memories: one held only through
 * `depends` is a library and contributes nothing. A memory is a file matched by an include pattern
 * of a manifest `contents` entry of `kind: memories`; its name is its path relative to the static
 * base of that pattern, and the `#memories` view lists it at `<namespace>/<recipe>/<name>`.
 *
 * Order: a recipe comes after every active recipe it depends on or subscribes to, ties by recipe
 * key (bytewise), and the recipes matching `recipes.memories.first` move to the front in that same
 * relative order. Within a recipe, files are in bytewise order of their names. The memories of
 * recipes matching `recipes.memories.exclude` are left out, and listed as excluded.
 */

import path from "node:path";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import type { ActiveRecipeEntity } from "@sous-io/plugin-recipes/types";
import { compileRecipeKeyFinder, compileRecipeKeyMatcher } from "./key-matcher.js";
import type { MemoriesSettings, Memory } from "./types.js";

/** The parts of `host.globs` the listing uses. */
export type MemoryGlobs = Pick<
    HostGlobs,
    "matchSync" | "isMatch" | "staticBase" | "compareBytewise" | "realPathInside" | "toPosix"
>;

/** The fields of an active recipe the listing reads. */
export type MemoryRecipe = Pick<ActiveRecipeEntity, "id" | "repo" | "kind" | "requestedBy" | "dir" | "manifest">;

/** A memory the selection left out, and the setting that did it. */
export interface ExcludedMemory {
    readonly memory: Memory;
    /** The config path of the entry that matched: `recipes.memories.exclude[0]`. */
    readonly by: string;
}

/** What selecting memories gives. */
export interface MemorySelectionResult {
    /** In view order. */
    readonly selected: Memory[];
    readonly excluded: ExcludedMemory[];
}

/** What selecting needs. */
export interface SelectMemoriesOptions {
    /** The active recipes. */
    readonly recipes: readonly MemoryRecipe[];
    /** `recipes.memories`; missing lists are empty. */
    readonly settings?: Partial<MemoriesSettings> | undefined;
    readonly globs: MemoryGlobs;
    /** Gets one sentence for each memory skipped because it is a link leading out of its recipe. */
    readonly onWarning?: (message: string) => void;
}

/** The config paths of the two lists, named in errors and in {@link ExcludedMemory.by}. */
export const FIRST_KEY = "recipes.memories.first";
export const EXCLUDE_KEY = "recipes.memories.exclude";

/**
 * Orders recipe keys so each comes after every recipe it depends on or subscribes to, ties by key.
 * A recipe's `requestedBy` names the recipes that asked for it, which is the dependency edge read
 * backwards. A cycle leaves its members in key order at the end.
 *
 * ```ts
 * // z/zeta is requested by a/alpha
 * dependencyOrder([alpha, beta, zeta], compareBytewise);
 * // -> ["b/beta", "z/zeta", "a/alpha"]
 * ```
 */
export function dependencyOrder(
    recipes: readonly Pick<MemoryRecipe, "id" | "requestedBy">[],
    compare: (left: string, right: string) => number,
): string[] {
    const waitingOn = new Map<string, Set<string>>();

    for (const recipe of recipes) {
        waitingOn.set(recipe.id, new Set());
    }

    for (const dependency of recipes) {
        for (const holder of dependency.requestedBy) {
            if (holder !== dependency.id) {
                waitingOn.get(holder)?.add(dependency.id);
            }
        }
    }

    const ordered: string[] = [];
    const done = new Set<string>();
    const remaining = [...waitingOn.keys()].sort(compare);

    while (remaining.length > 0) {
        const index = remaining.findIndex((key) => [...waitingOn.get(key)!].every((dep) => done.has(dep)));

        if (index === -1) {
            ordered.push(...remaining);
            break;
        }

        const [key] = remaining.splice(index, 1);

        ordered.push(key!);
        done.add(key!);
    }

    return ordered;
}

/**
 * Every memory one recipe publishes, in bytewise order of their names. A file that is a link
 * leading outside the recipe's directory is skipped, with a warning.
 */
export function recipeMemories(
    recipe: MemoryRecipe,
    globs: MemoryGlobs,
    onWarning: (message: string) => void = () => {},
): Memory[] {
    const byFile = new Map<string, Memory>();

    for (const content of recipe.manifest.contents ?? []) {
        if (content.kind !== "memories") {
            continue;
        }

        for (const include of content.include) {
            const base = globs.staticBase(globs.toPosix(path.join(recipe.dir, include)));
            const files = globs.matchSync(include, {
                cwd: recipe.dir,
                absolute: true,
                dot: true,
                onlyFiles: true,
                ignore: content.exclude ?? [],
            });

            for (const file of files) {
                if (byFile.has(file)) {
                    continue;
                }

                if (globs.realPathInside(file, recipe.dir) === undefined) {
                    onWarning(
                        `The memory ${file} of the recipe ${recipe.id} was left out, because it is a link ` +
                            `that leads outside the recipe's directory. Replace the link with the file itself.`,
                    );
                    continue;
                }

                byFile.set(file, {
                    recipe: recipe.id,
                    repository: recipe.repo,
                    name: globs.toPosix(path.relative(base, file)),
                    path: file,
                });
            }
        }
    }

    return [...byFile.values()].sort((a, b) => globs.compareBytewise(a.name, b.name));
}

/**
 * The active recipes' memories, ordered and filtered by `recipes.memories`.
 *
 * @throws ConfigError when an entry of `first` or `exclude` is an invalid regular expression.
 */
export function selectMemories(options: SelectMemoriesOptions): MemorySelectionResult {
    const { recipes, globs } = options;
    const isMatch = (key: string, pattern: string) => globs.isMatch(key, pattern);
    const isFirst = compileRecipeKeyMatcher(options.settings?.first, FIRST_KEY, isMatch);
    const excludedBy = compileRecipeKeyFinder(options.settings?.exclude, EXCLUDE_KEY, isMatch);
    const byKey = new Map(recipes.map((recipe) => [recipe.id, recipe]));

    const order = dependencyOrder(recipes, (a, b) => globs.compareBytewise(a, b));
    const leading = order.filter((key) => isFirst(key));
    const rest = order.filter((key) => !isFirst(key));

    const selected: Memory[] = [];
    const excluded: ExcludedMemory[] = [];

    for (const key of [...leading, ...rest]) {
        const recipe = byKey.get(key)!;

        if (recipe.kind !== "subscribes") {
            continue;
        }

        const memories = recipeMemories(recipe, globs, options.onWarning);
        const by = excludedBy(key);

        if (by === undefined) {
            selected.push(...memories);
        } else {
            excluded.push(...memories.map((memory) => ({ memory, by })));
        }
    }

    return { selected, excluded };
}

/** The path the `#memories` view lists a memory at: `<namespace>/<recipe>/<name>`. */
export function viewPath(memory: Memory): string {
    return `${memory.recipe}/${memory.name}`;
}
