/**
 * Matching recipe keys (`namespace/recipe`) against the lists a config holds, such
 * as `recipes.memories.first` and `recipes.memories.exclude`.
 *
 * Each entry of such a list is a glob (`communication/*`), or, when it is
 * written between two slashes (`/^tool-usage\//`), a regular expression. A
 * regular expression is written as a string because the config kernel passes
 * every layer through JSON, which has no way to carry a `RegExp`.
 */

import { minimatch } from "minimatch";
import { ConfigError } from "../errors.js";

/** True when the string is written `/.../`, the spelling of a regular expression. */
export function isRegexSpelling(entry: string): boolean {
  return entry.length >= 3 && entry.startsWith("/") && entry.endsWith("/");
}

/**
 * Compiles one entry of a recipe key list into a matcher.
 *
 * @param entry - A glob, or a regular expression written `/.../`.
 * @param where - The config key the entry came from, named in the error, such as
 *   `recipes.memories.exclude`.
 * @throws ConfigError when the entry is a regular expression that does not compile.
 */
function compileEntry(entry: string, where: string): (key: string) => boolean {
  if (isRegexSpelling(entry)) {
    let expression: RegExp;
    try {
      expression = new RegExp(entry.slice(1, -1));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        `The value ${JSON.stringify(entry)} in '${where}' is written as a regular ` +
          `expression, but it is not a valid one: ${reason}`
      );
    }
    return (key) => expression.test(key);
  }
  return (key) => minimatch(key, entry);
}

/**
 * Compiles a list of globs and `/.../` regular expressions into one matcher over
 * recipe keys. The matcher is true when ANY entry matches; an empty or missing
 * list matches nothing.
 *
 * compileRecipeKeyMatcher(["communication/*", "/^tool-usage\\//"], "recipes.memories.first")("communication/tone");
 * // -> true
 *
 * @param entries - The configured list.
 * @param where - The config key the list came from, named in any error.
 * @throws ConfigError when an entry is an invalid regular expression.
 */
export function compileRecipeKeyMatcher(
  entries: readonly string[] | undefined,
  where: string
): (recipeKey: string) => boolean {
  const matchers = (entries ?? []).map((entry) => compileEntry(entry, where));
  return (recipeKey) => matchers.some((matches) => matches(recipeKey));
}
