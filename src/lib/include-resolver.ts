import path from "node:path";
import type { NamespaceResolution, NamespaceResolver } from "./repos/namespace-resolver.js";

/**
 * @include path resolution: aliases, recipe namespaces, variable substitution,
 * and the ordered candidate search.
 *
 * An include path (the part after `@`) is resolved to an ordered list of
 * candidate absolute paths. The caller tries each in order and uses the first
 * that exists on disk; if none exist, it errors listing every candidate tried.
 *
 * Resolution pipeline for a raw path P (with leading `@` already stripped):
 *   1. Substitute ${vars} in P. If the result is absolute, it is the sole
 *      candidate (feature: `@${sousRootPath}/x.md`).
 *   2. Split the first segment (up to the first `/` or `:`) as the alias key,
 *      the remainder as `rest`. If the key is a registered alias, push
 *      join(base, rest) for EACH base in the alias's ordered array.
 *   3. If the key begins with `~` and a namespace resolver was supplied, ask it
 *      for the recipe namespace named by the key (minus the `~`) and push its
 *      candidates. Aliases are consulted first, so `~sous-shared` keeps meaning
 *      the built-in alias even if a namespace of that name exists.
 *   4. Always push the relative candidate: join(baseDir, P) — the FULL path
 *      including the alias segment. This lets an alias augment a real relative
 *      directory of the same name (e.g. `@stuff/x` tries the alias bases, then
 *      `./stuff/x`).
 *
 * A key WITHOUT the `~` sigil never reaches the namespace resolver: a bare
 * `@path` is always a relative path or a declared alias, so include lines never
 * masquerade as filesystem paths.
 *
 * Aliases whose names begin with `~` are reserved for built-ins; user aliases
 * may not use that prefix. The primary separator is `/` (TS-style,
 * `@alias/path`); `:` is accepted as an equivalent (`@alias:path`).
 */

/** An alias maps a name to an ordered list of absolute base directories. */
export type AliasMap = Record<string, string[]>;

/**
 * Substitute ${varName} references in a string from a scope. Unknown
 * references are left untouched (matches settings.substituteVars behavior).
 *
 * @param str - The string to substitute into.
 * @param scope - Map of variable names to values.
 * @returns The substituted string.
 */
export function substituteVars(str: string, scope: Record<string, string>): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, name: string) => scope[name] ?? match);
}

/**
 * Split an include path into its leading alias key and the remainder. The key
 * is the run of characters up to the first `/` or `:` separator.
 *
 * @param p - The include path (no leading `@`).
 * @returns `{ key, rest }`; `rest` has no leading separator.
 */
export function splitAliasKey(p: string): { key: string; rest: string } {
  const m = p.match(/^([^/:]+)[/:]([\s\S]*)$/);
  if (!m) return { key: p, rest: "" };
  return { key: m[1], rest: m[2] };
}

/** Options shared by {@link resolveInclude} and {@link resolveIncludeCandidates}. */
export type IncludeResolveOptions = {
  /** The resolved alias map (name → ordered base dirs). */
  aliases?: AliasMap;
  /** Variable scope for ${var} substitution. */
  scope?: Record<string, string>;
  /** Directory of the including file (for the relative candidate). */
  baseDir: string;
  /** Resolver consulted for a `~namespace` first segment; omitted means namespaces are unavailable. */
  namespaceResolver?: NamespaceResolver;
  /**
   * Absolute path of the including file, handed to the namespace resolver so it
   * can tell whether the include comes from inside a recipe. Defaults to
   * `baseDir` for callers that only know the directory.
   */
  fromFile?: string;
};

/** A namespace lookup that produced no usable candidates, kept for error reporting. */
export type NamespaceIssue = {
  /** The namespace that was asked for, without its `~` sigil. */
  namespace: string;
  /** The remainder of the reference (recipe name plus the path inside it). */
  rest: string;
  /** The file (or directory) that performed the include. */
  fromFile: string;
  /** What the resolver returned. */
  resolution: NamespaceResolution;
};

/** The full result of resolving one include path. */
export type IncludeResolution = {
  /** Ordered, de-duplicated absolute candidate paths. */
  candidates: string[];
  /**
   * Present when the first segment named a `~namespace` that the resolver could
   * not satisfy. The candidate list is still usable (it holds the alias and
   * relative fallbacks); this only explains what went wrong with the namespace.
   */
  namespaceIssue?: NamespaceIssue;
};

/**
 * Resolve an include path to its ordered candidates plus any namespace
 * diagnostic. Use this when the caller wants to report WHY a `~namespace`
 * reference failed; {@link resolveIncludeCandidates} is the plain-list form.
 *
 * @param rawPath - The include path with the leading `@` already stripped.
 * @param opts - Aliases, variable scope, including directory and optional namespace resolver.
 * @returns The candidate list and, when a namespace lookup failed, the reason.
 */
export function resolveInclude(rawPath: string, opts: IncludeResolveOptions): IncludeResolution {
  const aliases = opts.aliases ?? {};
  const scope = opts.scope ?? {};
  const substituted = substituteVars(rawPath, scope);

  // 1. Substituted to an absolute path → that is the only candidate.
  if (path.isAbsolute(substituted)) {
    return { candidates: [path.normalize(substituted)] };
  }

  const candidates: string[] = [];
  let namespaceIssue: NamespaceIssue | undefined;

  // 2. Alias bases (ordered), if the first segment is a registered alias.
  const { key, rest } = splitAliasKey(substituted);
  if (key && Object.prototype.hasOwnProperty.call(aliases, key)) {
    for (const base of aliases[key]) {
      candidates.push(path.resolve(base, rest));
    }
  }

  // 3. Recipe namespace, only for a `~`-sigil key naming something after it.
  //    Aliases above already had their turn, so a built-in or user alias of the
  //    same name is always preferred.
  if (opts.namespaceResolver && key.startsWith("~") && key.length > 1 && rest.length > 0) {
    const namespace = key.slice(1);
    const fromFile = opts.fromFile ?? opts.baseDir;
    const resolution = opts.namespaceResolver.resolve({ namespace, rest, fromFile });

    if (resolution.kind === "candidates" && resolution.candidates.length > 0) {
      candidates.push(...resolution.candidates.map((c) => path.normalize(c)));
    } else {
      namespaceIssue = { namespace, rest, fromFile, resolution };
    }
  }

  // 4. Relative fallback: the FULL substituted path under the including dir.
  candidates.push(path.resolve(opts.baseDir, substituted));

  // De-dupe, preserving order.
  return { candidates: [...new Set(candidates)], namespaceIssue };
}

/**
 * Compute the ordered list of candidate absolute paths for an include.
 *
 * @param rawPath - The include path with the leading `@` already stripped.
 * @param opts - Aliases, variable scope, including directory and optional namespace resolver.
 * @returns Ordered, de-duplicated absolute candidate paths.
 */
export function resolveIncludeCandidates(rawPath: string, opts: IncludeResolveOptions): string[] {
  return resolveInclude(rawPath, opts).candidates;
}

/**
 * Expand a leading alias segment in a path or glob pattern to one candidate
 * per alias base, in the alias's base order. Used for config entry paths
 * (`entryGlob`/watch patterns), where — unlike @include resolution — there is
 * no including file to supply a relative fallback, so a non-alias path is
 * returned unchanged as the sole candidate.
 *
 * @param p - The path or glob pattern (already ${var}-substituted).
 * @param aliases - The resolved alias map (name → ordered base dirs).
 * @returns Ordered candidate paths/patterns; `[p]` when no alias applies.
 */
export function resolveAliasPrefix(p: string, aliases: AliasMap): string[] {
  if (path.isAbsolute(p)) return [p];
  const { key, rest } = splitAliasKey(p);
  if (!key || !Object.prototype.hasOwnProperty.call(aliases, key)) return [p];
  return aliases[key].map((base) => path.resolve(base, rest));
}

/**
 * Build the resolved alias map from built-in aliases and user-defined
 * `_aliases` entries.
 *
 * Precedence (later prepends to earlier so user/project entries are tried
 * FIRST, then fall through to built-in bases):
 *   built-ins  →  root _aliases  →  project _aliases
 *
 * Each user alias value may be a single string or an array of strings, and
 * each is run through ${var} substitution against `scope`.
 *
 * User aliases may NOT use names beginning with `~` (reserved for built-ins);
 * such entries are rejected via `onError` and ignored.
 *
 * @param opts.builtIns - Built-in alias map (already absolute; `~`-prefixed names).
 * @param opts.userAliases - Ordered list of user `_aliases` blocks (root, then project).
 * @param opts.scope - Variable scope for substituting alias values.
 * @param opts.onError - Called with a message for each rejected/invalid entry.
 * @returns The merged alias map.
 */
export function buildAliasMap(opts: {
  builtIns?: AliasMap;
  userAliases?: Array<Record<string, string | string[]> | undefined>;
  scope?: Record<string, string>;
  onError?: (message: string) => void;
}): AliasMap {
  const scope = opts.scope ?? {};
  const out: AliasMap = {};

  // Start with built-ins.
  for (const [name, bases] of Object.entries(opts.builtIns ?? {})) {
    out[name] = [...bases];
  }

  // Apply user blocks in order; each PREPENDS its bases so user entries win
  // but still fall through to any built-in bases of the same name.
  for (const block of opts.userAliases ?? []) {
    if (!block) continue;
    for (const [name, value] of Object.entries(block)) {
      if (name.startsWith("~")) {
        opts.onError?.(
          `Alias "${name}" is invalid: names beginning with "~" are reserved for built-in aliases.`
        );
        continue;
      }
      const values = Array.isArray(value) ? value : [value];
      const bases = values.map((v) => substituteVars(v, scope));
      out[name] = [...bases, ...(out[name] ?? [])];
    }
  }

  return out;
}
