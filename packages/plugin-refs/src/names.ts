/**
 * Names and glob patterns as a ref writes them.
 *
 * Every name or path part of a ref may be a glob pattern (`*`, `**`, `?`, `[..]`, `{a,b}`). The
 * parser only needs to tell a pattern from a name, which `host.globs` decides; matching one against
 * what exists is a lookup's job.
 */

import type { HostGlobs } from "@sous-io/plugin-host/types";

/** A name as the parser accepts it: kebab case, in any case. */
export const NAME_ANY_CASE = /^[a-z][a-z0-9-]*$/i;

/** A name as it is stored: lowercase kebab case. */
export const NAME_STORED = /^[a-z][a-z0-9-]*$/;

/** A variable name, as a recipe's author writes it: camel case. */
export const VARIABLE_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** An environment variable name: whatever a shell accepts. */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The characters a glob pattern standing for a name may use. */
const GLOB_NAME = /^[A-Za-z0-9_\-.*?[\]{},!^]+$/;

/** True when a string is a glob pattern that could stand for a name. */
export function isGlobName(text: string, globs: Pick<HostGlobs, "hasGlob">): boolean {
    return globs.hasGlob(text) && GLOB_NAME.test(text);
}

/**
 * Splits text at `/`, except inside braces, so `{a/b,c}` stays whole.
 *
 * ```ts
 * splitSegments("a/{b/c,d}/e"); // -> ["a", "{b/c,d}", "e"]
 * ```
 */
export function splitSegments(text: string): string[] {
    const segments: string[] = [];
    let depth = 0;
    let current = "";

    for (const character of text) {
        if (character === "{") {
            depth += 1;
        }

        if (character === "}" && depth > 0) {
            depth -= 1;
        }

        if (character === "/" && depth === 0) {
            segments.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    segments.push(current);

    return segments;
}
