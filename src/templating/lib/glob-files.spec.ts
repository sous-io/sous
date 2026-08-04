import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { globFiles, parseGlobList } from "./glob-files.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

describe("globFiles()", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-glob-");
    // Layout:
    //   a.mjs
    //   b.mjs
    //   notes.md
    //   sub/c.mjs
    //   sub/deep/d.mjs
    //   deprecated/old.mjs
    writeFile("a.mjs", "");
    writeFile("b.mjs", "");
    writeFile("notes.md", "");
    writeFile("sub/c.mjs", "");
    writeFile("sub/deep/d.mjs", "");
    writeFile("deprecated/old.mjs", "");
  });

  afterEach(() => tmp.cleanup());

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it("should default to matching everything when no include is given", async () => {
    const files = await globFiles({ root: tmp.path });
    expect(files.map((f) => f.relPath)).toEqual([
      "a.mjs",
      "b.mjs",
      "deprecated/old.mjs",
      "notes.md",
      "sub/c.mjs",
      "sub/deep/d.mjs",
    ]);
  });

  it("should match include globs across nested directories", async () => {
    const files = await globFiles({ root: tmp.path, include: ["**/*.mjs"] });
    expect(files.map((f) => f.relPath)).toEqual([
      "a.mjs",
      "b.mjs",
      "deprecated/old.mjs",
      "sub/c.mjs",
      "sub/deep/d.mjs",
    ]);
  });

  it("should match a top-level-only include", async () => {
    const files = await globFiles({ root: tmp.path, include: ["*.mjs"] });
    expect(files.map((f) => f.relPath)).toEqual(["a.mjs", "b.mjs"]);
  });

  it("should apply exclude globs", async () => {
    const files = await globFiles({
      root: tmp.path,
      include: ["**/*.mjs"],
      exclude: ["deprecated/**", "a.mjs"],
    });
    expect(files.map((f) => f.relPath)).toEqual([
      "b.mjs",
      "sub/c.mjs",
      "sub/deep/d.mjs",
    ]);
  });

  it("should return an empty array when nothing matches", async () => {
    const files = await globFiles({ root: tmp.path, include: ["*.txt"] });
    expect(files).toEqual([]);
  });

  it("should populate path, dir, relPath, and name for each match", async () => {
    const files = await globFiles({ root: tmp.path, include: ["sub/c.mjs"] });
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.relPath).toBe("sub/c.mjs");
    expect(f.name).toBe("c.mjs");
    expect(f.path).toBe(path.resolve(tmp.path, "sub/c.mjs"));
    expect(f.dir).toBe(path.resolve(tmp.path, "sub"));
  });

  it("should return results sorted by relative path", async () => {
    const files = await globFiles({ root: tmp.path, include: ["**/*.mjs"] });
    const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
    expect(files).toEqual(sorted);
  });

  it("should not include directories", async () => {
    const files = await globFiles({ root: tmp.path, include: ["**"] });
    expect(files.every((f) => fs.statSync(f.path).isFile())).toBe(true);
  });
});

describe("parseGlobList()", () => {
  it("should return an empty array for undefined or blank input", () => {
    expect(parseGlobList(undefined)).toEqual([]);
    expect(parseGlobList("")).toEqual([]);
    expect(parseGlobList("  ,  ,")).toEqual([]);
  });

  it("should split on commas and trim whitespace", () => {
    expect(parseGlobList("*.mjs, sub/**/*.mjs ,notes.md")).toEqual([
      "*.mjs",
      "sub/**/*.mjs",
      "notes.md",
    ]);
  });
});
