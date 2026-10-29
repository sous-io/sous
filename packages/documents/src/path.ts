/**
 * Paths: parsing `compilation.targets[7].id` into segments, and writing segments back in one
 * canonical form.
 */
import type { PathInput, PathSegment } from "./types.js";

/** A path string that cannot be parsed. */
export class PathSyntaxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PathSyntaxError";
    }
}

/** A key that can be written without quotes. */
const BARE_KEY = /^[A-Za-z0-9_$][A-Za-z0-9_$-]*$/;

/** Parsed path strings, so a path used on every pass is parsed once. */
const cache = new Map<string, readonly PathSegment[]>();
const CACHE_LIMIT = 5000;

/**
 * Turns a path into segments. Strings use dots between keys, `"..."` around a key holding other
 * characters, and `[n]` for an array index; `""` is the root.
 *
 * ```ts
 * parsePath('subscriptions."workflow/x".enabled');   // ["subscriptions", "workflow/x", "enabled"]
 * parsePath("compilation.targets[7].id");            // ["compilation", "targets", 7, "id"]
 * ```
 */
export function parsePath(input: PathInput): PathSegment[] {
    if (typeof input !== "string") {
        for (const segment of input) {
            checkSegment(segment);
        }

        return [...input];
    }

    let parsed = cache.get(input);

    if (parsed === undefined) {
        parsed = Object.freeze(parsePathString(input));

        if (cache.size >= CACHE_LIMIT) {
            cache.clear();
        }

        cache.set(input, parsed);
    }

    return [...parsed];
}

/**
 * Writes segments as the canonical path string.
 *
 * ```ts
 * formatPath(["subscriptions", "workflow/x", "enabled"]);   // 'subscriptions."workflow/x".enabled'
 * formatPath(["compilation", "targets", 7]);                // "compilation.targets[7]"
 * formatPath([]);                                           // ""
 * ```
 */
export function formatPath(segments: readonly PathSegment[]): string {
    let out = "";

    for (const segment of segments) {
        if (typeof segment === "number") {
            out += `[${segment}]`;
            continue;
        }

        const key = BARE_KEY.test(segment) ? segment : JSON.stringify(segment);

        out += out === "" ? key : `.${key}`;
    }

    return out;
}

/**
 * Whether `prefix` is `path` itself or a path above it.
 *
 * ```ts
 * isPathPrefix(["compilation"], ["compilation", "targets"]);   // true
 * isPathPrefix(["compilation", "targets"], ["compilation"]);   // false
 * ```
 */
export function isPathPrefix(prefix: readonly PathSegment[], path: readonly PathSegment[]): boolean {
    if (prefix.length > path.length) {
        return false;
    }

    for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] !== path[i]) {
            return false;
        }
    }

    return true;
}

/**
 * Whether two paths touch: one is the other, or above it.
 *
 * ```ts
 * pathsOverlap(["a", "b"], ["a"]);   // true
 * pathsOverlap(["a", "b"], ["a", "c"]);   // false
 * ```
 */
export function pathsOverlap(a: readonly PathSegment[], b: readonly PathSegment[]): boolean {
    return isPathPrefix(a, b) || isPathPrefix(b, a);
}

function checkSegment(segment: unknown): void {
    if (typeof segment === "string") {
        return;
    }

    if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) {
        return;
    }

    throw new PathSyntaxError(
        `A path segment must be a key (a string) or an index (a whole number of 0 or more); got ${String(segment)}.`,
    );
}

function parsePathString(text: string): PathSegment[] {
    const segments: PathSegment[] = [];
    let i = 0;
    let expectSegment = true;

    const fail = (what: string): never => {
        throw new PathSyntaxError(`The path ${JSON.stringify(text)} ${what} (at character ${i + 1}).`);
    };

    while (i < text.length) {
        const char = text[i];

        if (char === "[") {
            const close = findBracketEnd(text, i);

            if (close === -1) {
                fail("has a [ with no closing ]");
            }

            const inner = text.slice(i + 1, close).trim();

            if (/^\d+$/.test(inner)) {
                segments.push(Number(inner));
            } else if (inner.startsWith('"')) {
                segments.push(parseQuoted(inner, fail));
            } else {
                fail(`has [${inner}], which is neither an index nor a quoted key`);
            }

            i = close + 1;
            expectSegment = false;
        } else if (char === ".") {
            if (expectSegment) {
                fail("has an empty key");
            }

            i++;
            expectSegment = true;

            if (i === text.length) {
                fail("ends with a dot");
            }
        } else if (!expectSegment) {
            fail("needs a dot between keys");
        } else if (char === '"') {
            const end = findQuoteEnd(text, i);

            if (end === -1) {
                fail("has a quote with no closing quote");
            }

            segments.push(parseQuoted(text.slice(i, end + 1), fail));
            i = end + 1;
            expectSegment = false;
        } else {
            let end = i;

            while (end < text.length && text[end] !== "." && text[end] !== "[") {
                end++;
            }

            segments.push(text.slice(i, end));
            i = end;
            expectSegment = false;
        }
    }

    return segments;
}

function parseQuoted(quoted: string, fail: (what: string) => never): string {
    try {
        const value: unknown = JSON.parse(quoted);

        if (typeof value === "string") {
            return value;
        }
    } catch {
        // falls through to the failure below
    }

    return fail(`has a quoted key that is not a valid JSON string: ${quoted}`);
}

function findQuoteEnd(text: string, start: number): number {
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === "\\") {
            i++;
        } else if (text[i] === '"') {
            return i;
        }
    }

    return -1;
}

function findBracketEnd(text: string, start: number): number {
    let i = start + 1;

    while (i < text.length && text[i] === " ") {
        i++;
    }

    if (text[i] === '"') {
        const end = findQuoteEnd(text, i);

        if (end === -1) {
            return -1;
        }

        i = end + 1;
    }

    return text.indexOf("]", i);
}
