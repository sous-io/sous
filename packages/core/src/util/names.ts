/**
 * Names: plugin prefixes and wildcard patterns.
 */

/** The plugin name core registers its own entries under. */
export const CORE_PLUGIN = "@sous-io/core";

/**
 * A plugin's prefix: its package name without the scope and without `plugin-` or `sous-plugin-`.
 *
 * ```ts
 * pluginPrefix("@sous-io/plugin-compiler");   // "compiler"
 * pluginPrefix("sous-plugin-diagrams");       // "diagrams"
 * ```
 */
export function pluginPrefix(pluginName: string): string {
    const bare = pluginName.startsWith("@") ? pluginName.slice(pluginName.indexOf("/") + 1) : pluginName;

    return bare.replace(/^sous-plugin-/, "").replace(/^plugin-/, "");
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
