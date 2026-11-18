/**
 * Matching text against a list of patterns written in a config: each entry is a glob
 * (`communication/*`), or, when written between two slashes (`/^tool-usage\//`), a regular
 * expression. A regular expression is written as a string because the config is plain JSON, which
 * has no way to carry a `RegExp`.
 *
 * `recipes.memories.first` and `recipes.memories.exclude` match recipe keys this way, and
 * `compilation.varOverrides` matches output paths; this is the one implementation.
 */

import { ConfigError } from "@sous-io/plugin-api";

/** Tells whether text matches a glob: `host.globs.isMatch`, in a plugin. */
export type GlobMatcher = (text: string, pattern: string) => boolean;

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
function compileEntry(entry: string, where: string, isMatch: GlobMatcher): (text: string) => boolean {
    if (!isRegexSpelling(entry)) {
        return (text) => isMatch(text, entry);
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

    return (text) => expression.test(text);
}

/**
 * Compiles a list of globs and `/.../` regular expressions into one matcher. It is true when any
 * entry matches; an empty or missing list matches nothing.
 *
 * ```ts
 * compilePatternList(["communication/*", "/^tool-usage\\//"], "recipes.memories.first", isMatch)(
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
export function compilePatternList(entries: readonly string[] | undefined, where: string, isMatch: GlobMatcher): (text: string) => boolean {
    const matchers = (entries ?? []).map((entry) => compileEntry(entry, where, isMatch));

    return (text) => matchers.some((matches) => matches(text));
}

/**
 * Like {@link compilePatternList}, but says which entry matched, as a config path
 * (`recipes.memories.exclude[1]`), or `undefined` when none did.
 */
export function compilePatternFinder(entries: readonly string[] | undefined, where: string, isMatch: GlobMatcher): (text: string) => string | undefined {
    const matchers = (entries ?? []).map((entry) => compileEntry(entry, where, isMatch));

    return (text) => {
        const index = matchers.findIndex((matches) => matches(text));

        return index === -1 ? undefined : `${where}[${index}]`;
    };
}
