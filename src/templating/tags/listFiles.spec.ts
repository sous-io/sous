import fs from "node:fs";
import path from "node:path";
import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerListFilesTag } from "./listFiles.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

describe("registerListFilesTag()", () => {
  let engine: Liquid;
  let tmp: TmpDir;

  beforeEach(() => {
    engine = new Liquid();
    registerListFilesTag(engine);
    tmp = makeTmpDir("sous-listfiles-");
    writeFile("a.mjs", "");
    writeFile("b.mjs", "");
    writeFile("notes.md", "");
    writeFile("sub/c.mjs", "");
  });

  afterEach(() => tmp.cleanup());

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it("should render a markdown bullet list of file names", async () => {
    const tpl = `{% listFiles root="${tmp.path}" include="*.mjs" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("- a.mjs\n- b.mjs");
  });

  it("should render relative paths when relative=\"true\"", async () => {
    const tpl = `{% listFiles root="${tmp.path}" include="**/*.mjs" relative="true" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("- a.mjs\n- b.mjs\n- sub/c.mjs");
  });

  it("should apply exclude globs", async () => {
    const tpl = `{% listFiles root="${tmp.path}" include="**/*.mjs" exclude="sub/**" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("- a.mjs\n- b.mjs");
  });

  it("should render nothing when no files match", async () => {
    const tpl = `{% listFiles root="${tmp.path}" include="*.txt" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("");
  });

  it("should resolve the root attribute from a scope variable", async () => {
    const tpl = `{% listFiles root=dir include="*.md" %}`;
    const result = await engine.parseAndRender(tpl, { dir: tmp.path });
    expect(result).toBe("- notes.md");
  });

  it("should throw when root is missing", async () => {
    await expect(
      engine.parseAndRender(`{% listFiles include="*.mjs" %}`)
    ).rejects.toThrow(/root/);
  });
});
