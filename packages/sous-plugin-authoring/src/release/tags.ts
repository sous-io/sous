/**
 * Release tags: `namespace/recipe@1.2.3`, one per published version. The recipe manifest is the
 * source of truth for versions; a tag points at the commit a version was published from, and the two
 * must agree.
 */

import type { RepoGit } from "../shared/git.js";

/** A recipe key: `namespace/name`, each lowercase kebab case. */
export const RECIPE_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** One release tag, taken apart. */
export interface RecipeTag {
    /** The tag as git holds it. */
    readonly tag: string;
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
}

/** The recipe key a tag belongs to. */
export function recipeTagKey(tag: RecipeTag): string {
    return `${tag.namespace}/${tag.name}`;
}

/**
 * The tag that publishes one version of one recipe.
 *
 * ```ts
 * tagFor("core", "one", "1.0.0");   // "core/one@1.0.0"
 * ```
 */
export function tagFor(namespace: string, name: string, version: string): string {
    return `${namespace}/${name}@${version}`;
}

/** The tag of one version of a recipe key. */
export function tagOfKey(key: string, version: string): string {
    return `${key}@${version}`;
}

/**
 * Takes a tag apart, or `undefined` when it is not a recipe release tag (a repository may carry tags
 * of its own shape, such as `v1.2.0`).
 */
export function parseRecipeTag(tag: string): RecipeTag | undefined {
    const at = tag.lastIndexOf("@");

    if (at <= 0 || at === tag.length - 1) {
        return undefined;
    }

    const key = tag.slice(0, at);

    if (!RECIPE_KEY_PATTERN.test(key)) {
        return undefined;
    }

    const slash = key.indexOf("/");

    return { tag, namespace: key.slice(0, slash), name: key.slice(slash + 1), version: tag.slice(at + 1) };
}

/** Every recipe release tag in a repository; other tags are left out. */
export async function listRecipeTags(git: RepoGit): Promise<RecipeTag[]> {
    const output = await git.run(["tag", "--list", "*@*"]);
    const tags: RecipeTag[] = [];

    for (const line of output.split("\n")) {
        const parsed = parseRecipeTag(line.trim());

        if (parsed !== undefined) {
            tags.push(parsed);
        }
    }

    return tags;
}

/** Groups tags by recipe key. */
export function groupTagsByKey(tags: readonly RecipeTag[]): Map<string, RecipeTag[]> {
    const grouped = new Map<string, RecipeTag[]>();

    for (const tag of tags) {
        const key = recipeTagKey(tag);
        const list = grouped.get(key);

        if (list === undefined) {
            grouped.set(key, [tag]);
        } else {
            list.push(tag);
        }
    }

    return grouped;
}
