import fs from "node:fs";
import path from "node:path";
import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerGetFilesTag } from "./getFiles.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

describe("registerGetFilesTag()", () => {
  let engine: Liquid;
  let tmp: TmpDir;

  beforeEach(() => {
    engine = new Liquid();
    registerGetFilesTag(engine);
    tmp = makeTmpDir("sous-getfiles-");
    writeFile("a.mjs", "");
    writeFile("b.mjs", "");
    writeFile("run.mjs", "");
    writeFile("notes.md", "");
    writeFile("sub/c.mjs", "");
  });

  afterEach(() => tmp.cleanup());

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it("should assign matched files to the named scope variable and render nothing", async () => {
    const tpl = `{% getFiles files root="${tmp.path}" include="*.mjs" %}[{{ files | map: "name" | join: "," }}]`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("[a.mjs,b.mjs,run.mjs]");
  });

  it("should expose path, dir, relPath, and name on each result", async () => {
    const tpl = `{% getFiles files root="${tmp.path}" include="sub/*.mjs" %}{{ files[0].name }}|{{ files[0].relPath }}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("c.mjs|sub/c.mjs");
  });

  it("should apply exclude globs", async () => {
    const tpl = `{% getFiles files root="${tmp.path}" include="*.mjs" exclude="run.mjs" %}{{ files | map: "name" | join: "," }}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("a.mjs,b.mjs");
  });

  it("should resolve the root attribute from a scope variable", async () => {
    const tpl = `{% getFiles files root=tasksDir include="*.mjs" %}{{ files | size }}`;
    const result = await engine.parseAndRender(tpl, { tasksDir: tmp.path });
    expect(result).toBe("3");
  });

  it("should assign an empty array when nothing matches", async () => {
    const tpl = `{% getFiles files root="${tmp.path}" include="*.txt" %}{{ files | size }}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("0");
  });

  it("should throw when root is missing", async () => {
    await expect(
      engine.parseAndRender(`{% getFiles files include="*.mjs" %}`)
    ).rejects.toThrow(/root/);
  });

  describe("with import= flag", () => {
    beforeEach(() => {
      // Replace flat fixtures with files that carry a `meta` export.
      writeFile("alpha.mjs", `export const meta = { name: "alpha", description: "First task" };\n`);
      writeFile("beta.mjs", `export const meta = { name: "beta", description: "Second task" };\n`);
      writeFile("nometa.mjs", `export const other = 1;\n`);
      writeFile("broken.mjs", `not valid javascript :::\n`);
    });

    it("should attach the named export under the same key", async () => {
      const tpl =
        `{% getFiles tasks root="${tmp.path}" include="alpha.mjs,beta.mjs" import="meta" %}` +
        `{% for t in tasks %}{{ t.meta.name }}:{{ t.meta.description }};{% endfor %}`;
      const result = await engine.parseAndRender(tpl);
      expect(result).toBe("alpha:First task;beta:Second task;");
    });

    it("should omit files that lack the requested export", async () => {
      const tpl =
        `{% getFiles tasks root="${tmp.path}" include="alpha.mjs,nometa.mjs" import="meta" %}` +
        `{{ tasks | map: "name" | join: "," }}`;
      const result = await engine.parseAndRender(tpl);
      expect(result).toBe("alpha.mjs");
    });

    it("should skip files that fail to import rather than throwing", async () => {
      const tpl =
        `{% getFiles tasks root="${tmp.path}" include="alpha.mjs,broken.mjs" import="meta" %}` +
        `{{ tasks | size }}`;
      const result = await engine.parseAndRender(tpl);
      expect(result).toBe("1");
    });

    it("should behave like glob-only when import= is absent", async () => {
      const tpl =
        `{% getFiles tasks root="${tmp.path}" include="alpha.mjs,nometa.mjs" %}` +
        `{{ tasks | size }}`;
      const result = await engine.parseAndRender(tpl);
      expect(result).toBe("2");
    });
  });
});
