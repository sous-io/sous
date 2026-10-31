/**
 * The entries sous provides itself, as part A reads them. The built-in repository and the `core`
 * subscription are added by part B's `recipes.core` contributor; this module only names what part
 * A's intents need to tell such an entry from one a person wrote.
 */

import { enabledEntries } from "../part-b/support.js";

export { BUILT_IN_ADDED_BY, CORE_NAMESPACE, OFFICIAL_REPO_NAME } from "../part-b/constants.js";
export { isBuiltInEntry } from "../part-b/core/core-recipe.js";

/** The `addedBy` of an entry a person added. */
export const USER_ADDED_BY = "user";

/** Every entry of a config map whose `enabled` is not `false`. */
export function withoutDisabled<T extends { enabled?: boolean }>(entries: unknown): Record<string, T> {
    return enabledEntries(typeof entries === "object" && entries !== null && !Array.isArray(entries) ? (entries as Record<string, T>) : undefined);
}
