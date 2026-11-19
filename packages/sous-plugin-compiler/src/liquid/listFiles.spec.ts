/** Ported from today's `src/templating/tags/listFiles.spec.ts`; the tag or filter is now a `liquid-tag` or `liquid-filter` entity. */

import fs from "node:fs";
import path from "node:path";
import { Liquid } from "liquidjs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerListFilesTag } from "../../test/liquid.js";
import { makeTmpDir, type TmpDir } from "../../test/tmp.js";

describe("registerListFilesTag()", () => {
  let engine: Liquid;
  let tmp: TmpDir;
  // The temp dir as a Liquid string literal. Liquid drops a backslash inside a
  // quoted string, so a Windows path is written with `/`, which Node reads the same.
  let rootLiteral: string;

  beforeEach(() => {
    engine = new Liquid();
    registerListFilesTag(engine);
    tmp = makeTmpDir("sous-listfiles-");
    rootLiteral = tmp.path.split(path.sep).join("/");
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
    const tpl = `{% listFiles root="${rootLiteral}" include="*.mjs" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("- a.mjs\n- b.mjs");
  });

  it("should render relative paths when relative=\"true\"", async () => {
    const tpl = `{% listFiles root="${rootLiteral}" include="**/*.mjs" relative="true" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("- a.mjs\n- b.mjs\n- sub/c.mjs");
  });

  it("should apply exclude globs", async () => {
    const tpl = `{% listFiles root="${rootLiteral}" include="**/*.mjs" exclude="sub/**" %}`;
    const result = await engine.parseAndRender(tpl);
    expect(result).toBe("- a.mjs\n- b.mjs");
  });

  it("should render nothing when no files match", async () => {
    const tpl = `{% listFiles root="${rootLiteral}" include="*.txt" %}`;
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
