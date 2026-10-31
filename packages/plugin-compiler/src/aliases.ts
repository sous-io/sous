/**
 * Aliases: the built-in `#` names that stand for directories, and the
 * config's `_aliases`, each resolved to the base directories an include tries, in order.
 */

import path from "node:path";
import type { CompilerAliases } from "./types.js";
import { splitAliasKey } from "./paths.js";

/** An alias name to its ordered base directories. */
export type AliasMap = Record<string, string[]>;

/** Whether an alias name is reserved: `~` is the home directory and recipes, `#` the built-in names. */
export function isReservedAliasName(name: string): boolean {
    return name.startsWith("~") || name.startsWith("#");
}

/**
 * Builds the alias map from the built-in aliases and the user's `_aliases` blocks.
 *
 * Each user block prepends its bases, so a user's entry is tried first and falls through to a
 * built-in alias of the same name. A value may be one string or several, each `${var}`-substituted.
 * A user alias whose name starts with `~` or `#` is reserved: it is reported through `onError` and
 * left out.
 *
 * ```ts
 * buildAliasMap({
 *     builtIns: { "#project": ["/p"] },
 *     userAliases: [{ docs: ["${projectRoot}/docs", "/shared/docs"] }],
 *     substitute: (text) => text.replace("${projectRoot}", "/p"),
 * });
 * // { "#project": ["/p"], docs: ["/p/docs", "/shared/docs"] }
 * ```
 */
export function buildAliasMap(options: {
    builtIns?: AliasMap;
    userAliases?: ReadonlyArray<Readonly<Record<string, string | readonly string[]>> | undefined>;
    substitute?: (text: string) => string;
    onError?: (message: string) => void;
}): AliasMap {
    const substitute = options.substitute ?? ((text: string) => text);
    const out: AliasMap = {};

    for (const [name, bases] of Object.entries(options.builtIns ?? {})) {
        out[name] = [...bases];
    }

    for (const block of options.userAliases ?? []) {
        if (!block) {
            continue;
        }

        for (const [name, value] of Object.entries(block)) {
            if (isReservedAliasName(name)) {
                options.onError?.(
                    `Alias "${name}" is invalid: names beginning with "~" or "#" are reserved ` +
                        `("~" for the home directory and recipe namespaces, "#" for built-in names).`,
                );
                continue;
            }

            const values = typeof value === "string" ? [value] : [...value];
            const bases = values.map((entry) => substitute(entry));

            out[name] = [...bases, ...(out[name] ?? [])];
        }
    }

    return out;
}

/**
 * Expands a leading alias in a config entry path (`entryGlob`, a watch pattern) to one candidate
 * per alias base, in the alias's order. Unlike an include there is no including file to fall back
 * to, so a path that names no alias comes back as the only candidate.
 */
export function resolveAliasPrefix(value: string, aliases: AliasMap): string[] {
    if (path.isAbsolute(value)) {
        return [value];
    }

    const { key, rest } = splitAliasKey(value);

    if (!key || !Object.prototype.hasOwnProperty.call(aliases, key)) {
        return [value];
    }

    return aliases[key]!.map((base) => path.resolve(base, rest));
}

/** The `compiler.aliases` service over a resolved alias map. */
export class AliasService implements CompilerAliases {
    constructor(private readonly map: AliasMap) {}

    all(): Record<string, string[]> {
        return Object.fromEntries(Object.entries(this.map).map(([name, bases]) => [name, [...bases]]));
    }

    get(name: string): string[] | undefined {
        return Object.prototype.hasOwnProperty.call(this.map, name) ? [...this.map[name]!] : undefined;
    }

    split(value: string): { alias: string; rest: string } | undefined {
        const { key, rest } = splitAliasKey(value);

        return Object.prototype.hasOwnProperty.call(this.map, key) ? { alias: key, rest } : undefined;
    }
}
