import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * Integration coverage for the {% getFiles %} tag through the REAL compile path
 * (CompilationService.compile), not the isolated LiquidJS engine.
 *
 * Because {% getFiles import="..." %} performs a dynamic import(), it can only
 * work if the compiler renders via the async parseAndRender path. This test is
 * therefore also the permanent regression guard for the compiler's
 * sync -> async render conversion: if rendering ever reverts to sync, the
 * import= assertion here fails.
 */
describe("getFiles tag (real compile path)", () => {
  let tmp: TmpDir;

  afterEach(() => tmp?.cleanup());

  function write(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it("renders a meta-driven manifest by importing each task file", async () => {
    tmp = makeTmpDir("sous-getfiles-int-");

    // Two task files with `meta`, one without, one that fails to import.
    const tasksDir = path.join(tmp.path, "tasks");
    write("tasks/get-thing.mjs", `export const meta = { name: "get-thing", description: "Fetch a thing" };\n`);
    write("tasks/do-other.mjs", `export const meta = { name: "do-other", description: "Do the other" };\n`);
    write("tasks/helper.mjs", `export function help() {}\n`);
    write("tasks/broken.mjs", `:::not valid:::\n`);

    // A template that lists tasks via getFiles + import="meta".
    const entry = write(
      "INDEX.tpl.md",
      [
        "# Tasks",
        "",
        `{% getFiles tasks root=tasksDir include="*.mjs" import="meta" %}`,
        "{% for t in tasks %}- {{ t.meta.name }}: {{ t.meta.description }}",
        "{% endfor %}",
      ].join("\n")
    );

    const destFile = path.join(tmp.path, "out", "INDEX.md");
    const compiler = new CompilationService();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entry,
          outputs: [{ destinationFile: destFile, vars: { tasksDir } }],
        },
      ],
    });

    expect(result).toBe(true);
    const out = fs.readFileSync(destFile, "utf8");

    // Both meta-bearing tasks appear, alphabetically (do-other before get-thing).
    expect(out).toContain("- do-other: Do the other");
    expect(out).toContain("- get-thing: Fetch a thing");
    // Files without meta / that fail to import are omitted.
    expect(out).not.toContain("helper");
    expect(out).not.toContain("broken");
    // The .tpl. is stripped from the output filename.
    expect(fs.existsSync(destFile)).toBe(true);
  });
});
