import { Hash, type Liquid } from "liquidjs";
import type { Context } from "liquidjs/dist/context/context.js";
import type { TagToken } from "liquidjs/dist/tokens/tag-token.js";
import { globFiles, parseGlobList, type GlobFile } from "../lib/glob-files.js";

/**
 * Registers the `{% listFiles root="..." include="..." exclude="..." %}` tag.
 * It globs files under `root` and renders them directly as a simple markdown
 * bullet list of file names — the convenience counterpart to `getFiles`.
 *
 * For custom presentation (or to read file metadata), use `getFiles` with a
 * `{% for %}` loop instead. `listFiles` is intentionally glob-only and emits a
 * fixed format.
 *
 * Attribute values may be quoted strings or scope variables. `include`/`exclude`
 * are comma-separated glob patterns matched relative to `root`. An optional
 * `relative="true"` renders relative paths instead of bare file names.
 */
export function registerListFilesTag(engine: Liquid): void {
  engine.registerTag("listFiles", {
    parse(token: TagToken) {
      this.hash = new Hash(token.args, true);
    },

    *render(ctx: Context): Generator<unknown, string, Record<string, unknown>> {
      const hash = yield this.hash.render(ctx);
      const files = (yield resolveFiles(hash)) as unknown as GlobFile[];
      const useRelative = String(hash.relative ?? "") === "true";

      if (files.length === 0) return "";
      return files
        .map((f) => `- ${useRelative ? f.relPath : f.name}`)
        .join("\n");
    },
  });
}

/**
 * Resolve the glob attributes from a rendered hash into file records.
 *
 * @param hash - The rendered tag attributes (`root`, `include`, `exclude`).
 * @returns The matched files.
 */
async function resolveFiles(hash: Record<string, unknown>): Promise<GlobFile[]> {
  const root = hash.root != null ? String(hash.root) : "";
  if (!root) {
    throw new Error('listFiles: a "root" attribute is required');
  }
  return globFiles({
    root,
    include: parseGlobList(hash.include != null ? String(hash.include) : undefined),
    exclude: parseGlobList(hash.exclude != null ? String(hash.exclude) : undefined),
  });
}
