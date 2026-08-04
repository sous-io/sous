import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * Integration coverage for alias / ${var} resolution in `{% render %}` (parity
 * with `@include`), through the real compile path. Also guards that standard
 * relative `{% render %}` still works with the custom FS.
 */
describe("alias {% render %} resolution (real compile path)", () => {
  let tmp: TmpDir;
  afterEach(() => tmp?.cleanup());

  function write(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it("renders a partial referenced by ~alias from outside the entry tree", async () => {
    tmp = makeTmpDir("alias-render-");
    write("lib/partial.md", "RENDERED VIA ALIAS");
    const entry = write("p/entry.tpl.md", `{% raw %}{% endraw %}{% render "@~lib/partial.md" %}`);
    const dest = path.join(tmp.path, "out/entry.md");

    const compiler = new CompilationService();
    const ok = await compiler.compile({
      aliases: { "~lib": [path.join(tmp.path, "lib")] },
      includeScope: {},
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("RENDERED VIA ALIAS");
  });

  it("still resolves a standard relative {% render %}", async () => {
    tmp = makeTmpDir("alias-render-");
    write("p/child.md", "RELATIVE CHILD");
    const entry = write("p/entry.tpl.md", `{% render "child.md" %}`);
    const dest = path.join(tmp.path, "out/entry.md");

    const compiler = new CompilationService();
    const ok = await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("RELATIVE CHILD");
  });
});
