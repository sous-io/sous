import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { globSync } from "glob";
import { toGlobPattern } from "./glob-pattern.js";
import { makeTmpDir, type TmpDir } from "../test/utils/tmp.js";

describe("toGlobPattern()", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-glob-pattern-");
    fs.mkdirSync(path.join(tmp.path, "skills", "nested"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "skills", "a.md"), "a");
    fs.writeFileSync(path.join(tmp.path, "skills", "nested", "b.md"), "b");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * toGlobPattern should turn a pattern built with `path.join` into one glob
   * matches on every platform. On Windows `path.join` writes `\`, which glob
   * reads as an escape, so the raw pattern matched nothing at all.
   *
   * globSync(toGlobPattern(path.join(dir, "skills", "**", "*.md")));
   * // -> [<dir>/skills/a.md, <dir>/skills/nested/b.md]
   */
  it("should make a path-built pattern match the files under it", () => {
    const pattern = toGlobPattern(path.join(tmp.path, "skills", "**", "*.md"));

    const matched = globSync(pattern, { absolute: true }).map((file) =>
      path.relative(tmp.path, file).split(path.sep).join("/")
    );

    expect(matched.sort()).toEqual(["skills/a.md", "skills/nested/b.md"]);
  });

  /**
   * toGlobPattern should leave a pattern already written with `/` untouched, so
   * calling it on a pattern that never held a backslash changes nothing.
   *
   * toGlobPattern("/repo/skills/**\/*"); // -> "/repo/skills/**\/*"
   */
  it("should leave a forward-slash pattern unchanged", () => {
    expect(toGlobPattern("/repo/skills/**/*")).toBe("/repo/skills/**/*");
  });
});
