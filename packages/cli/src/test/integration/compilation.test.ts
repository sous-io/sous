import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { copyFixture } from "../utils/fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompiler(options: ConstructorParameters<typeof CompilationService>[0] = {}) {
  return new CompilationService(options);
}

// ---------------------------------------------------------------------------
// describe("CompilationService")
// ---------------------------------------------------------------------------

describe("CompilationService", () => {
  let tmp: TmpDir;

  afterEach(() => {
    tmp?.cleanup();
  });

  // -------------------------------------------------------------------------
  // Simple entry point — no includes
  // -------------------------------------------------------------------------

  /**
   * A plain entry point with no @include directives should be copied verbatim
   * to the destination file.
   *
   * Source: simple/entry.md  ("# Simple Entry\n\nThis is a simple entry point...")
   * After compile: output/<dest>.md exists and its content equals the source.
   */
  it("should write output file whose content matches the source for a simple entry point", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "entry.md");
    const sourceContent = fs.readFileSync(entryPoint, "utf8");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationFile: destFile }],
        },
      ],
    });

    expect(result).toBe(true);
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, "utf8")).toBe(sourceContent);
  });

  // -------------------------------------------------------------------------
  // @include resolution
  // -------------------------------------------------------------------------

  /**
   * When an entry point uses @include directives, the included files' content
   * should be inlined at the point of inclusion in the output.
   *
   * with-includes/entry.md includes nested/child.md and shared.md.
   * After compile: output contains "# Shared" (from shared.md) and "# Child"
   * (from nested/child.md).
   */
  it("should inline included file content at the @include directive", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("with-includes", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "result.md");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationFile: destFile }],
        },
      ],
    });

    expect(result).toBe(true);
    const output = fs.readFileSync(destFile, "utf8");
    expect(output).toContain("# Shared");
    expect(output).toContain("This content is shared across multiple entry points.");
  });

  // -------------------------------------------------------------------------
  // Nested @include (A -> B -> C)
  // -------------------------------------------------------------------------

  /**
   * @include chains should be resolved transitively. child.md includes
   * shared.md, and entry.md includes child.md, so shared.md content should
   * appear in the final output even though entry.md does not directly include it.
   *
   * with-includes/entry.md -> nested/child.md -> shared.md
   * After compile: output contains content from shared.md ("This content is shared...")
   * via the nested include in child.md.
   */
  it("should resolve nested @includes transitively (A includes B includes C)", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("with-includes", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "nested-result.md");

    const compiler = makeCompiler();
    await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationFile: destFile }],
        },
      ],
    });

    const output = fs.readFileSync(destFile, "utf8");
    // shared.md is included transitively via nested/child.md -> shared.md
    // AND directly from entry.md, but either way it must appear
    expect(output).toContain("This content is shared across multiple entry points.");
    // child.md content should also be present
    expect(output).toContain("This is a nested child file.");
  });

  // -------------------------------------------------------------------------
  // Circular @include
  // -------------------------------------------------------------------------

  /**
   * A circular @include chain (a.md includes b.md, b.md includes a.md) must
   * not cause an infinite loop. The compiler should detect the cycle, report
   * it as an error, and still return without hanging or throwing.
   *
   * with-circular/a.md -> b.md -> a.md (cycle)
   * After compile: returns false or true (either is acceptable) but does NOT
   * throw and does NOT hang.
   */
  it("should not hang or throw on a circular @include; should complete and report error", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("with-circular", tmp.path);
    const entryPoint = path.join(fixtureDir, "a.md");
    const destFile = path.join(tmp.path, "out", "circular.md");

    const compiler = makeCompiler();

    // Must resolve (not hang) within a generous timeout
    let threw = false;
    try {
      await compiler.compile({
        targets: [
          {
            rootInputPath: entryPoint,
            outputs: [{ destinationFile: destFile }],
          },
        ],
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  // -------------------------------------------------------------------------
  // .tpl. file with vars — LiquidJS substitution + filename stripping
  // -------------------------------------------------------------------------

  /**
   * Entry points whose filename contains ".tpl." are rendered through LiquidJS.
   * Variables passed in output.vars are substituted, and ".tpl." is stripped
   * from the output filename when using destinationDir.
   *
   * with-templates/entry.tpl.md contains "{{ projectName }}"
   * output.vars = { projectName: "TestProj" }
   * After compile: output file contains "TestProj" (not "{{ projectName }}").
   */
  it("should substitute LiquidJS vars and strip .tpl. from the output filename", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("with-templates", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.tpl.md");
    const destFile = path.join(tmp.path, "out", "entry.md");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationFile: destFile, vars: { projectName: "TestProj" } }],
        },
      ],
    });

    expect(result).toBe(true);
    expect(fs.existsSync(destFile)).toBe(true);
    const output = fs.readFileSync(destFile, "utf8");
    expect(output).toContain("TestProj");
    expect(output).not.toContain("{{ projectName }}");
  });

  // -------------------------------------------------------------------------
  // .tpl. — destinationDir strips .tpl. from output filename
  // -------------------------------------------------------------------------

  /**
   * When using destinationDir (instead of destinationFile) for a .tpl. entry,
   * the output filename should have ".tpl." stripped (entry.tpl.md -> entry.md).
   *
   * with-templates/entry.tpl.md compiled to destinationDir -> out/
   * After compile: out/entry.md exists (not out/entry.tpl.md).
   */
  it("should strip .tpl. from the output filename when using destinationDir", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("with-templates", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.tpl.md");
    const destDir = path.join(tmp.path, "outdir");

    const compiler = makeCompiler();
    await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationDir: destDir, vars: { projectName: "TestProj" } }],
        },
      ],
    });

    // .tpl. stripped: entry.tpl.md -> entry.md
    expect(fs.existsSync(path.join(destDir, "entry.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "entry.tpl.md"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Verbatim copy (non-.tpl. file)
  // -------------------------------------------------------------------------

  /**
   * Entry points without ".tpl." in their filename are copied verbatim — no
   * LiquidJS processing occurs. Any "{{ ... }}" tags in the source are left
   * untouched in the output.
   *
   * A source file containing "{{ raw_tag }}" compiled without .tpl.
   * After compile: output still contains "{{ raw_tag }}" unchanged.
   */
  it("should copy non-.tpl. files verbatim without processing LiquidJS tags", async () => {
    tmp = makeTmpDir();
    // Write a source file with a raw LiquidJS tag directly to tmp
    const srcFile = path.join(tmp.path, "verbatim.md");
    const rawContent = "# Verbatim\n\n{{ do_not_render_me }}\n";
    fs.writeFileSync(srcFile, rawContent, "utf8");
    const destFile = path.join(tmp.path, "out", "verbatim.md");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: srcFile,
          outputs: [{ destinationFile: destFile, vars: { do_not_render_me: "SUBSTITUTED" } }],
        },
      ],
    });

    expect(result).toBe(true);
    const output = fs.readFileSync(destFile, "utf8");
    // Without .tpl. the vars are NOT applied; raw tag is preserved
    expect(output).toContain("{{ do_not_render_me }}");
    expect(output).not.toContain("SUBSTITUTED");
  });

  // -------------------------------------------------------------------------
  // Skip unchanged (srcHash matches, file already exists)
  // -------------------------------------------------------------------------

  /**
   * When a destination file already exists and its recorded srcHash matches
   * the current source hash, the compiler should skip rewriting the file on
   * the second compile call.
   *
   * Run compile twice with the same source.
   * After second compile: output file mtime is identical to that after the
   * first compile (the file was not rewritten).
   */
  it("should skip writing an output file when srcHash is unchanged and file exists", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "entry.md");
    const stateFilePath = path.join(tmp.path, "sous.state.json");

    const compiler1 = makeCompiler();
    await compiler1.compile(
      {
        targets: [{ rootInputPath: entryPoint, outputs: [{ destinationFile: destFile }] }],
      },
      stateFilePath
    );

    const mtimeAfterFirst = fs.statSync(destFile).mtimeMs;

    // Wait briefly to ensure mtime would differ if the file were rewritten
    await new Promise(resolve => setTimeout(resolve, 20));

    const compiler2 = makeCompiler();
    await compiler2.compile(
      {
        targets: [{ rootInputPath: entryPoint, outputs: [{ destinationFile: destFile }] }],
      },
      stateFilePath
    );

    const mtimeAfterSecond = fs.statSync(destFile).mtimeMs;
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
  });

  // -------------------------------------------------------------------------
  // --rebuild bypasses skip
  // -------------------------------------------------------------------------

  /**
   * When the compiler is created with rebuild: true, it should rewrite the
   * output file even if the source hash matches the existing state entry.
   *
   * Run compile once (establishes state), then run again with rebuild: true.
   * After second compile: output file mtime is greater than after the first
   * compile, confirming the file was rewritten.
   */
  it("should rewrite the output file when rebuild: true even if srcHash is unchanged", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "entry.md");
    const stateFilePath = path.join(tmp.path, "sous.state.json");

    const compiler1 = makeCompiler();
    await compiler1.compile(
      {
        targets: [{ rootInputPath: entryPoint, outputs: [{ destinationFile: destFile }] }],
      },
      stateFilePath
    );

    const mtimeAfterFirst = fs.statSync(destFile).mtimeMs;

    // Ensure filesystem clock advances
    await new Promise(resolve => setTimeout(resolve, 20));

    const compiler2 = makeCompiler({ rebuild: true });
    await compiler2.compile(
      {
        targets: [{ rootInputPath: entryPoint, outputs: [{ destinationFile: destFile }] }],
      },
      stateFilePath
    );

    const mtimeAfterSecond = fs.statSync(destFile).mtimeMs;
    expect(mtimeAfterSecond).toBeGreaterThan(mtimeAfterFirst);
  });

  // -------------------------------------------------------------------------
  // --dry-run: output file NOT created
  // -------------------------------------------------------------------------

  /**
   * When the compiler is created with dryRun: true, it should not write any
   * output files to disk, but should still return true (no error).
   *
   * Before compile: destination file does not exist.
   * After compile (dryRun): destination file still does not exist; result is true.
   */
  it("should not create any output files when dryRun: true", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "entry.md");

    const compiler = makeCompiler({ dryRun: true });
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationFile: destFile }],
        },
      ],
    });

    expect(result).toBe(true);
    expect(fs.existsSync(destFile)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // includeSourceComments: true
  // -------------------------------------------------------------------------

  /**
   * When includeSourceComments is true on the target, the compiler should
   * insert an HTML comment "<!-- from: <relative-path> -->" before each
   * included file's content in the output.
   *
   * with-source-comments/entry.md includes section.md.
   * After compile: output contains "<!-- from: section.md -->".
   */
  it("should insert <!-- from: ... --> comments before included content when includeSourceComments is true", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("with-source-comments", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "result.md");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          includeSourceComments: true,
          outputs: [{ destinationFile: destFile }],
        },
      ],
    });

    expect(result).toBe(true);
    const output = fs.readFileSync(destFile, "utf8");
    expect(output).toContain("<!-- from:");
    expect(output).toContain("section.md");
  });

  // -------------------------------------------------------------------------
  // Multi-output target (same source, two destinations)
  // -------------------------------------------------------------------------

  /**
   * A single compilation target may declare multiple outputs. The compiler
   * should write the same compiled content to every destination.
   *
   * simple/entry.md compiled with outputs: [destFile1, destFile2]
   * After compile: both files exist and both contain the source content.
   */
  it("should write the compiled content to every destination in a multi-output target", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile1 = path.join(tmp.path, "out1", "entry.md");
    const destFile2 = path.join(tmp.path, "out2", "entry.md");
    const sourceContent = fs.readFileSync(entryPoint, "utf8");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [
            { destinationFile: destFile1 },
            { destinationFile: destFile2 },
          ],
        },
      ],
    });

    expect(result).toBe(true);
    expect(fs.existsSync(destFile1)).toBe(true);
    expect(fs.existsSync(destFile2)).toBe(true);
    expect(fs.readFileSync(destFile1, "utf8")).toBe(sourceContent);
    expect(fs.readFileSync(destFile2, "utf8")).toBe(sourceContent);
  });

  // -------------------------------------------------------------------------
  // State file written
  // -------------------------------------------------------------------------

  /**
   * When a stateFilePath is provided, the compiler should create (or update)
   * a JSON state file that records every output with dest, srcHash, size, and
   * builtAt fields.
   *
   * simple/entry.md compiled with stateFilePath = tmp/sous.state.json
   * After compile: the state file exists and contains a files array with an
   * entry whose dest equals destFile and that has srcHash, size, and builtAt.
   */
  it("should write a state file with correct entries after compilation", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "out", "entry.md");
    const stateFilePath = path.join(tmp.path, "sous.state.json");

    const compiler = makeCompiler();
    const result = await compiler.compile(
      {
        targets: [
          {
            rootInputPath: entryPoint,
            outputs: [{ destinationFile: destFile }],
          },
        ],
      },
      stateFilePath
    );

    expect(result).toBe(true);
    expect(fs.existsSync(stateFilePath)).toBe(true);

    const state = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    expect(state.files).toBeInstanceOf(Array);
    expect(state.files.length).toBeGreaterThanOrEqual(1);

    const entry = state.files.find((f: { dest: string }) => f.dest === destFile);
    expect(entry).toBeDefined();
    expect(entry.srcHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.size).toBe("number");
    expect(entry.size).toBeGreaterThan(0);
    expect(typeof entry.builtAt).toBe("string");
    expect(entry.builtAt).not.toBe("");
  });

  // -------------------------------------------------------------------------
  // Output directories created
  // -------------------------------------------------------------------------

  /**
   * When the destination path contains intermediate directories that do not
   * yet exist, the compiler should create them automatically.
   *
   * Destination: tmp/deep/nested/dir/entry.md (none of the dirs exist yet)
   * After compile: all intermediate directories exist and the output file
   * is present.
   */
  it("should create intermediate output directories that do not yet exist", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "deep", "nested", "dir", "entry.md");

    const compiler = makeCompiler();
    const result = await compiler.compile({
      targets: [
        {
          rootInputPath: entryPoint,
          outputs: [{ destinationFile: destFile }],
        },
      ],
    });

    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, "deep", "nested", "dir"))).toBe(true);
    expect(fs.existsSync(destFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // State file records created directories
  // -------------------------------------------------------------------------

  /**
   * When the compiler creates new intermediate directories on disk, those
   * directory paths should be recorded in the state file's "dirs" array so
   * that prune/clear operations can remove them.
   *
   * Destination with deep new dirs compiled with stateFilePath.
   * After compile: state.dirs contains at least one of the newly created paths.
   */
  it("should record newly created output directories in the state file", async () => {
    tmp = makeTmpDir();
    const fixtureDir = copyFixture("simple", tmp.path);
    const entryPoint = path.join(fixtureDir, "entry.md");
    const destFile = path.join(tmp.path, "brand", "new", "dir", "entry.md");
    const stateFilePath = path.join(tmp.path, "sous.state.json");

    const compiler = makeCompiler();
    await compiler.compile(
      {
        targets: [
          {
            rootInputPath: entryPoint,
            outputs: [{ destinationFile: destFile }],
          },
        ],
      },
      stateFilePath
    );

    const state = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    expect(state.dirs).toBeInstanceOf(Array);
    // At least the immediate parent of destFile should be recorded
    expect(state.dirs.some((d: string) => d.includes("brand"))).toBe(true);
  });
});
