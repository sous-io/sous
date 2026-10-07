import fs from "node:fs";
import path from "node:path";
import { Liquid, type FS } from "liquidjs";
import filterRegistrars from "./filters/index.js";
import tagRegistrars from "./tags/index.js";
import { setSecretNames } from "./lib/secret-scope.js";
import { resolveIncludeFiles, type AliasMap, type ViewMap } from "../lib/include-resolver.js";
import {
  formatNamespaceProblem,
  type NamespaceResolver,
} from "../lib/repos/namespace-resolver.js";

/** Options for alias-aware `{% render %}` path resolution. */
export type EngineAliasOptions = {
  /** Resolved alias map (name → ordered base dirs). */
  aliases?: AliasMap;
  /** The files each view lists, so a render path may name `#memories/...`. */
  views?: ViewMap;
  /** Variable scope for `${var}` substitution in render paths. */
  scope?: Record<string, string>;
  /** Resolver consulted for a `~` recipe reference in a render path. */
  namespaceResolver?: NamespaceResolver;
  /**
   * Absolute path of the template being rendered, handed to the namespace
   * resolver for scoping. Nested partials fall back to the directory LiquidJS
   * resolves them against, which is enough to locate the owning recipe.
   */
  fromFile?: string;
  /**
   * The variable names a recipe declared `secret: true`. `{% showVars %}` and
   * `{% exportScalarVarsJs %}` hide them, along with anything that very probably
   * is a secret.
   */
  secretVariables?: Iterable<string>;
};

/**
 * A node-backed LiquidJS FS that additionally understands alias, `#` name and
 * recipe render paths: `{% render "#project/x.md" %}`, `{% render "@docs/y.md" %}`,
 * `{% render "@${var}/z.md" %}` and `{% render "~workflow/task-files/x.md" %}`.
 * They resolve through the same alias/`#`/recipe/var/relative candidate logic
 * as `@include`, and a glob renders the first file it matches. The leading `@`
 * is optional for a `~` or `#` path, since the sigil already marks the path as
 * symbolic rather than relative. Every other path uses standard root-based
 * resolution.
 *
 * @param opts - Alias map, variable scope, namespace resolver and including file.
 * @returns A LiquidJS FS implementation.
 */
function createAliasFS(opts: EngineAliasOptions): FS {
  const aliases = opts.aliases ?? {};
  const scope = opts.scope ?? {};

  /**
   * Resolve an `@`-path, `~`-path or `#`-path to its first existing file, or
   * the first candidate. Returns null for ordinary paths so the caller falls
   * back to root-based resolution. Throws when a `~` or `#` reference resolved
   * to nothing and the resolver explained why, so the reason reaches the user
   * instead of a bare "file not found".
   */
  const resolveSymbolic = (file: string, dir: string): string | null => {
    const isAt = file.startsWith("@");
    if (!isAt && !file.startsWith("~") && !file.startsWith("#")) return null;

    const rawPath = isAt ? file.slice(1) : file;
    const { files, candidates, namespaceIssue, hashIssue } = resolveIncludeFiles(rawPath, {
      aliases,
      views: opts.views,
      scope,
      baseDir: dir,
      namespaceResolver: opts.namespaceResolver,
      fromFile: opts.fromFile ?? dir,
    });

    if (files[0] !== undefined) return files[0];

    if (hashIssue) {
      throw new Error(`Cannot render "${file}"\n  ${hashIssue.split("\n").join("\n  ")}`);
    }

    if (namespaceIssue) {
      throw new Error(
        `Cannot render "${file}"\n${formatNamespaceProblem(namespaceIssue)}\n  tried:\n${candidates
          .map((c) => `    - ${c}`)
          .join("\n")}`
      );
    }

    return candidates[0] ?? null;
  };

  return {
    resolve(dir: string, file: string, ext: string): string {
      const symbolic = resolveSymbolic(file, dir);
      if (symbolic) return symbolic;
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
 * @param aliasOpts - Optional alias map, variable scope and namespace resolver,
 *   enabling `@alias/...`, `#name/...`, `@${var}/...` and `~namespace/...` paths in
 *   `{% render %}` (parity with `@include`).
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

  setSecretNames(engine, aliasOpts.secretVariables ?? []);
  return engine;
}
