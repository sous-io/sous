import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CompilationService, inferGlobBase } from "./markdown-compiler.js";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";

// ---------------------------------------------------------------------------
// describe("inferGlobBase")
// ---------------------------------------------------------------------------

describe("inferGlobBase", () => {
  it("returns the static prefix before a ** glob", () => {
    expect(inferGlobBase("/foo/bar/**/*")).toBe("/foo/bar");
  });

  it("returns the static prefix before a single * in a path segment", () => {
    expect(inferGlobBase("/foo/bar/*/baz.md")).toBe("/foo/bar");
  });

  it("returns the static prefix before a ? wildcard", () => {
    expect(inferGlobBase("/foo/bar/baz?.md")).toBe("/foo/bar");
  });

  it("returns the static prefix before a {brace} pattern", () => {
    expect(inferGlobBase("/foo/bar/{a,b}/*.md")).toBe("/foo/bar");
  });

  it("returns the static prefix before a [bracket] pattern", () => {
    expect(inferGlobBase("/foo/bar/[abc]/*.md")).toBe("/foo/bar");
  });

  it("returns '/' when the glob character is in the first path segment after root", () => {
    expect(inferGlobBase("/**/*")).toBe("/");
  });

  it("returns '/' when the first segment after root is a glob", () => {
    expect(inferGlobBase("/*/bar.md")).toBe("/");
  });

  it("strips a trailing slash from the inferred base", () => {
    expect(inferGlobBase("/foo/bar/")).toBe("/foo/bar");
  });

  it("returns the full path when there are no glob characters", () => {
    expect(inferGlobBase("/foo/bar/file.md")).toBe("/foo/bar/file.md");
  });
});

// ---------------------------------------------------------------------------
// describe("CompilationService — destinationDir path computation")
// ---------------------------------------------------------------------------

describe("CompilationService — destinationDir with globBase", () => {
  let tmp: TmpDir;

  afterEach(() => {
    tmp?.cleanup();
  });

  /**
   * When globBase is set, the source file's path relative to globBase is
   * mirrored under destinationDir — preserving subdirectory structure.
   *
   * Source:   tmp/src/subdir/skill.md
   * globBase: tmp/src
   * destDir:  tmp/dest
   * Expected: tmp/dest/subdir/skill.md
   */
  it("mirrors source subdirectory structure under destinationDir when globBase is set", async () => {
    tmp = makeTmpDir();
    const srcBase = path.join(tmp.path, "src");
    const subDir = path.join(srcBase, "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    const srcFile = path.join(subDir, "skill.md");
    fs.writeFileSync(srcFile, "# Skill\n", "utf8");

    const destDir = path.join(tmp.path, "dest");

    await new CompilationService().compile({
      targets: [{
        rootInputPath: srcFile,
        globBase: srcBase,
        outputs: [{ destinationDir: destDir }],
      }],
    });

    expect(fs.existsSync(path.join(destDir, "subdir", "skill.md"))).toBe(true);
    // Must not fall back to bare basename
    expect(fs.existsSync(path.join(destDir, "skill.md"))).toBe(false);
  });

  /**
   * When globBase is not set, the compiler falls back to basename — only the
   * filename is preserved, subdirectory structure is dropped.
   *
   * Source:   tmp/src/subdir/skill.md
   * globBase: (not set)
   * destDir:  tmp/dest
   * Expected: tmp/dest/skill.md
   */
  it("falls back to basename when globBase is not set", async () => {
    tmp = makeTmpDir();
    const subDir = path.join(tmp.path, "src", "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    const srcFile = path.join(subDir, "skill.md");
    fs.writeFileSync(srcFile, "# Skill\n", "utf8");

    const destDir = path.join(tmp.path, "dest");

    await new CompilationService().compile({
      targets: [{
        rootInputPath: srcFile,
        outputs: [{ destinationDir: destDir }],
      }],
    });

    expect(fs.existsSync(path.join(destDir, "skill.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "subdir", "skill.md"))).toBe(false);
  });

  /**
   * .tpl. is stripped from the output filename even when globBase is set.
   *
   * Source:   tmp/src/subdir/entry.tpl.md
   * globBase: tmp/src
   * destDir:  tmp/dest
   * Expected: tmp/dest/subdir/entry.md  (not entry.tpl.md)
   */
  it("strips .tpl. from the output filename when globBase is set", async () => {
    tmp = makeTmpDir();
    const srcBase = path.join(tmp.path, "src");
    const subDir = path.join(srcBase, "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    const srcFile = path.join(subDir, "entry.tpl.md");
    fs.writeFileSync(srcFile, "# {{ title }}\n", "utf8");

    const destDir = path.join(tmp.path, "dest");

    await new CompilationService().compile({
      targets: [{
        rootInputPath: srcFile,
        globBase: srcBase,
        outputs: [{ destinationDir: destDir, vars: { title: "Test" } }],
      }],
    });

    expect(fs.existsSync(path.join(destDir, "subdir", "entry.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "subdir", "entry.tpl.md"))).toBe(false);
  });
});
