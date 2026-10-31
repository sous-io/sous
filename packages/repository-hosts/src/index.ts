/**
 * What the `repository-host` plugins (plugin-github, plugin-gitlab, plugin-local) share, so each
 * part has one implementation: taking URLs apart, the token sources and the one-line check on
 * every token command, the HTTP and git read strategies, fetching a recipe's folder, and driving a host's CLI.
 *
 * Not a plugin: a library, like `documents`. Trying the strategies in order, remembering what
 * worked and the combined error belong to `recipes.index-cache` (plugin-recipes), which reads every
 * host's `readStrategies` and `tokenSources`.
 */

export * from "./cli.js";
export * from "./git-strategy.js";
export * from "./http-strategy.js";
export * from "./recipe-tree.js";
export * from "./token-output.js";
export * from "./token-sources.js";
export type * from "./types.js";
export * from "./urls.js";
