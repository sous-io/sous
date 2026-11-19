/**
 * Matching recipe keys (`namespace/recipe`) against the lists `recipes.memories.first` and
 * `recipes.memories.exclude` hold.
 *
 * Each entry is a glob (`communication/*`), or, when written between two slashes
 * (`/^tool-usage\//`), a regular expression. The matching itself belongs to sous-plugin-host
 * (`compilePatternList`), which `compilation.varOverrides` uses too; these are its names here.
 */

import { compilePatternFinder, compilePatternList, isRegexSpelling, type GlobMatcher } from "@sous-io/sous-plugin-host";

export { isRegexSpelling, type GlobMatcher };

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
 * @throws ConfigError when an entry is an invalid regular expression.
 */
export const compileRecipeKeyMatcher: (entries: readonly string[] | undefined, where: string, isMatch: GlobMatcher) => (recipeKey: string) => boolean =
    compilePatternList;

/**
 * Like {@link compileRecipeKeyMatcher}, but says which entry matched, as a config path
 * (`recipes.memories.exclude[1]`), or `undefined` when none did.
 */
export const compileRecipeKeyFinder: (
    entries: readonly string[] | undefined,
    where: string,
    isMatch: GlobMatcher,
) => (recipeKey: string) => string | undefined = compilePatternFinder;
