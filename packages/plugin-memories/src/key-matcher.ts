/**
 * Matching recipe keys (`namespace/recipe`) against the lists `recipes.memories.first` and
 * `recipes.memories.exclude` hold.
 *
 * Each entry is a glob (`communication/*`), or, when written between two slashes
 * (`/^tool-usage\//`), a regular expression. A regular expression is written as a string because
 * the config is plain JSON, which has no way to carry a `RegExp`.
 */

import { ConfigError } from "@sous-io/plugin-api";

/** Tells whether a key matches a glob: `host.globs.isMatch`, in the plugin. */
export type GlobMatcher = (key: string, pattern: string) => boolean;

/** True when the string is written `/.../`, the spelling of a regular expression. */
export function isRegexSpelling(entry: string): boolean {
    return entry.length >= 3 && entry.startsWith("/") && entry.endsWith("/");
}

/**
 * Compiles one entry into a matcher.
 *
 * @param entry - A glob, or a regular expression written `/.../`.
 * @param where - The config key the entry came from, named in the error.
 * @param isMatch - How a glob is matched.
 * @throws ConfigError when the entry is a regular expression that does not compile.
 */
function compileEntry(entry: string, where: string, isMatch: GlobMatcher): (key: string) => boolean {
    if (!isRegexSpelling(entry)) {
        return (key) => isMatch(key, entry);
    }

    let expression: RegExp;

    try {
        expression = new RegExp(entry.slice(1, -1));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new ConfigError(
            `The value ${JSON.stringify(entry)} in '${where}' is written as a regular expression, but it is not a valid one: ${reason}`,
        );
    }

    return (key) => expression.test(key);
}

/**
 * Compiles a list of globs and `/.../` regular expressions into one matcher over recipe keys. It
 * is true when any entry matches; an empty or missing list matches nothing.
 *
 * ```ts
 * compileRecipeKeyMatcher(["communication/*", "/^tool-usage\\//"], "recipes.memories.first", isMatch)(
 *     "communication/tone",
 * );
 * // -> true
 * ```
 *
 * @param entries - The configured list.
 * @param where - The config key the list came from, named in any error.
 * @param isMatch - How a glob is matched.
 * @throws ConfigError when an entry is an invalid regular expression.
 */
export function compileRecipeKeyMatcher(
    entries: readonly string[] | undefined,
    where: string,
    isMatch: GlobMatcher,
): (recipeKey: string) => boolean {
    const matchers = (entries ?? []).map((entry) => compileEntry(entry, where, isMatch));

    return (recipeKey) => matchers.some((matches) => matches(recipeKey));
}

/**
 * Like {@link compileRecipeKeyMatcher}, but says which entry matched, as a config path
 * (`recipes.memories.exclude[1]`), or `undefined` when none did.
 */
export function compileRecipeKeyFinder(
    entries: readonly string[] | undefined,
    where: string,
    isMatch: GlobMatcher,
): (recipeKey: string) => string | undefined {
    const matchers = (entries ?? []).map((entry) => compileEntry(entry, where, isMatch));

    return (recipeKey) => {
        const index = matchers.findIndex((matches) => matches(recipeKey));

        return index === -1 ? undefined : `${where}[${index}]`;
    };
}
