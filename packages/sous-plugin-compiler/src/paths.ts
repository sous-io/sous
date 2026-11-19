/**
 * Small path helpers the compiler shares: `@` references and include lines, the file types an
 * include takes, `.tpl.` twins, alias keys, include queries and where an output goes. Pure: nothing
 * here reads the disk.
 */

import os from "node:os";
import path from "node:path";

/**
 * Claude Code's rule for an `@` reference in Markdown text: an `@` at the start of a text or after
 * whitespace, then a run of characters that are not whitespace, where a backslash keeps the space
 * after it (`@my\ file.md`). Group 1 is the run, before it is cut at `#`.
 */
export const IMPORT_TOKEN_PATTERN = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

/**
 * The path a reference names under Claude Code's rule, or `undefined` when Claude Code would not
 * import it. The run is cut at its first `#`, `\ ` becomes a space, and the path must start with
 * `./`, `~/`, `/` (and not be only `/`), or a letter, a digit, `.`, `_` or `-`. Trailing
 * punctuation stays part of the path, so `@x.md.` names a file called `x.md.`.
 *
 * ```ts
 * importPath("x.md#setup");     // "x.md"
 * importPath("my\\ file.md");   // "my file.md"
 * importPath("#memories/x.md"); // undefined: nothing is left before the "#"
 * importPath("~ns/recipe/x");   // undefined
 * ```
 */
export function importPath(run: string): string | undefined {
    const hash = run.indexOf("#");
    const cut = (hash === -1 ? run : run.slice(0, hash)).replaceAll("\\ ", " ");

    if (cut === "") {
        return undefined;
    }

    if (cut.startsWith("./") || cut.startsWith("~/") || (cut.startsWith("/") && cut !== "/")) {
        return cut;
    }

    return /^[a-zA-Z0-9._-]/.test(cut) ? cut : undefined;
}

/**
 * The file extensions Claude Code imports, copied from its bundled code (version 2.1.326) and
 * compared in lower case. A file with no extension is imported too. Claude Code's own list also
 * holds ".R", which can never match a lower-cased extension, so it is left out here.
 */
export const IMPORTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
    ".md", ".txt", ".text", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".html", ".htm", ".css", ".scss", ".sass",
    ".less", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".pyi", ".pyw", ".rb", ".erb", ".rake",
    ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".cs", ".swift",
    ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".env", ".ini", ".cfg", ".conf", ".config", ".properties",
    ".sql", ".graphql", ".gql", ".proto", ".vue", ".svelte", ".astro", ".ejs", ".hbs", ".pug", ".jade", ".php", ".pl",
    ".pm", ".lua", ".r", ".dart", ".ex", ".exs", ".erl", ".hrl", ".clj", ".cljs", ".cljc", ".edn", ".hs", ".lhs", ".elm",
    ".ml", ".mli", ".f", ".f90", ".f95", ".for", ".cmake", ".make", ".makefile", ".gradle", ".sbt", ".rst", ".adoc",
    ".asciidoc", ".org", ".tex", ".latex", ".lock", ".log", ".diff", ".patch",
]);

/**
 * Whether a file is of a type an include takes: its extension, in lower case, is one Claude Code
 * imports, or it has none.
 *
 * ```ts
 * isIncludableFile("/p/notes.TXT"); // true
 * isIncludableFile("/p/README");    // true
 * isIncludableFile("/p/logo.png");  // false
 * ```
 */
export function isIncludableFile(file: string): boolean {
    const extension = path.extname(file).toLowerCase();

    return extension === "" || IMPORTABLE_EXTENSIONS.has(extension);
}

/** The characters a glob is made of (the set `host.globs` reads as glob syntax). */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Whether an include path is one of Sous's own forms, which Sous takes only from a line that holds
 * nothing else: a recipe reference (`~namespace/...`), a `#name`, a `${var}`, a glob, or a path
 * with a `?name=value` query. Any other path is a plain path, read by Claude Code's rule.
 *
 * ```ts
 * isSousIncludeForm("~workflow/task-files/x.md"); // true
 * isSousIncludeForm("#memories/a/b.md");          // true
 * isSousIncludeForm("x.md?mood=calm");            // true
 * isSousIncludeForm("~/notes.md");                // false: the home directory, a plain path
 * isSousIncludeForm("docs/guide.md");             // false
 * ```
 */
export function isSousIncludeForm(word: string): boolean {
    const { path: bare, query } = splitIncludeQuery(word);

    return /^~[^/]/.test(word) || word.startsWith("#") || word.includes("${") || GLOB_CHARS.test(bare) || query !== "";
}

/**
 * Whether a line, alone, is an include Sous tries: `@` at the first column and one word, which is
 * one of Sous's own forms or a path Claude Code's rule accepts. Whether the file exists is not
 * checked; a plain path that names no file is left as text.
 *
 * ```ts
 * isIncludeLine("@docs/notes.txt"); // true
 * isIncludeLine("@alice");          // true: included only when a file "alice" exists
 * isIncludeLine("@a.md extra");     // false: a reference inside a line, not an include line
 * ```
 */
export function isIncludeLine(line: string): boolean {
    const match = /^@(\S+)$/.exec(line.trimEnd());

    return match !== null && (isSousIncludeForm(match[1]!) || importPath(match[1]!) !== undefined);
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
