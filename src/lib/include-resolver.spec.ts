import { describe, it, expect } from "vitest";
import {
  substituteVars,
  splitAliasKey,
  resolveInclude,
  resolveIncludeCandidates,
  resolveAliasPrefix,
  buildAliasMap,
  templateTwin,
} from "./include-resolver.js";
import type {
  NamespaceRequest,
  NamespaceResolution,
  NamespaceResolver,
} from "./repos/namespace-resolver.js";

describe("resolveAliasPrefix()", () => {
  const aliases = {
    "~project": ["/proj-root"],
    team: ["/team/prompts", "/proj-root"],
  };

  it("returns an absolute path unchanged as the sole candidate", () => {
    expect(resolveAliasPrefix("/abs/skills/**/*", aliases)).toEqual(["/abs/skills/**/*"]);
  });

  it("returns a non-alias relative pattern unchanged", () => {
    expect(resolveAliasPrefix("skills/**/*", aliases)).toEqual(["skills/**/*"]);
  });

  it("expands an alias to one candidate per base, in base order", () => {
    expect(resolveAliasPrefix("team/skills/**/*", aliases)).toEqual([
      "/team/prompts/skills/**/*",
      "/proj-root/skills/**/*",
    ]);
  });

  it("expands a built-in ~ alias", () => {
    expect(resolveAliasPrefix("~project/skills/**/*", aliases)).toEqual([
      "/proj-root/skills/**/*",
    ]);
  });

  it("accepts the colon separator", () => {
    expect(resolveAliasPrefix("team:skills/**/*", aliases)).toEqual([
      "/team/prompts/skills/**/*",
      "/proj-root/skills/**/*",
    ]);
  });
});

describe("substituteVars()", () => {
  it("substitutes known vars and leaves unknown ones", () => {
    expect(substituteVars("${a}/x/${b}", { a: "/root", b: "y" })).toBe("/root/x/y");
    expect(substituteVars("${missing}/x", {})).toBe("${missing}/x");
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
    expect(templateTwin("/a/x.md")).toBe("/a/x.tpl.md");
    expect(templateTwin("/a/x.tpl.md")).toBe("/a/x.md");
    expect(templateTwin("/a/settings.tpl.mjs")).toBe("/a/settings.mjs");
    expect(templateTwin("/a/README")).toBeUndefined();
    expect(templateTwin("/a/.env")).toBeUndefined();
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
  it("keeps ~ as part of the key", () => {
    expect(splitAliasKey("~project/a/b.md")).toEqual({ key: "~project", rest: "a/b.md" });
  });
});

describe("resolveIncludeCandidates()", () => {
  const baseDir = "/proj/memories/tools";

  it("returns a substituted absolute path as the sole candidate", () => {
    const out = resolveIncludeCandidates("${sousRootPath}/shared/x.md", {
      scope: { sousRootPath: "/opt/sous" },
      baseDir,
    });
    expect(out).toEqual(withTwins(["/opt/sous/shared/x.md"]));
  });

  it("resolves an alias to its base, then the relative fallback", () => {
    const out = resolveIncludeCandidates("~project/memories/x.md", {
      aliases: { "~project": ["/proj-root"] },
      baseDir,
    });
    expect(out).toEqual(withTwins([
      "/proj-root/memories/x.md",
      "/proj/memories/tools/~project/memories/x.md",
    ]));
  });

  it("tries multiple alias bases in order, then relative", () => {
    const out = resolveIncludeCandidates("stuff/one.md", {
      aliases: { stuff: ["/etc/stuff", "/var/stuff"] },
      baseDir,
    });
    expect(out).toEqual(withTwins([
      "/etc/stuff/one.md",
      "/var/stuff/one.md",
      "/proj/memories/tools/stuff/one.md",
    ]));
  });

  it("augment case: alias miss falls through to a real relative dir of the same name", () => {
    // @stuff/one.md with alias stuff→/etc/stuff: check /etc/stuff/one.md, then ./stuff/one.md
    const out = resolveIncludeCandidates("stuff/one.md", {
      aliases: { stuff: ["/etc/stuff"] },
      baseDir: "/proj",
    });
    expect(out).toEqual(withTwins(["/etc/stuff/one.md", "/proj/stuff/one.md"]));
  });

  it("accepts the colon separator for aliases", () => {
    const out = resolveIncludeCandidates("~project:memories/x.md", {
      aliases: { "~project": ["/proj-root"] },
      baseDir,
    });
    expect(out[0]).toBe("/proj-root/memories/x.md");
  });

  /**
   * A leading `~/` is the home directory, not an alias: `@~/notes/x.md` resolves
   * to the one absolute path under $HOME and nothing else is tried.
   */
  it("should expand a leading ~/ to the home directory as the sole candidate", () => {
    const home = process.env.HOME;
    process.env.HOME = "/home/someone";
    try {
      const out = resolveIncludeCandidates("~/notes/x.md", { aliases: {}, baseDir });
      expect(out).toEqual(withTwins(["/home/someone/notes/x.md"]));
    } finally {
      process.env.HOME = home;
    }
  });

  /** The sigil followed by a name is still an alias or a namespace, never the home directory. */
  it("should leave a ~name first segment to the alias and namespace rules", () => {
    const out = resolveIncludeCandidates("~project/x.md", {
      aliases: { "~project": ["/proj"] },
      baseDir,
    });
    expect(out).toEqual(withTwins(["/proj/x.md", "/proj/memories/tools/~project/x.md"]));
  });

  it("treats an unregistered first segment as purely relative", () => {
    const out = resolveIncludeCandidates("nope/x.md", { aliases: {}, baseDir });
    expect(out).toEqual(withTwins(["/proj/memories/tools/nope/x.md"]));
  });

  it("substitutes vars before alias splitting", () => {
    const out = resolveIncludeCandidates("${aliasName}/x.md", {
      scope: { aliasName: "docs" },
      aliases: { docs: ["/d"] },
      baseDir,
    });
    expect(out).toEqual(withTwins(["/d/x.md", "/proj/memories/tools/docs/x.md"]));
  });

  it("de-duplicates identical candidates", () => {
    // alias base resolves to the same place as the relative fallback
    const out = resolveIncludeCandidates("x/one.md", {
      aliases: { x: ["/proj/memories/tools/x"] },
      baseDir,
    });
    expect(out).toEqual(withTwins(["/proj/memories/tools/x/one.md"]));
  });
});

describe("buildAliasMap()", () => {
  it("includes built-ins as-is", () => {
    const map = buildAliasMap({ builtIns: { "~project": ["/proj-root"] } });
    expect(map["~project"]).toEqual(["/proj-root"]);
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
      builtIns: { "~project": ["/builtin"] },
      // a user can't reuse ~ names, but demonstrate prepend with a normal name
      userAliases: [{ shared: ["/root-level"] }, { shared: ["/project-level"] }],
    });
    expect(map.shared).toEqual(["/project-level", "/root-level"]);
  });

  it("rejects user aliases that use the reserved ~ prefix", () => {
    const errors: string[] = [];
    const map = buildAliasMap({
      builtIns: { "~project": ["/builtin"] },
      userAliases: [{ "~project": ["/hijack"], ok: ["/fine"] }],
      onError: (m) => errors.push(m),
    });
    expect(map["~project"]).toEqual(["/builtin"]); // unchanged
    expect(map.ok).toEqual(["/fine"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/reserved/);
  });
});

describe("resolveInclude() with a namespace resolver", () => {
  const baseDir = "/proj/prompts";

  /** Builds a resolver that records every request and answers from a fixed table. */
  function makeSpyResolver(
    answer: NamespaceResolution = { kind: "candidates", candidates: ["/store/ns/recipe/x.md"] }
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

    expect(out.candidates).toEqual(withTwins(["/store/ns/recipe/x.md", "/proj/prompts/~ns/recipe/x.md"]));
    expect(out.namespaceIssue).toBeUndefined();
    expect(calls).toEqual([
      { namespace: "ns", rest: "recipe/x.md", fromFile: "/proj/prompts/AGENTS.md" },
    ]);
  });

  /**
   * Alias bases are tried before the namespace resolver, so a built-in alias
   * keeps its meaning even when a namespace shares its name.
   */
  it("should put alias bases ahead of namespace candidates", () => {
    const { resolver } = makeSpyResolver({
      kind: "candidates",
      candidates: ["/store/project/recipe/x.md"],
    });
    const out = resolveInclude("~project/recipe/x.md", {
      aliases: { "~project": ["/proj-root"] },
      namespaceResolver: resolver,
      baseDir,
    });

    expect(out.candidates[0]).toBe("/proj-root/recipe/x.md");
    expect(out.candidates).toContain("/store/project/recipe/x.md");
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
    expect(out.candidates).toEqual(withTwins(["/proj/prompts/shared/x.md"]));
  });

  /**
   * When the resolver cannot satisfy the reference, the reason comes back
   * alongside the remaining candidates so the caller can explain the failure.
   */
  it("should return the resolver's reason as a namespace issue", () => {
    const { resolver } = makeSpyResolver({ kind: "unknown-namespace", known: ["core"] });
    const out = resolveInclude("~ns/recipe/x.md", {
      namespaceResolver: resolver,
      baseDir,
      fromFile: "/proj/prompts/AGENTS.md",
    });

    expect(out.namespaceIssue).toEqual({
      namespace: "ns",
      rest: "recipe/x.md",
      fromFile: "/proj/prompts/AGENTS.md",
      resolution: { kind: "unknown-namespace", known: ["core"] },
    });
    expect(out.candidates).toEqual(withTwins(["/proj/prompts/~ns/recipe/x.md"]));
  });

  /**
   * With no resolver supplied, a `~` path behaves exactly as it did before
   * namespaces existed: alias bases, then the relative fallback.
   */
  it("should behave like a plain alias path when no resolver is supplied", () => {
    const out = resolveInclude("~ns/recipe/x.md", { baseDir });
    expect(out.candidates).toEqual(withTwins(["/proj/prompts/~ns/recipe/x.md"]));
    expect(out.namespaceIssue).toBeUndefined();
  });

  /**
   * The including file defaults to the including directory, which is all the
   * resolver needs to locate the owning recipe.
   */
  it("should default fromFile to the including directory", () => {
    const { resolver, calls } = makeSpyResolver();
    resolveInclude("~ns/recipe/x.md", { namespaceResolver: resolver, baseDir });
    expect(calls[0].fromFile).toBe(baseDir);
  });
});
