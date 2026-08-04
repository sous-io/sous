import { Hash, type Liquid } from "liquidjs";
import type { Context } from "liquidjs/dist/context/context.js";
import type { TagToken } from "liquidjs/dist/tokens/tag-token.js";
import { globFiles, parseGlobList, type GlobFile } from "../lib/glob-files.js";
import { splitPositionalName } from "../lib/tag-args.js";
import { importNamedExport } from "../lib/import-export.js";

/**
 * Registers the `{% getFiles <varName> root="..." include="..." exclude="..." import="..." %}`
 * tag. It globs files under `root` and assigns the resulting array to `<varName>`
 * in the template scope. It renders no output — use a `{% for %}` loop to present
 * the results.
 *
 * Each result has `{ path, dir, relPath, name }`. When the optional `import`
 * attribute names an export (e.g. `import="meta"`), each file is dynamically
 * imported and that export is attached under the same key (e.g. `file.meta`);
 * files that fail to import or lack the export are omitted from the results.
 *
 * Attribute values may be quoted strings or scope variables (e.g. `root=tasksDir`).
 * `include`/`exclude` are comma-separated glob patterns matched relative to `root`.
 */
export function registerGetFilesTag(engine: Liquid): void {
  engine.registerTag("getFiles", {
    parse(token: TagToken) {
      const { name, rest } = splitPositionalName(token.args);
      this.varName = name;
      this.hash = new Hash(rest, true);
    },

    *render(ctx: Context): Generator<unknown, string, Record<string, unknown>> {
      const hash = yield this.hash.render(ctx);
      const varName: string | null = this.varName;

      const files = (yield resolveFiles(hash)) as unknown;

      if (varName) {
        (ctx.bottom() as Record<string, unknown>)[varName] = files;
      }
      return "";
    },
  });
}

/** A file record optionally carrying a dynamically-imported export. */
type ResolvedFile = GlobFile & Record<string, unknown>;

/**
 * Resolve the glob attributes from a rendered hash into file records, applying
 * the optional `import` export attachment.
 *
 * @param hash - The rendered tag attributes (`root`, `include`, `exclude`, `import`).
 * @returns The matched files, each optionally carrying the imported export.
 */
async function resolveFiles(hash: Record<string, unknown>): Promise<ResolvedFile[]> {
  const root = hash.root != null ? String(hash.root) : "";
  if (!root) {
    throw new Error('getFiles: a "root" attribute is required');
  }

  const files = await globFiles({
    root,
    include: parseGlobList(hash.include != null ? String(hash.include) : undefined),
    exclude: parseGlobList(hash.exclude != null ? String(hash.exclude) : undefined),
  });

  const importName = hash.import != null ? String(hash.import).trim() : "";
  if (!importName) return files as ResolvedFile[];

  return attachImports(files, importName);
}

/**
 * For each file, dynamically import `importName` and attach it under that key.
 * Files whose import fails or lacks the export are dropped from the result.
 *
 * @param files - The globbed file records.
 * @param importName - The export to read from each file.
 * @returns Files that successfully yielded the export, with it attached.
 */
async function attachImports(files: GlobFile[], importName: string): Promise<ResolvedFile[]> {
  const enriched = await Promise.all(
    files.map(async (file) => {
      const value = await importNamedExport(file.path, importName);
      if (value === undefined) return null;
      return { ...file, [importName]: value };
    })
  );
  return enriched.filter((f): f is ResolvedFile => f !== null);
}
