/**
 * Names: plugin prefixes and wildcard patterns.
 */

/** The plugin name core registers its own entries under. */
export const CORE_PLUGIN = "@sous-io/sous-lib-core";

/**
 * A plugin's prefix: its package name without the scope and without `plugin-` or `sous-plugin-`.
 *
 * ```ts
 * pluginPrefix("@sous-io/sous-plugin-compiler");   // "compiler"
 * pluginPrefix("sous-plugin-diagrams");       // "diagrams"
 * ```
 */
export function pluginPrefix(pluginName: string): string {
    const bare = pluginName.startsWith("@") ? pluginName.slice(pluginName.indexOf("/") + 1) : pluginName;

    return bare.replace(/^sous-plugin-/, "").replace(/^plugin-/, "");
}

/** How a built-in plugin's package name starts, since sous 1.1.0. */
const BUILT_IN_PREFIX = "@sous-io/sous-plugin-";

/** How it started before: `@sous-io/plugin-<name>`. */
const FORMER_BUILT_IN_PREFIX = "@sous-io/plugin-";

/**
 * The name a built-in plugin had before sous 1.1.0, when the built-in plugins were
 * `@sous-io/plugin-<name>`; `undefined` for any other plugin. A project's config may still name a
 * plugin that way under `plugins.options`, `plugins.disabled` and the `replace` tables.
 *
 * ```ts
 * formerPluginName("@sous-io/sous-plugin-codex");   // "@sous-io/plugin-codex"
 * formerPluginName("sous-plugin-diagrams");         // undefined
 * ```
 */
export function formerPluginName(pluginName: string): string | undefined {
    return pluginName.startsWith(BUILT_IN_PREFIX) ? `${FORMER_BUILT_IN_PREFIX}${pluginName.slice(BUILT_IN_PREFIX.length)}` : undefined;
}

/**
 * A plugin name as it is now: a built-in plugin's name from before sous 1.1.0 becomes its new one;
 * every other name is returned as it is.
 *
 * ```ts
 * currentPluginName("@sous-io/plugin-claude-code");   // "@sous-io/sous-plugin-claude-code"
 * currentPluginName("@sous-io/plugin-api");           // "@sous-io/sous-plugin-api"
 * currentPluginName("sous-plugin-diagrams");          // "sous-plugin-diagrams"
 * ```
 */
export function currentPluginName(pluginName: string): string {
    return pluginName.startsWith(FORMER_BUILT_IN_PREFIX)
        ? `${BUILT_IN_PREFIX}${pluginName.slice(FORMER_BUILT_IN_PREFIX.length)}`
        : pluginName;
}

/** The first part of a dotted name: `diagrams.render` → `diagrams`. */
export function namePrefix(name: string): string {
    const dot = name.indexOf(".");

    return dot === -1 ? name : name.slice(0, dot);
}

const patternCache = new Map<string, RegExp>();

/**
 * Whether a wildcard pattern matches a name. `*` matches any run of characters, dots and slashes
 * included, so `*.before` matches `subscription.add.before` and `confd/*` matches `confd/610-mac.jsonc`.
 */
export function matchesWildcard(pattern: string, name: string): boolean {
    if (!pattern.includes("*")) {
        return pattern === name;
    }

    let regex = patternCache.get(pattern);

    if (!regex) {
        const source = pattern.split("*").map(escapeRegExp).join(".*");

        regex = new RegExp(`^${source}$`, "s");
        patternCache.set(pattern, regex);
    }

    return regex.test(name);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
