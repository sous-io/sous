import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * Integration coverage for alias / ${var} `@include` resolution through the real
 * CompilationService (not just the pure resolver). Proves a project memory file
 * can pull content from outside its own tree directly — no double-compile.
 */
describe("alias @include resolution (real compile path)", () => {
  let tmp: TmpDir;
  afterEach(() => tmp?.cleanup());

  function write(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it("resolves a ~alias include from a directory outside the entry's tree", async () => {
    tmp = makeTmpDir("alias-inc-");
    // "shared" library, somewhere else entirely
    write("shared/snippet.md", "SHARED SNIPPET BODY");
    // project entry that pulls it in by alias
    const entry = write("project/AGENTS.tpl.md", "# Top\n\n@~lib/snippet.md\n");
    const dest = path.join(tmp.path, "out/AGENTS.md");

    const compiler = new CompilationService();
    const ok = await compiler.compile({
      aliases: { "~lib": [path.join(tmp.path, "shared")] },
      includeScope: {},
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("SHARED SNIPPET BODY");
  });

  it("resolves a ${var}-absolute include", async () => {
    tmp = makeTmpDir("alias-inc-");
    write("ext/note.md", "EXTERNAL NOTE");
    const entry = write("p/entry.tpl.md", "@${extRoot}/note.md\n");
    const dest = path.join(tmp.path, "out/entry.md");

    const compiler = new CompilationService();
    const ok = await compiler.compile({
      includeScope: { extRoot: path.join(tmp.path, "ext") },
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("EXTERNAL NOTE");
  });

  it("falls through alias miss to a real relative dir of the same name (augment)", async () => {
    tmp = makeTmpDir("alias-inc-");
    // alias base exists but does NOT contain the file; a sibling relative dir does
    write("aliasbase/other.md", "WRONG");
    write("p/stuff/one.md", "RELATIVE WINS");
    const entry = write("p/entry.tpl.md", "@stuff/one.md\n");
    const dest = path.join(tmp.path, "out/entry.md");

    const compiler = new CompilationService();
    const ok = await compiler.compile({
      aliases: { stuff: [path.join(tmp.path, "aliasbase")] },
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("RELATIVE WINS");
  });

  it("errors (does not write content) when no candidate exists", async () => {
    tmp = makeTmpDir("alias-inc-");
    const entry = write("p/entry.tpl.md", "before\n@~lib/missing.md\nafter\n");
    const dest = path.join(tmp.path, "out/entry.md");

    const compiler = new CompilationService();
    await compiler.compile({
      aliases: { "~lib": [path.join(tmp.path, "shared")] },
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    // include line removed, surrounding content intact
    const out = fs.readFileSync(dest, "utf8");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("missing.md");
  });
});
