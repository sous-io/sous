import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { compareBytewise, hasGlob } from "../services/ref-resolver/index.js";
import { expandHome } from "./config-discovery.js";
import type { NamespaceResolution, NamespaceResolver } from "./repos/namespace-resolver.js";

/**
 * @include path resolution: aliases, `#` names, recipe references, globs,
 * variable substitution and the ordered candidate search.
 *
 * An include path (the part after `@`) resolves to an ordered list of groups.
 * The caller uses the first group that names at least one file, and gets every
 * file in it; if none does, it errors listing every path tried.
 *
 * Resolution pipeline for a raw path P (with leading `@` already stripped):
 *   1. Substitute ${vars} in P, then expand a leading `~/` to the home
 *      directory (the `~` sigil with nothing but a separator after it names no
 *      namespace, so `@~/notes/x.md` is unambiguous). If the result is
 *      absolute, it is the sole candidate (`@${sousRootPath}/x.md`).
 *   2. Split the first segment (up to the first `/` or `:`) as the alias key,
 *      the remainder as `rest`. If the key is a registered alias, push
 *      join(base, rest) for EACH base in the alias's ordered array. A `#name`
 *      (`#project`) is registered in the alias map by the `#` name registry.
 *   3. If P begins with `~` and holds a `/`, and a namespace resolver was
 *      supplied, hand the reference (P without the `~`) to it. The resolver
 *      reads it with the ref resolver service: `namespace/recipe/path`, any of
 *      the three possibly a glob, optionally with a `repo:` qualifier.
 *   4. Always push the relative candidate: join(baseDir, P), the FULL path
 *      including the first segment. This lets an alias augment a real relative
 *      directory of the same name (e.g. `@stuff/x` tries the alias bases, then
 *      `./stuff/x`).
 *   5. Follow every NON-glob candidate with its `.tpl.` twin: `x.md` is
 *      followed by `x.tpl.md`, and `x.tpl.md` by `x.md`. The literal spelling
 *      is always tried first, and the twin comes right after it, so an alias
 *      base still beats the relative fallback.
 *
 * Any path may use glob syntax (`*`, `**`, `?`, `[..]`, `{a,b}`) after
 * substitution. A glob names every file it matches, in bytewise path order, and
 * a `~` glob also matches recipes (`@~*` + `/*` + `/memories/*.md`).
 *
 * A key WITHOUT a sigil never reaches the namespace resolver: a bare `@path` is
 * always a relative path or a declared alias, so include lines never masquerade
 * as filesystem paths.
 *
 * Aliases whose names begin with `~` or `#` are reserved: `~` for the home
 * directory and recipe namespaces, `#` for names sous or a plugin registers.
 * The primary separator is `/` (`@alias/path`); `:` is accepted as an
 * equivalent for an alias (`@alias:path`).
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

/** The marker that makes a file a template, always right before the final extension. */
const TEMPLATE_MARKER = ".tpl";

/**
 * The `.tpl.` twin of a path: `x.md` gives `x.tpl.md`, `x.tpl.md` gives `x.md`,
 * and a path with no extension has no twin.
 *
 * @param filePath - Any path, absolute or not.
 * @returns The twin, or undefined when there is none.
 */
export function templateTwin(filePath: string): string | undefined {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(base);
  if (ext === "" || ext === base) return undefined;
  const stem = base.slice(0, -ext.length);
  const twin = stem.endsWith(TEMPLATE_MARKER)
    ? `${stem.slice(0, -TEMPLATE_MARKER.length)}${ext}`
    : `${stem}${TEMPLATE_MARKER}${ext}`;
  return path.join(dir, twin);
}

/** Every candidate followed by its `.tpl.` twin, de-duplicated, order kept. */
function withTemplateTwins(candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    out.push(candidate);
    const twin = templateTwin(candidate);
    if (twin !== undefined) out.push(twin);
  }
  return [...new Set(out)];
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

/** Options shared by {@link resolveInclude} and {@link resolveIncludeFiles}. */
export type IncludeResolveOptions = {
  /** The resolved alias map (name → ordered base dirs); `#` names are in it too. */
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

/** A `~` reference that produced no usable candidates, kept for error reporting. */
export type NamespaceIssue = {
  /** The reference with its `~` sigil taken off. */
  reference: string;
  /** The file (or directory) that performed the include. */
  fromFile: string;
  /** What the resolver returned. */
  resolution: NamespaceResolution;
};

/**
 * One place an include may be found. A group is found when any of its paths
 * names at least one file, and then it supplies ALL of them: a plain include
 * has one path per group, a glob over recipes has one per recipe.
 */
export type IncludeGroup = {
  /** Absolute paths, or glob patterns when `glob` is true. */
  paths: string[];
  /** True when the paths are patterns to expand. */
  glob: boolean;
};

/** The full result of resolving one include path. */
export type IncludeResolution = {
  /** Every group, in the order they are tried; the first that names a file wins. */
  groups: IncludeGroup[];
  /** Every path or pattern, flattened, in order and de-duplicated: what an error lists as tried. */
  candidates: string[];
  /** True when the include path holds glob syntax. */
  glob: boolean;
  /**
   * Present when a `~` reference could not be satisfied. The groups are still
   * usable (they hold the alias and relative fallbacks); this only explains
   * what went wrong with the reference.
   */
  namespaceIssue?: NamespaceIssue;
  /** Present when the path starts with a `#` name nothing registered. */
  hashIssue?: string;
};

/** The files an include names, and how the search went. */
export type IncludeFiles = {
  /** Every file the include names, each once, in the order they are included. */
  files: string[];
  /** Everything that was tried. */
  candidates: string[];
  /** True when the include path holds glob syntax. */
  glob: boolean;
  /** Why a `~` reference failed, when it did. */
  namespaceIssue?: NamespaceIssue;
  /** Why a `#` name failed, when it did. */
  hashIssue?: string;
};

/** The `?name=value&...` query an include line may end with, after its `.md`. */
const QUERY_SUFFIX = /^(.*\.md)(\?[^?\s]*=\S*)$/;

/**
 * Splits the query off an include path: `a/b.md?name=value` gives the path
 * `a/b.md` and the query `?name=value`.
 *
 * @param raw - The include path, without its `@`.
 */
export function splitIncludeQuery(raw: string): { path: string; query: string } {
  const match = QUERY_SUFFIX.exec(raw);
  return match === null ? { path: raw, query: "" } : { path: match[1]!, query: match[2]! };
}

/** The group of one literal path followed by its `.tpl.` twin. */
function literalGroups(candidate: string): IncludeGroup[] {
  return withTemplateTwins([candidate]).map((entry) => ({ paths: [entry], glob: false }));
}

/**
 * Resolve an include path to its ordered groups plus any diagnostic. Nothing is
 * read from disk. Use this when the caller wants to report WHY a `~` or `#`
 * reference failed; {@link resolveIncludeFiles} reads the disk and returns the
 * files.
 *
 * @param rawPath - The include path with the leading `@` already stripped.
 * @param opts - Aliases, variable scope, including directory and optional namespace resolver.
 * @returns The groups, the flat candidate list and, when a reference failed, the reason.
 */
export function resolveInclude(rawPath: string, opts: IncludeResolveOptions): IncludeResolution {
  const aliases = opts.aliases ?? {};
  const scope = opts.scope ?? {};
  const withQuery = expandHome(substituteVars(rawPath, scope));
  const substituted = splitIncludeQuery(withQuery).path;
  const glob = hasGlob(substituted);

  const finish = (
    groups: IncludeGroup[],
    extra: Pick<IncludeResolution, "namespaceIssue" | "hashIssue"> = {}
  ): IncludeResolution => ({
    groups,
    candidates: [...new Set(groups.flatMap((group) => group.paths))],
    glob,
    ...extra,
  });
  const single = (candidate: string): IncludeGroup[] =>
    glob ? [{ paths: [candidate], glob: true }] : literalGroups(candidate);

  // 1. Substituted (or home-expanded) to an absolute path: that, and its twin.
  if (path.isAbsolute(substituted)) {
    return finish(single(path.normalize(substituted)));
  }

  const groups: IncludeGroup[] = [];
  let namespaceIssue: NamespaceIssue | undefined;
  let hashIssue: string | undefined;

  // 2. Alias bases (ordered), if the first segment is a registered alias. A
  //    `#` name is an alias too: the registry puts every `#name` in the map.
  const { key, rest } = splitAliasKey(substituted);
  if (key && Object.prototype.hasOwnProperty.call(aliases, key)) {
    for (const base of aliases[key]!) groups.push(...single(path.resolve(base, rest)));
  } else if (key.startsWith("#") && rest.length > 0) {
    const known = Object.keys(aliases).filter((name) => name.startsWith("#"));
    hashIssue =
      `There is no built-in name "${key}" available here.\n` +
      (known.length > 0
        ? `Available names: ${known.sort().join(", ")}.`
        : "No '#' names are available in this project.");
  }

  // 3. A recipe reference: a `~` sigil, then namespace, recipe and path. Only
  //    when a resolver was supplied and a `/` follows, so a file that is
  //    simply named `~notes.md` is still a relative path.
  if (
    opts.namespaceResolver &&
    substituted.startsWith("~") &&
    substituted.length > 1 &&
    substituted.includes("/")
  ) {
    const reference = withQuery.slice(1);
    const fromFile = opts.fromFile ?? opts.baseDir;
    const resolution = opts.namespaceResolver.resolve({ reference, fromFile });

    if (resolution.kind === "candidates" && resolution.glob === true) {
      groups.push({ paths: resolution.candidates.map((c) => c), glob: true });
    } else if (resolution.kind === "candidates" && resolution.candidates.length > 0) {
      for (const candidate of resolution.candidates) {
        groups.push(...literalGroups(path.normalize(candidate)));
      }
    } else if (resolution.kind !== "candidates") {
      namespaceIssue = { reference, fromFile, resolution };
    }
  }

  // 4. Relative fallback: the FULL substituted path under the including dir.
  groups.push(...single(path.resolve(opts.baseDir, substituted)));

  return finish(groups, {
    ...(namespaceIssue === undefined ? {} : { namespaceIssue }),
    ...(hashIssue === undefined ? {} : { hashIssue }),
  });
}

/**
 * Expands a glob pattern to the files it matches, sorted by path bytewise so
 * the order is the same on every machine.
 *
 * @param pattern - An absolute glob pattern.
 */
function expandPattern(pattern: string): string[] {
  return globSync(pattern, { absolute: true, nodir: true, dot: true }).sort(compareBytewise);
}

/**
 * Resolve an include path to the files it names. The groups are tried in
 * order and the first that names any file supplies all of them: a plain path
 * is one file, a glob is every file it matches in sorted path order.
 *
 * @param rawPath - The include path with the leading `@` already stripped.
 * @param opts - Aliases, variable scope, including directory and optional namespace resolver.
 * @returns The files (empty when nothing was found) and what was tried.
 */
export function resolveIncludeFiles(rawPath: string, opts: IncludeResolveOptions): IncludeFiles {
  const resolution = resolveInclude(rawPath, opts);
  const out: IncludeFiles = {
    files: [],
    candidates: resolution.candidates,
    glob: resolution.glob,
    ...(resolution.namespaceIssue === undefined ? {} : { namespaceIssue: resolution.namespaceIssue }),
    ...(resolution.hashIssue === undefined ? {} : { hashIssue: resolution.hashIssue }),
  };
  for (const group of resolution.groups) {
    const found = group.glob
      ? group.paths.flatMap(expandPattern)
      : group.paths.filter((candidate) => fs.existsSync(candidate));
    if (found.length > 0) {
      out.files = [...new Set(found)];
      return out;
    }
  }
  return out;
}

/**
 * Compute the ordered list of candidate absolute paths for an include.
 *
 * @param rawPath - The include path with the leading `@` already stripped.
 * @param opts - Aliases, variable scope, including directory and optional namespace resolver.
 * @returns Ordered, de-duplicated absolute candidate paths (patterns, for a glob).
 */
export function resolveIncludeCandidates(rawPath: string, opts: IncludeResolveOptions): string[] {
  return resolveInclude(rawPath, opts).candidates;
}

/**
 * Expand a leading alias segment in a path or glob pattern to one candidate
 * per alias base, in the alias's base order. Used for config entry paths
 * (`entryGlob`/watch patterns), where, unlike @include resolution, there is
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
 * User aliases may NOT use names beginning with `~` or `#` (reserved);
 * such entries are rejected via `onError` and ignored.
 *
 * @param opts.builtIns - Built-in alias map (already absolute; `#`-prefixed names).
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
      if (name.startsWith("~") || name.startsWith("#")) {
        opts.onError?.(
          `Alias "${name}" is invalid: names beginning with "~" or "#" are reserved ` +
            `("~" for the home directory and recipe namespaces, "#" for built-in names).`
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
