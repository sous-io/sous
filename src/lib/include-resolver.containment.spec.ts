import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";
import { resolveIncludeFiles } from "./include-resolver.js";
import { StaticNamespaceResolver } from "./repos/namespace-resolver.js";

let tmp: TmpDir;

/** Writes a file under the temp directory and returns its absolute path. */
function write(rel: string, content = "x"): string {
  const abs = path.join(tmp.path, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** A resolver over recipes a/b (which declares nothing else) and a/c. */
function resolver(): StaticNamespaceResolver {
  return new StaticNamespaceResolver({
    recipes: { "a/b": path.join(tmp.path, "r/a/b"), "a/c": path.join(tmp.path, "r/a/c") },
  });
}

beforeEach(() => {
  tmp = makeTmpDir("sous-contain-");
});
afterEach(() => tmp.cleanup());

describe("a recipe reference that tries to leave its recipe", () => {
  /**
   * A brace alternative holding `..` is refused like a plain `..` segment.
   *
   * @~a/b/{..,x}/{..,x}/c/*.md from inside a/b -> escapes-recipe, no files
   */
  it("should refuse a { } alternative holding a .. segment", () => {
    write("r/a/b/one.md");
    const target = write("r/a/c/secret.md");
    const from = path.join(tmp.path, "r/a/b/start.md");
    for (const ref of ["~a/b/{..,x}/{..,x}/c/*.md", "~a/b/{..,x}/*.md", "~a/b/{.,x}/*.md"]) {
      const out = resolveIncludeFiles(ref, {
        baseDir: path.dirname(from),
        fromFile: from,
        namespaceResolver: resolver(),
      });
      expect(out.files).not.toContain(target);
      expect(out.files).toEqual([]);
      expect(out.namespaceIssue?.resolution.kind).toBe("escapes-recipe");
    }
  });

  /**
   * A link inside a recipe that points outside it is refused, for a glob and for
   * an exact path.
   *
   * a/b/link.md -> ../../outside.md; @~a/b/*.md -> escapes-recipe
   */
  it("should refuse a file reached through a link that leaves the recipe", () => {
    write("r/a/b/one.md");
    const outside = write("outside.md");
    fs.symlinkSync(outside, path.join(tmp.path, "r/a/b/link.md"));
    for (const ref of ["~a/b/*.md", "~a/b/link.md"]) {
      const out = resolveIncludeFiles(ref, {
        baseDir: tmp.path,
        namespaceResolver: resolver(),
      });
      expect(out.files).toEqual([]);
      expect(out.namespaceIssue?.resolution.kind).toBe("escapes-recipe");
    }
  });

  /**
   * Ordinary globs, braces without dots, and exact paths keep working.
   *
   * @~a/b/{one,two}.md -> both files
   */
  it("should leave ordinary globs unaffected", () => {
    const one = write("r/a/b/one.md");
    const two = write("r/a/b/two.md");
    const out = resolveIncludeFiles("~a/b/{one,two}.md", {
      baseDir: tmp.path,
      namespaceResolver: resolver(),
    });
    expect(out.files).toEqual([one, two]);
    expect(out.namespaceIssue).toBeUndefined();
    expect(
      resolveIncludeFiles("~a/b/one.md", { baseDir: tmp.path, namespaceResolver: resolver() }).files
    ).toEqual([one]);
  });
});

describe("a view include from a recipe's own file", () => {
  /**
   * A file inside a recipe may not include a view; the error says how to reach
   * another recipe instead.
   *
   * from a/b/start.md: @#memories/a/c/m.md -> refused, hashIssue names "@~namespace/recipe/..."
   */
  it("should be refused with a message naming the declared-dependency route", () => {
    const file = write("r/a/c/m.md");
    const from = path.join(tmp.path, "r/a/b/start.md");
    const out = resolveIncludeFiles("#memories/a/c/m.md", {
      baseDir: path.dirname(from),
      fromFile: from,
      namespaceResolver: resolver(),
      views: { "#memories": [{ path: "a/c/m.md", file }] },
    });
    expect(out.files).toEqual([]);
    expect(out.hashIssue).toContain("@~namespace/recipe/...");
  });

  /**
   * A project template still includes a view.
   *
   * from the project: @#memories/a/c/m.md -> the file
   */
  it("should still work from a project template", () => {
    const file = write("r/a/c/m.md");
    const out = resolveIncludeFiles("#memories/a/c/m.md", {
      baseDir: tmp.path,
      fromFile: path.join(tmp.path, "project/x.md"),
      namespaceResolver: resolver(),
      views: { "#memories": [{ path: "a/c/m.md", file }] },
    });
    expect(out.files).toEqual([file]);
  });
});
