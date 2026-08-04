import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { importNamedExport } from "./import-export.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

describe("importNamedExport()", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("sous-import-");
  });

  afterEach(() => tmp.cleanup());

  function writeFile(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it("should return a named export's value", async () => {
    const file = writeFile(
      "good.mjs",
      `export const meta = { name: "alpha", count: 2 };\nexport async function execute() {}\n`
    );
    const meta = await importNamedExport(file, "meta");
    expect(meta).toEqual({ name: "alpha", count: 2 });
  });

  it("should preserve non-JSON values like RegExp and functions in the export", async () => {
    const file = writeFile(
      "rich.mjs",
      `export const meta = { name: "x", params: { id: { validate: /^ri\\./, check: (v) => !!v } } };\n`
    );
    const meta = (await importNamedExport(file, "meta")) as any;
    expect(meta.params.id.validate).toBeInstanceOf(RegExp);
    expect(typeof meta.params.id.check).toBe("function");
    expect(meta.params.id.check("ri.x")).toBe(true);
  });

  it("should return undefined when the export is missing", async () => {
    const file = writeFile("nometa.mjs", `export const other = 1;\n`);
    expect(await importNamedExport(file, "meta")).toBeUndefined();
  });

  it("should return undefined (not throw) when the module fails to import", async () => {
    const file = writeFile("broken.mjs", `this is not valid javascript ::: !!!\n`);
    let errored = false;
    const result = await importNamedExport(file, "meta", () => {
      errored = true;
    });
    expect(result).toBeUndefined();
    expect(errored).toBe(true);
  });

  it("should read the default export when asked", async () => {
    const file = writeFile("def.mjs", `export default { ok: true };\n`);
    expect(await importNamedExport(file, "default")).toEqual({ ok: true });
  });
});
