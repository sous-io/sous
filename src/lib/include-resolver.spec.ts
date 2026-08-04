import { describe, it, expect } from "vitest";
import {
  substituteVars,
  splitAliasKey,
  resolveIncludeCandidates,
  buildAliasMap,
} from "./include-resolver.js";

describe("substituteVars()", () => {
  it("substitutes known vars and leaves unknown ones", () => {
    expect(substituteVars("${a}/x/${b}", { a: "/root", b: "y" })).toBe("/root/x/y");
    expect(substituteVars("${missing}/x", {})).toBe("${missing}/x");
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
    expect(splitAliasKey("~sous-shared/a/b.md")).toEqual({ key: "~sous-shared", rest: "a/b.md" });
  });
});

describe("resolveIncludeCandidates()", () => {
  const baseDir = "/proj/memories/tools";

  it("returns a substituted absolute path as the sole candidate", () => {
    const out = resolveIncludeCandidates("${sousRootPath}/shared/x.md", {
      scope: { sousRootPath: "/opt/sous" },
      baseDir,
    });
    expect(out).toEqual(["/opt/sous/shared/x.md"]);
  });

  it("resolves an alias to its base, then the relative fallback", () => {
    const out = resolveIncludeCandidates("~sous-shared/memories/x.md", {
      aliases: { "~sous-shared": ["/opt/sous/shared-prompts"] },
      baseDir,
    });
    expect(out).toEqual([
      "/opt/sous/shared-prompts/memories/x.md",
      "/proj/memories/tools/~sous-shared/memories/x.md",
    ]);
  });

  it("tries multiple alias bases in order, then relative", () => {
    const out = resolveIncludeCandidates("stuff/one.md", {
      aliases: { stuff: ["/etc/stuff", "/var/stuff"] },
      baseDir,
    });
    expect(out).toEqual([
      "/etc/stuff/one.md",
      "/var/stuff/one.md",
      "/proj/memories/tools/stuff/one.md",
    ]);
  });

  it("augment case: alias miss falls through to a real relative dir of the same name", () => {
    // @stuff/one.md with alias stuff→/etc/stuff: check /etc/stuff/one.md, then ./stuff/one.md
    const out = resolveIncludeCandidates("stuff/one.md", {
      aliases: { stuff: ["/etc/stuff"] },
      baseDir: "/proj",
    });
    expect(out).toEqual(["/etc/stuff/one.md", "/proj/stuff/one.md"]);
  });

  it("accepts the colon separator for aliases", () => {
    const out = resolveIncludeCandidates("~sous-shared:memories/x.md", {
      aliases: { "~sous-shared": ["/opt/sous/shared-prompts"] },
      baseDir,
    });
    expect(out[0]).toBe("/opt/sous/shared-prompts/memories/x.md");
  });

  it("treats an unregistered first segment as purely relative", () => {
    const out = resolveIncludeCandidates("nope/x.md", { aliases: {}, baseDir });
    expect(out).toEqual(["/proj/memories/tools/nope/x.md"]);
  });

  it("substitutes vars before alias splitting", () => {
    const out = resolveIncludeCandidates("${aliasName}/x.md", {
      scope: { aliasName: "docs" },
      aliases: { docs: ["/d"] },
      baseDir,
    });
    expect(out).toEqual(["/d/x.md", "/proj/memories/tools/docs/x.md"]);
  });

  it("de-duplicates identical candidates", () => {
    // alias base resolves to the same place as the relative fallback
    const out = resolveIncludeCandidates("x/one.md", {
      aliases: { x: ["/proj/memories/tools/x"] },
      baseDir,
    });
    expect(out).toEqual(["/proj/memories/tools/x/one.md"]);
  });
});

describe("buildAliasMap()", () => {
  it("includes built-ins as-is", () => {
    const map = buildAliasMap({ builtIns: { "~sous-shared": ["/opt/sous/shared-prompts"] } });
    expect(map["~sous-shared"]).toEqual(["/opt/sous/shared-prompts"]);
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
      builtIns: { "~sous-shared": ["/builtin"] },
      // a user can't reuse ~ names, but demonstrate prepend with a normal name
      userAliases: [{ shared: ["/root-level"] }, { shared: ["/project-level"] }],
    });
    expect(map.shared).toEqual(["/project-level", "/root-level"]);
  });

  it("rejects user aliases that use the reserved ~ prefix", () => {
    const errors: string[] = [];
    const map = buildAliasMap({
      builtIns: { "~sous-shared": ["/builtin"] },
      userAliases: [{ "~sous-shared": ["/hijack"], ok: ["/fine"] }],
      onError: (m) => errors.push(m),
    });
    expect(map["~sous-shared"]).toEqual(["/builtin"]); // unchanged
    expect(map.ok).toEqual(["/fine"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/reserved/);
  });
});
