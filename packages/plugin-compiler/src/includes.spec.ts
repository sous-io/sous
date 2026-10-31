/**
 * Include resolution, ported from today's `src/lib/include-resolver.spec.ts`. The old free
 * functions are thin adapters here over `planInclude` and `resolveIncludeFiles`, which take their
 * aliases, views, globs and namespace resolver as an environment.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { testGlobs } from "../test/stand-ins.js";
import { buildAliasMap as buildMap, resolveAliasPrefix, type AliasMap } from "./aliases.js";
import { planInclude, resolveIncludeFiles as resolveFiles, type IncludeEnvironment, type ViewMap } from "./includes.js";
import { splitAliasKey, splitIncludeQuery, templateTwin } from "./paths.js";
import type { NamespaceRequest, NamespaceResolution, NamespaceResolver } from "./types.js";

/** What the old functions took. */
interface Options {
    aliases?: AliasMap;
    views?: ViewMap;
    scope?: Record<string, string>;
    baseDir: string;
    namespaceResolver?: NamespaceResolver;
    fromFile?: string;
    home?: string;
}

function substituteVars(text: string, scope: Record<string, string>): string {
    return text.replace(/\$\{([^}]+)\}/g, (match, name: string) => scope[name] ?? match);
}

function environment(options: Options): IncludeEnvironment {
    return {
        aliases: options.aliases ?? {},
        views: options.views ?? {},
        globs: testGlobs,
        namespaceResolver: options.namespaceResolver,
        substitute: substituteVars,
        home: options.home ?? os.homedir(),
    };
}

function contextOf(options: Options) {
    return { fromFile: options.fromFile ?? options.baseDir, baseDir: options.baseDir, scope: options.scope ?? {} };
}

function resolveInclude(raw: string, options: Options) {
    const plan = planInclude(raw, contextOf(options), environment(options));

    return { ...plan, namespaceIssue: plan.namespaceProblem, hashIssue: plan.hashProblem };
}

function resolveIncludeCandidates(raw: string, options: Options): string[] {
    return resolveInclude(raw, options).candidates;
}

function resolveIncludeFiles(raw: string, options: Options) {
    return resolveFiles(raw, contextOf(options), environment(options));
}

function buildAliasMap(options: Parameters<typeof buildMap>[0] & { scope?: Record<string, string> }): AliasMap {
    return buildMap({ ...options, substitute: (text) => substituteVars(text, options.scope ?? {}) });
}

interface TmpDir {
    path: string;
    cleanup(): void;
}

function makeTmpDir(): TmpDir {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-includes-")));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An absolute path as this platform spells it, so expected values match what
 * `path.resolve` gives: unchanged on POSIX, on the current drive with `\`
 * separators on Windows ("/proj" -> "D:\proj").
 */
const abs = (p: string): string => path.resolve(p);

describe("resolveAliasPrefix()", () => {
  const aliases = {
    "#project": [abs("/proj-root")],
    team: [abs("/team/prompts"), abs("/proj-root")],
  };

  it("returns an absolute path unchanged as the sole candidate", () => {
    expect(resolveAliasPrefix("/abs/skills/**/*", aliases)).toEqual(["/abs/skills/**/*"]);
  });

  it("returns a non-alias relative pattern unchanged", () => {
    expect(resolveAliasPrefix("skills/**/*", aliases)).toEqual(["skills/**/*"]);
  });

  it("expands an alias to one candidate per base, in base order", () => {
    expect(resolveAliasPrefix("team/skills/**/*", aliases)).toEqual([
      abs("/team/prompts/skills/**/*"),
      abs("/proj-root/skills/**/*"),
    ]);
  });

  it("expands a built-in # alias", () => {
    expect(resolveAliasPrefix("#project/skills/**/*", aliases)).toEqual([
      abs("/proj-root/skills/**/*"),
    ]);
  });

  it("accepts the colon separator", () => {
    expect(resolveAliasPrefix("team:skills/**/*", aliases)).toEqual([
      abs("/team/prompts/skills/**/*"),
      abs("/proj-root/skills/**/*"),
    ]);
  });
});

/**
 * Every expected candidate followed by its `.tpl.` twin, which is the order
 * the resolver promises: the literal spelling, then the twin, per candidate.
 */
function withTwins(paths: string[]): string[] {
  return paths.flatMap((p) => [
    p,
    p.endsWith(".tpl.md") ? p.replace(/\.tpl\.md$/, ".md") : p.replace(/\.md$/, ".tpl.md"),
  ]);
}

describe("templateTwin()", () => {
  /**
   * A plain file's twin carries `.tpl` before its extension, a template's twin
   * drops it, and a file with no extension has none.
   * Example: "/a/x.md" -> "/a/x.tpl.md"; "/a/x.tpl.md" -> "/a/x.md".
   */
  it("should swap a path between its plain and .tpl. spellings", () => {
    expect(templateTwin(abs("/a/x.md"))).toBe(abs("/a/x.tpl.md"));
    expect(templateTwin(abs("/a/x.tpl.md"))).toBe(abs("/a/x.md"));
    expect(templateTwin(abs("/a/settings.tpl.mjs"))).toBe(abs("/a/settings.mjs"));
    expect(templateTwin(abs("/a/README"))).toBeUndefined();
    expect(templateTwin(abs("/a/.env"))).toBeUndefined();
  });
});

describe("splitAliasKey()", () => {
  it("splits on the first slash", () => {
    expect(splitAliasKey("sous/memories/x.md")).toEqual({ key: "sous", rest: "memories/x.md" });
  });
  it("splits on a colon as an equivalent separator", () => {
    expect(splitAliasKey("sous:memories/x.md")).toEqual({ key: "sous", rest: "memories/x.md" });
  });
  it("returns the whole string as key when there is no separator", () => {
    expect(splitAliasKey("file.md")).toEqual({ key: "file.md", rest: "" });
  });
  it("keeps # as part of the key", () => {
    expect(splitAliasKey("#project/a/b.md")).toEqual({ key: "#project", rest: "a/b.md" });
  });
});

describe("resolveIncludeCandidates()", () => {
  const baseDir = abs("/proj/memories/tools");

  it("returns a substituted absolute path as the sole candidate", () => {
    const out = resolveIncludeCandidates("${sousRootPath}/shared/x.md", {
      scope: { sousRootPath: abs("/opt/sous") },
      baseDir,
    });
    expect(out).toEqual(withTwins([abs("/opt/sous/shared/x.md")]));
  });

  it("resolves an alias to its base, then the relative fallback", () => {
    const out = resolveIncludeCandidates("#project/memories/x.md", {
      aliases: { "#project": [abs("/proj-root")] },
      baseDir,
    });
    expect(out).toEqual(withTwins([
      abs("/proj-root/memories/x.md"),
      abs("/proj/memories/tools/#project/memories/x.md"),
    ]));
  });

  it("tries multiple alias bases in order, then relative", () => {
    const out = resolveIncludeCandidates("stuff/one.md", {
      aliases: { stuff: [abs("/etc/stuff"), abs("/var/stuff")] },
      baseDir,
    });
    expect(out).toEqual(withTwins([
      abs("/etc/stuff/one.md"),
      abs("/var/stuff/one.md"),
      abs("/proj/memories/tools/stuff/one.md"),
    ]));
  });

  it("augment case: alias miss falls through to a real relative dir of the same name", () => {
    // @stuff/one.md with alias stuff→/etc/stuff: check /etc/stuff/one.md, then ./stuff/one.md
    const out = resolveIncludeCandidates("stuff/one.md", {
      aliases: { stuff: [abs("/etc/stuff")] },
      baseDir: abs("/proj"),
    });
    expect(out).toEqual(withTwins([abs("/etc/stuff/one.md"), abs("/proj/stuff/one.md")]));
  });

  it("accepts the colon separator for aliases", () => {
    const out = resolveIncludeCandidates("#project:memories/x.md", {
      aliases: { "#project": [abs("/proj-root")] },
      baseDir,
    });
    expect(out[0]).toBe(abs("/proj-root/memories/x.md"));
  });

  /**
   * A leading `~/` is the home directory, not an alias: `@~/notes/x.md` resolves
   * to the one absolute path under $HOME and nothing else is tried.
   */
  it("should expand a leading ~/ to the home directory as the sole candidate", () => {
    const out = resolveIncludeCandidates("~/notes/x.md", { aliases: {}, baseDir, home: abs("/home/someone") });
    expect(out).toEqual(withTwins([abs("/home/someone/notes/x.md")]));
  });

  /** A `#name` first segment is an alias, never the home directory. */
  it("should leave a #name first segment to the alias rules", () => {
    const out = resolveIncludeCandidates("#project/x.md", {
      aliases: { "#project": [abs("/proj")] },
      baseDir,
    });
    expect(out).toEqual(withTwins([abs("/proj/x.md"), abs("/proj/memories/tools/#project/x.md")]));
  });

  it("treats an unregistered first segment as purely relative", () => {
    const out = resolveIncludeCandidates("nope/x.md", { aliases: {}, baseDir });
    expect(out).toEqual(withTwins([abs("/proj/memories/tools/nope/x.md")]));
  });

  it("substitutes vars before alias splitting", () => {
    const out = resolveIncludeCandidates("${aliasName}/x.md", {
      scope: { aliasName: "docs" },
      aliases: { docs: ["/d"] },
      baseDir,
    });
    expect(out).toEqual(withTwins([abs("/d/x.md"), abs("/proj/memories/tools/docs/x.md")]));
  });

  it("de-duplicates identical candidates", () => {
    // alias base resolves to the same place as the relative fallback
    const out = resolveIncludeCandidates("x/one.md", {
      aliases: { x: [abs("/proj/memories/tools/x")] },
      baseDir,
    });
    expect(out).toEqual(withTwins([abs("/proj/memories/tools/x/one.md")]));
  });
});

describe("buildAliasMap()", () => {
  it("includes built-ins as-is", () => {
    const map = buildAliasMap({ builtIns: { "#project": ["/proj-root"] } });
    expect(map["#project"]).toEqual(["/proj-root"]);
  });

  it("adds user aliases with var substitution (string or array)", () => {
    const map = buildAliasMap({
      userAliases: [{ docs: "${root}/docs", many: ["${root}/a", "${root}/b"] }],
      scope: { root: "/r" },
    });
    expect(map.docs).toEqual(["/r/docs"]);
    expect(map.many).toEqual(["/r/a", "/r/b"]);
  });

  it("prepends project bases ahead of built-in bases of the same name", () => {
    const map = buildAliasMap({
      builtIns: { "#project": ["/builtin"] },
      // a user can't reuse ~ names, but demonstrate prepend with a normal name
      userAliases: [{ shared: ["/root-level"] }, { shared: ["/project-level"] }],
    });
    expect(map.shared).toEqual(["/project-level", "/root-level"]);
  });

  it("rejects user aliases that use the reserved ~ or # prefix", () => {
    const errors: string[] = [];
    const map = buildAliasMap({
      builtIns: { "#project": ["/builtin"] },
      userAliases: [{ "#project": ["/hijack"], "~mine": ["/home"], "#x": ["/x"], ok: ["/fine"] }],
      onError: (m) => errors.push(m),
    });
    expect(map["#project"]).toEqual(["/builtin"]); // unchanged
    expect(map.ok).toEqual(["/fine"]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/reserved/);
  });
});

describe("resolveInclude() with a namespace resolver", () => {
  const baseDir = abs("/proj/prompts");

  /** Builds a resolver that records every request and answers from a fixed table. */
  function makeSpyResolver(
    answer: NamespaceResolution = { kind: "candidates", candidates: [abs("/store/ns/recipe/x.md")] }
  ) {
    const calls: NamespaceRequest[] = [];
    const resolver: NamespaceResolver = {
      resolve(request) {
        calls.push(request);
        return answer;
      },
    };
    return { resolver, calls };
  }

  /**
   * A `~namespace` first segment is handed to the resolver, whose candidates
   * land after any alias bases and before the relative fallback.
   *
   * resolveInclude("~ns/recipe/x.md", { namespaceResolver, baseDir: "/proj/prompts" })
   * // -> candidates: ["/store/ns/recipe/x.md", "/proj/prompts/~ns/recipe/x.md"]
   */
  it("should consult the resolver for a ~namespace path and keep the relative fallback last", () => {
    const { resolver, calls } = makeSpyResolver();
    const out = resolveInclude("~ns/recipe/x.md", {
      namespaceResolver: resolver,
      baseDir,
      fromFile: "/proj/prompts/AGENTS.md",
    });

    expect(out.candidates).toEqual(
      withTwins([abs("/store/ns/recipe/x.md"), abs("/proj/prompts/~ns/recipe/x.md")])
    );
    expect(out.namespaceIssue).toBeUndefined();
    expect(calls).toEqual([
      { reference: "ns/recipe/x.md", fromFile: "/proj/prompts/AGENTS.md" },
    ]);
  });

  /**
   * `~project` is no longer an alias: the built-in is `#project`, and a `~`
   * first segment is always a recipe namespace, even when a `#project` alias
   * exists.
   *
   * resolveInclude("~project/recipe/x.md", { aliases: { "#project": [...] } })
   * // -> the resolver is asked; /proj-root is not a candidate
   */
  it("should treat ~project as a namespace and never as the project alias", () => {
    const { resolver, calls } = makeSpyResolver({
      kind: "candidates",
      candidates: [abs("/store/project/recipe/x.md")],
    });
    const out = resolveInclude("~project/recipe/x.md", {
      aliases: { "#project": [abs("/proj-root")] },
      namespaceResolver: resolver,
      baseDir,
    });

    expect(out.candidates[0]).toBe(abs("/store/project/recipe/x.md"));
    expect(out.candidates).not.toContain(abs("/proj-root/recipe/x.md"));
    expect(calls[0]?.reference).toBe("project/recipe/x.md");
  });

  /**
   * A path with no `~` sigil is a relative path or a declared alias and never
   * reaches the resolver, so include lines cannot masquerade as namespace
   * references.
   */
  it("should never consult the resolver for a bare path", () => {
    const { resolver, calls } = makeSpyResolver();
    const out = resolveInclude("shared/x.md", { namespaceResolver: resolver, baseDir });

    expect(calls).toEqual([]);
    expect(out.candidates).toEqual(withTwins([abs("/proj/prompts/shared/x.md")]));
  });

  /**
   * When the resolver cannot satisfy the reference, the reason comes back
   * alongside the remaining candidates so the caller can explain the failure.
   */
  it("should return the resolver's reason as a namespace issue", () => {
    const unknown: NamespaceResolution = {
      kind: "unknown-namespace",
      namespace: "ns",
      recipe: "ns/recipe",
      known: ["core"],
    };
    const { resolver } = makeSpyResolver(unknown);
    const out = resolveInclude("~ns/recipe/x.md", {
      namespaceResolver: resolver,
      baseDir,
      fromFile: "/proj/prompts/AGENTS.md",
    });

    expect(out.namespaceIssue).toEqual({
      reference: "ns/recipe/x.md",
      fromFile: "/proj/prompts/AGENTS.md",
      resolution: unknown,
    });
    expect(out.candidates).toEqual(withTwins([abs("/proj/prompts/~ns/recipe/x.md")]));
  });

  /**
   * With no resolver supplied, a `~` path behaves exactly as it did before
   * namespaces existed: alias bases, then the relative fallback.
   */
  it("should behave like a plain alias path when no resolver is supplied", () => {
    const out = resolveInclude("~ns/recipe/x.md", { baseDir });
    expect(out.candidates).toEqual(withTwins([abs("/proj/prompts/~ns/recipe/x.md")]));
    expect(out.namespaceIssue).toBeUndefined();
  });

  /**
   * The including file defaults to the including directory, which is all the
   * resolver needs to locate the owning recipe.
   */
  it("should default fromFile to the including directory", () => {
    const { resolver, calls } = makeSpyResolver();
    resolveInclude("~ns/recipe/x.md", { namespaceResolver: resolver, baseDir });
    expect(calls[0]!.fromFile).toBe(baseDir);
  });
});

describe("splitIncludeQuery()", () => {
  /**
   * A `?name=value` after the `.md` is the query; everything before it is the path.
   *
   * splitIncludeQuery("a/b.md?x=1&y=2") // -> { path: "a/b.md", query: "?x=1&y=2" }
   */
  it("should split a trailing query off an include path", () => {
    expect(splitIncludeQuery("a/b.md?x=1&y=2")).toEqual({ path: "a/b.md", query: "?x=1&y=2" });
    expect(splitIncludeQuery("a/b.md")).toEqual({ path: "a/b.md", query: "" });
    expect(splitIncludeQuery("a/b?.md")).toEqual({ path: "a/b?.md", query: "" });
  });
});

describe("resolveInclude() with globs and # names", () => {
  const baseDir = abs("/proj/prompts");

  /**
   * A glob path is a glob group with no `.tpl.` twin; the flag says so.
   *
   * resolveInclude("notes/*.md", { baseDir }) // -> glob: true, one pattern
   */
  it("should mark a glob path and skip its template twin", () => {
    const out = resolveInclude("notes/*.md", { baseDir });
    expect(out.glob).toBe(true);
    expect(out.candidates).toEqual([abs("/proj/prompts/notes/*.md")]);
    expect(out.groups).toEqual([{ paths: [abs("/proj/prompts/notes/*.md")], glob: true }]);
  });

  /**
   * A `#name` nothing registered says which names exist.
   *
   * resolveInclude("#nope/x.md", { aliases: { "#project": [...] } }) // -> hashIssue
   */
  it("should explain an unregistered # name", () => {
    const out = resolveInclude("#nope/x.md", { aliases: { "#project": ["/p"] }, baseDir });
    expect(out.hashIssue).toContain('There is no built-in name "#nope"');
    expect(out.hashIssue).toContain("#project");
  });

  /**
   * A glob answer from the namespace resolver becomes ONE group, so every
   * matching recipe is included, not only the first.
   *
   * resolver answers { candidates: [a, b], glob: true } // -> one group of both
   */
  it("should keep every pattern of a recipe glob in one group", () => {
    const resolver: NamespaceResolver = {
      resolve: () => ({ kind: "candidates", candidates: ["/s/a/memories/*.md", "/s/b/memories/*.md"], glob: true }),
    };
    const out = resolveInclude("~*/*/memories/*.md", { namespaceResolver: resolver, baseDir });
    expect(out.groups[0]).toEqual({ paths: ["/s/a/memories/*.md", "/s/b/memories/*.md"], glob: true });
  });
});

describe("resolveIncludeFiles()", () => {
  let tmp: TmpDir;
  afterEach(() => tmp?.cleanup());

  /** Writes a file under the temp directory and returns its absolute path. */
  function write(rel: string, content = "x"): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  /**
   * A glob names every file it matches, in bytewise path order.
   *
   * resolveIncludeFiles("m/*.md") // -> m/B.md, m/a.md, m/c.md (uppercase sorts first)
   *
   * The names differ by more than case, so they are three files on a
   * case-insensitive filesystem (Windows, macOS) too.
   */
  it("should return every glob match in bytewise order", () => {
    tmp = makeTmpDir();
    write("m/c.md");
    write("m/a.md");
    write("m/B.md");
    write("m/skip.txt");
    const out = resolveIncludeFiles("m/*.md", { baseDir: tmp.path });
    expect(out.files.map((f) => path.basename(f))).toEqual(["B.md", "a.md", "c.md"]);
    expect(out.glob).toBe(true);
  });

  /**
   * A glob that matches nothing returns no files but still lists what it tried.
   *
   * resolveIncludeFiles("none/*.md") // -> files: [], candidates: [pattern]
   */
  it("should return no files for a glob that matches nothing", () => {
    tmp = makeTmpDir();
    const out = resolveIncludeFiles("none/*.md", { baseDir: tmp.path });
    expect(out.files).toEqual([]);
    expect(out.candidates).toEqual([path.join(tmp.path, "none/*.md")]);
  });

  /**
   * A glob works under an alias base, `{a,b}` and `**` included.
   *
   * resolveIncludeFiles("#project/**\/*.md", { aliases }) // -> every .md below the base
   */
  it("should expand a glob under an alias base", () => {
    tmp = makeTmpDir();
    write("root/one.md");
    write("root/deep/two.md");
    write("root/deep/three.txt");
    const out = resolveIncludeFiles("#project/**/*.md", {
      aliases: { "#project": [path.join(tmp.path, "root")] },
      baseDir: tmp.path,
    });
    expect(out.files.map((f) => path.relative(tmp.path, f))).toEqual([
      path.join("root", "deep", "two.md"),
      path.join("root", "one.md"),
    ]);
    const braces = resolveIncludeFiles("root/{one,deep/two}.md", { baseDir: tmp.path });
    expect(braces.files).toHaveLength(2);
  });

  /**
   * A plain path still finds its `.tpl.` twin and exactly one file.
   *
   * resolveIncludeFiles("x.md") // -> [x.tpl.md] when only the twin exists
   */
  it("should find a plain path through its template twin", () => {
    tmp = makeTmpDir();
    const twin = write("x.tpl.md");
    const out = resolveIncludeFiles("x.md", { baseDir: tmp.path });
    expect(out.files).toEqual([twin]);
    expect(out.glob).toBe(false);
  });
});
