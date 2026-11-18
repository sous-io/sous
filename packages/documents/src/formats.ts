/**
 * Which format a file is edited in, and how it writes comments, chosen from its path.
 */
import { HASH_COMMENTS, HTML_COMMENTS, SLASH_COMMENTS, type CommentStyle } from "./lines.js";
import type { DocumentFormat } from "./types.js";

/**
 * Every format a file can be edited in: one of the {@link DocumentFormat}s, edited through nodes
 * with `parseDocument`, or `lines`, a plain text file edited as a list of lines with `parseLines`.
 */
export type FileFormat = DocumentFormat | "lines";

/** Whether a `.json` file, by convention, allows comments and trailing commas. */
function isJsoncByConvention(path: string, lowerName: string): boolean {
    return /^(tsconfig|jsconfig)(\..+)?\.json$/.test(lowerName)
        || lowerName === "devcontainer.json"
        || lowerName === ".devcontainer.json"
        || lowerName === ".eslintrc.json"
        || /(^|[\\/])\.vscode[\\/][^\\/]+\.json$/i.test(path);
}

/** Plain text files known by their whole name. */
const LINE_NAMES = new Set([".gitattributes", "CODEOWNERS", ".nvmrc", ".node-version", ".tool-versions", ".python-version", ".env"]);

const EXTENSIONS: Record<string, FileFormat> = {
    ".json": "json",
    ".jsonc": "jsonc",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".md": "markdown",
    ".markdown": "markdown",
    ".mdx": "markdown",
    ".txt": "lines",
};

/**
 * The format to edit a file in, from its path, or `undefined` when the file is not one Sous
 * knows how to edit (TOML among them, for now).
 *
 * - `.json` is `json`, except files that by convention hold comments, which are `jsonc`:
 *   `tsconfig*.json`, `jsconfig*.json`, `devcontainer.json`, `.eslintrc.json`, and any `.json`
 *   file in a `.vscode` folder. Both are read the same way, comments allowed.
 * - `.jsonc` is `jsonc`; `.yaml` and `.yml` are `yaml`.
 * - `.md`, `.markdown` and `.mdx` are `markdown`: the document is the YAML frontmatter.
 * - Ignore files (`.gitignore`, `.dockerignore`, any name starting with `.` and ending in
 *   `ignore`), `.gitattributes`, `CODEOWNERS`, `.env` and `.env.*`, version pins such as `.nvmrc`,
 *   and `.txt` files are `lines`.
 *
 * ```ts
 * formatForPath(".claude/settings.json");   // "json"
 * formatForPath(".claude/agents/reviewer.md");   // "markdown"
 * formatForPath("docs/.gitignore");   // "lines"
 * formatForPath("config.toml");   // undefined
 * ```
 */
export function formatForPath(path: string): FileFormat | undefined {
    const name = baseName(path);
    const lower = name.toLowerCase();

    if (lower.endsWith(".json") && isJsoncByConvention(path, lower)) {
        return "jsonc";
    }

    if (LINE_NAMES.has(name) || /^\..+ignore$/.test(lower) || lower.startsWith(".env.")) {
        return "lines";
    }

    const dot = lower.lastIndexOf(".");

    return dot <= 0 ? undefined : EXTENSIONS[lower.slice(dot)];
}

/**
 * How a file writes comments, from its path: HTML comments for Markdown, HTML, XML and SVG; `//`
 * for JavaScript, TypeScript, JSONC and the C family; `#` for everything else (`.gitignore`,
 * shell, YAML, TOML, `.env`).
 *
 * ```ts
 * commentStyleForPath(".gitignore");   // { open: "#" }
 * commentStyleForPath("CLAUDE.md");   // { open: "<!--", close: "-->" }
 * ```
 */
export function commentStyleForPath(path: string): CommentStyle {
    const lower = baseName(path).toLowerCase();
    const dot = lower.lastIndexOf(".");
    const extension = dot <= 0 ? "" : lower.slice(dot);

    if ([".md", ".markdown", ".mdx", ".html", ".htm", ".xml", ".svg", ".vue"].includes(extension)) {
        return HTML_COMMENTS;
    }

    if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".jsonc", ".json5", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".java", ".kt", ".go", ".rs", ".swift", ".scss", ".less"].includes(extension)) {
        return SLASH_COMMENTS;
    }

    return HASH_COMMENTS;
}

function baseName(path: string): string {
    const parts = path.split(/[\\/]/);

    return parts[parts.length - 1] ?? path;
}
