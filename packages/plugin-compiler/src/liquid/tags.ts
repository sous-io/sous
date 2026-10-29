/**
 * The built-in tags (`showVars`, `exportScalarVarsJs`, `getFiles`, `listFiles`) and filter
 * (`bulletList`), as `liquid-tag` and `liquid-filter` entities (S6), so plugin-liquid registers
 * them on every engine like any plugin's own.
 */

import { Hash, type Context, type Tag, type TagToken } from "liquidjs";
import type { HostGlobs } from "@sous-io/plugin-host/types";
import type { LiquidExtensionContext, LiquidFilterEntity, LiquidTagEntity, LiquidTagImplementation } from "@sous-io/plugin-liquid/types";
import { globFiles, parseGlobList, type GlobFile } from "./glob-files.js";
import { importNamedExport } from "./import-export.js";
import { secretCheck, sortObjectKeys } from "./secrets.js";
import { splitPositionalName } from "./tag-args.js";

/** What a tag's `this` holds between `parse` and `render`. */
interface TagState {
    varName?: string | null;
    hash?: Hash;
}

/** `host.globs`, which the file tags search with. */
function globsOf(ctx: LiquidExtensionContext): Pick<HostGlobs, "match"> {
    return ctx.services.get("host.globs");
}

/** Whether a value is a scalar a settings module can hold: a string, a finite number or a boolean. */
function isScalar(value: unknown): value is string | number | boolean {
    return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * `{% showVars %}`: every variable in scope as a fenced JSON block. A secret prints as `(hidden)`,
 * so the dump never carries it into an output.
 */
export const showVarsTag: LiquidTagEntity = {
    id: "showVars",
    description: "Dumps every variable in scope as a fenced JSON block, secrets hidden.",
    tag(ctx): LiquidTagImplementation {
        const secrets = secretCheck(ctx);

        return {
            parse() {},
            render(liquidCtx: Context) {
                const seen = new WeakSet<object>();
                const scope = sortObjectKeys(liquidCtx.getAll() as Record<string, unknown>);
                const json = JSON.stringify(
                    scope,
                    (key, value: unknown) => {
                        if (typeof value === "object" && value !== null) {
                            if (seen.has(value)) {
                                return "[Circular]";
                            }

                            seen.add(value);
                        }

                        if (key !== "" && secrets.isSecret(key, value)) {
                            return secrets.hiddenValue;
                        }

                        return value;
                    },
                    2,
                );

                return "# Sous Debug: Variable Dump\n```json\n" + json + "\n```";
            },
        };
    },
};

/**
 * `{% exportScalarVarsJs %}`: every scalar in scope, sorted, as `export default { ... };`, for a
 * `settings.tpl.mjs` that runtime code imports. Secrets are left out, not masked: runtime code
 * would read a masked value as a real one.
 */
export const exportScalarVarsJsTag: LiquidTagEntity = {
    id: "exportScalarVarsJs",
    description: "Writes every scalar variable in scope as an ES module default export, secrets left out.",
    tag(ctx): LiquidTagImplementation {
        const secrets = secretCheck(ctx);

        return {
            parse() {},
            render(liquidCtx: Context) {
                const scalars: Record<string, string | number | boolean> = {};

                for (const [key, value] of Object.entries(liquidCtx.getAll() as Record<string, unknown>)) {
                    if (isScalar(value) && !secrets.isSecret(key, value)) {
                        scalars[key] = value;
                    }
                }

                return `export default ${JSON.stringify(sortObjectKeys(scalars), null, 2)};\n`;
            },
        };
    },
};

/** A file record, with an imported export when `import` names one. */
type ResolvedFile = GlobFile & Record<string, unknown>;

/** The files a tag's rendered attributes name. */
async function resolveFiles(tag: string, ctx: LiquidExtensionContext, hash: Record<string, unknown>): Promise<GlobFile[]> {
    const root = hash.root != null ? String(hash.root) : "";

    if (!root) {
        throw new Error(`${tag}: a "root" attribute is required`);
    }

    return globFiles(globsOf(ctx), {
        root,
        include: parseGlobList(hash.include != null ? String(hash.include) : undefined),
        exclude: parseGlobList(hash.exclude != null ? String(hash.exclude) : undefined),
    });
}

/** Attaches each file's `importName` export; files that fail to import or lack it are dropped. */
async function attachImports(files: GlobFile[], importName: string): Promise<ResolvedFile[]> {
    const enriched = await Promise.all(
        files.map(async (file) => {
            const value = await importNamedExport(file.path, importName);

            return value === undefined ? null : { ...file, [importName]: value };
        }),
    );

    return enriched.filter((file): file is ResolvedFile => file !== null);
}

/**
 * `{% getFiles <varName> root="..." include="..." exclude="..." import="..." %}`: finds files under
 * `root` and assigns them to `<varName>`, each `{ path, dir, relPath, name }`. It renders nothing.
 * With `import="meta"`, each file is imported and its `meta` export attached as `file.meta`.
 */
export const getFilesTag: LiquidTagEntity = {
    id: "getFiles",
    description: "Finds files under a root and assigns them to a variable, optionally with an export of each.",
    tag(ctx): LiquidTagImplementation {
        return {
            parse(this: Tag & TagState, token: TagToken) {
                const { name, rest } = splitPositionalName(token.args);

                this.varName = name;
                this.hash = new Hash(rest, true);
            },

            *render(this: Tag & TagState, liquidCtx: Context): Generator<unknown, string, unknown> {
                const hash = (yield this.hash!.render(liquidCtx)) as Record<string, unknown>;
                let files = (yield resolveFiles("getFiles", ctx, hash)) as GlobFile[];
                const importName = hash.import != null ? String(hash.import).trim() : "";

                if (importName) {
                    files = (yield attachImports(files, importName)) as ResolvedFile[];
                }

                if (this.varName) {
                    (liquidCtx.bottom() as Record<string, unknown>)[this.varName] = files;
                }

                return "";
            },
        };
    },
};

/**
 * `{% listFiles root="..." include="..." exclude="..." relative="true" %}`: finds files under
 * `root` and renders them as a bullet list of names (paths under the root, with `relative`).
 */
export const listFilesTag: LiquidTagEntity = {
    id: "listFiles",
    description: "Renders the files under a root as a bullet list.",
    tag(ctx): LiquidTagImplementation {
        return {
            parse(this: Tag & TagState, token: TagToken) {
                this.hash = new Hash(token.args, true);
            },

            *render(this: Tag & TagState, liquidCtx: Context): Generator<unknown, string, unknown> {
                const hash = (yield this.hash!.render(liquidCtx)) as Record<string, unknown>;
                const files = (yield resolveFiles("listFiles", ctx, hash)) as GlobFile[];
                const relative = String(hash.relative ?? "") === "true";

                return files.map((file) => `- ${relative ? file.relPath : file.name}`).join("\n");
            },
        };
    },
};

/** `{{ items | bulletList }}`: an array as a Markdown bullet list; anything else as text. */
export const bulletListFilter: LiquidFilterEntity = {
    id: "bulletList",
    description: "Turns an array into a Markdown bullet list.",
    filter() {
        return (items: unknown) => {
            if (!Array.isArray(items)) {
                return String(items);
            }

            return items.map((item) => `- ${String(item)}`).join("\n");
        };
    },
};

/** Every built-in tag. */
export const BUILT_IN_TAGS: readonly LiquidTagEntity[] = [showVarsTag, exportScalarVarsJsTag, getFilesTag, listFilesTag];

/** Every built-in filter. */
export const BUILT_IN_FILTERS: readonly LiquidFilterEntity[] = [bulletListFilter];
