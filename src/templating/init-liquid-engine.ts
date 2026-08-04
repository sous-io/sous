import fs from "node:fs";
import path from "node:path";
import { Liquid, type FS } from "liquidjs";
import filterRegistrars from "./filters/index.js";
import tagRegistrars from "./tags/index.js";
import { resolveIncludeCandidates, type AliasMap } from "../lib/include-resolver.js";

/** Options for alias-aware `{% render %}` path resolution. */
export type EngineAliasOptions = {
  /** Resolved alias map (name → ordered base dirs). */
  aliases?: AliasMap;
  /** Variable scope for `${var}` substitution in render paths. */
  scope?: Record<string, string>;
};

/**
 * A node-backed LiquidJS FS that additionally understands `@`-prefixed render
 * paths — `{% render "@~sous-shared/x.md" %}`, `{% render "@docs/y.md" %}`, or
 * `{% render "@${var}/z.md" %}` — resolving them through the same alias/var/
 * relative candidate logic as `@include`. Non-`@` paths use standard root-based
 * resolution.
 *
 * @param opts - Alias map and variable scope.
 * @returns A LiquidJS FS implementation.
 */
function createAliasFS(opts: EngineAliasOptions): FS {
  const aliases = opts.aliases ?? {};
  const scope = opts.scope ?? {};

  /** Resolve an `@`-path to its first existing candidate, or the first candidate. */
  const resolveAt = (file: string, dir: string): string | null => {
    if (!file.startsWith("@")) return null;
    const candidates = resolveIncludeCandidates(file.slice(1), { aliases, scope, baseDir: dir });
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0] ?? null;
  };

  return {
    resolve(dir: string, file: string, ext: string): string {
      const at = resolveAt(file, dir);
      if (at) return at;
      // Standard resolution: join against the root dir, applying ext if missing.
      const joined = path.resolve(dir, file);
      if (ext && !path.extname(joined)) return joined + ext;
      return joined;
    },
    existsSync: (filepath: string) => fs.existsSync(filepath),
    exists: async (filepath: string) => fs.existsSync(filepath),
    readFileSync: (filepath: string) => fs.readFileSync(filepath, "utf8"),
    readFile: async (filepath: string) => fs.promises.readFile(filepath, "utf8"),
    dirname: (file: string) => path.dirname(file),
    sep: path.sep,
  };
}

/**
 * Creates a configured LiquidJS engine instance for Sous template rendering.
 * Registers built-in Sous filters and tags.
 *
 * @param roots - Filesystem root paths searched (in order) when resolving
 *   `{% render %}` partials (relative paths resolve against these).
 * @param aliasOpts - Optional alias map + scope enabling `@alias/...` and
 *   `@${var}/...` paths in `{% render %}` (parity with `@include`).
 */
export function createLiquidEngine(roots: string[], aliasOpts: EngineAliasOptions = {}): Liquid {
  const engine = new Liquid({
    root: roots,
    extname: "",
    strictVariables: false,
    strictFilters: false,
    fs: createAliasFS(aliasOpts),
  });

  for (const register of filterRegistrars) {
    register(engine);
  }

  for (const register of tagRegistrars) {
    register(engine);
  }

  return engine;
}
