/**
 * Small path helpers the compiler shares: include lines, `.tpl.` twins, alias keys, include
 * queries and where an output goes. Pure: nothing here reads the disk.
 */

import os from "node:os";
import path from "node:path";

/**
 * An include line: `@`, a path that ends in `.md` and an optional `?name=value` query, and nothing
 * else. The first character is a sigil, a variable, a dot, a `/` (an absolute path, as the memory
 * targets plugin-memories adds write), a letter, a digit or a glob character; the rest may hold
 * the characters of a path, a `${var}`, a glob and a recipe reference's `repo:` qualifier.
 */
export const INCLUDE_LINE_PATTERN =
    /^@([~#/a-zA-Z0-9_.${}*?[][a-zA-Z0-9_\-/.:${}*?[\],!~#%+^()]*\.md(?:\?[^?\s]*=\S*)?)$/;

/** Whether a line (trailing whitespace removed) is a well-formed include line. */
export function isIncludeLine(line: string): boolean {
    return INCLUDE_LINE_PATTERN.test(line);
}

/**
 * Whether a line that is not a well-formed include still looks like one: it starts with `@` and is
 * a single path-like word, meaning it holds a `/` or a `.md`, or starts with a sigil or a variable
 * (`@~`, `@#`, `@.`, `@$`). A line that merely starts with `@` (a mention followed by words, or a
 * lone `@name`) does not.
 *
 * ```ts
 * looksLikeIncludeLine("@docs/notes.txt");               // true: the include has no .md
 * looksLikeIncludeLine("@alice thanks for the review");  // false
 * looksLikeIncludeLine("@alice");                        // false
 * ```
 */
export function looksLikeIncludeLine(line: string): boolean {
    if (!/^@\S+$/.test(line)) {
        return false;
    }

    const word = line.slice(1);

    return /[/]/.test(word) || /\.md\b/.test(word) || /^[~#.$]/.test(word);
}

/** The marker that makes a file a template, always right before the final extension. */
const TEMPLATE_MARKER = ".tpl";

/**
 * The `.tpl.` twin of a path: `x.md` gives `x.tpl.md`, `x.tpl.md` gives `x.md`, and a path with no
 * extension has no twin.
 */
export function templateTwin(filePath: string): string | undefined {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const ext = path.extname(base);

    if (ext === "" || ext === base) {
        return undefined;
    }

    const stem = base.slice(0, -ext.length);
    const twin = stem.endsWith(TEMPLATE_MARKER) ? `${stem.slice(0, -TEMPLATE_MARKER.length)}${ext}` : `${stem}${TEMPLATE_MARKER}${ext}`;

    return path.join(dir, twin);
}

/** Every candidate followed by its `.tpl.` twin, each once, order kept. */
export function withTemplateTwins(candidates: readonly string[]): string[] {
    const out: string[] = [];

    for (const candidate of candidates) {
        out.push(candidate);

        const twin = templateTwin(candidate);

        if (twin !== undefined) {
            out.push(twin);
        }
    }

    return [...new Set(out)];
}

/**
 * Splits a path into its leading alias key and the rest. The key runs up to the first `/` or `:`.
 *
 * ```ts
 * splitAliasKey("docs/a/b.md");  // { key: "docs", rest: "a/b.md" }
 * splitAliasKey("docs:b.md");    // { key: "docs", rest: "b.md" }
 * splitAliasKey("b.md");         // { key: "b.md", rest: "" }
 * ```
 */
export function splitAliasKey(value: string): { key: string; rest: string } {
    const match = value.match(/^([^/:]+)[/:]([\s\S]*)$/);

    if (!match) {
        return { key: value, rest: "" };
    }

    return { key: match[1]!, rest: match[2]! };
}

/** The `?name=value&...` query an include line may end with, after its `.md`. */
const QUERY_SUFFIX = /^(.*\.md)(\?[^?\s]*=\S*)$/;

/**
 * Splits the query off an include path: `a/b.md?name=value` gives the path `a/b.md` and the query
 * `?name=value`.
 */
export function splitIncludeQuery(raw: string): { path: string; query: string } {
    const match = QUERY_SUFFIX.exec(raw);

    return match === null ? { path: raw, query: "" } : { path: match[1]!, query: match[2]! };
}

/** Expands a leading `~/` (or a lone `~`) to the home directory. */
export function expandHome(value: string, home: string = os.homedir()): string {
    if (value === "~") {
        return home;
    }

    if (value.startsWith("~/")) {
        return path.join(home, value.slice(2));
    }

    return value;
}

/**
 * The file one output writes, or `undefined` when the output names neither a destination file nor
 * a destination directory.
 *
 * A `destinationFile` is used as it stands. A `destinationDir` mirrors the source under it,
 * relative to `globBase` (or by its base name, without one), with `.tpl.` taken out of the name.
 *
 * ```ts
 * resolveOutputPath({ source: "/p/docs/a/x.tpl.md", globBase: "/p/docs" }, { destinationDir: "/out" });
 * // "/out/a/x.md"
 * ```
 */
export function resolveOutputPath(
    unit: { readonly source: string; readonly globBase?: string | undefined },
    output: { readonly destinationFile?: string | undefined; readonly destinationDir?: string | undefined },
): string | undefined {
    if (output.destinationFile) {
        return output.destinationFile;
    }

    if (!output.destinationDir) {
        return undefined;
    }

    const sourceRelative = unit.globBase ? path.relative(unit.globBase, unit.source) : path.basename(unit.source);

    return path.join(output.destinationDir, sourceRelative.replace(/\.tpl\./, "."));
}

/**
 * A stable text form of a variable scope, for the source hash of a rendered output. Keys are
 * sorted, so two scopes holding the same values hash the same.
 */
export function stableVarsFingerprint(vars: Readonly<Record<string, string>>): string {
    return JSON.stringify(
        Object.keys(vars)
            .sort()
            .map((key) => [key, vars[key]]),
    );
}
