import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * Every `.tpl.` file renders as Liquid by its own name, and no other file ever
 * does, whichever file includes it.
 */
describe("per-file Liquid rendering (real compile path)", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = makeTmpDir("per-file-render-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  /** Writes a file relative to the temp dir, creating parent directories. */
  function write(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  const outPath = () => path.join(tmp.path, "out", "OUT.md");

  /** Compiles one entry with the given variables and returns the result and output. */
  async function compile(
    entry: string,
    vars: Record<string, string> = { who: "world" },
    options: { stateFile?: string; rebuild?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    const compiler = new CompilationService({ rebuild: options.rebuild ?? true });
    const ok = await compiler.compile(
      {
        targets: [{ rootInputPath: entry, outputs: [{ destinationFile: outPath(), vars }] }],
      },
      options.stateFile
    );
    return { ok, output: fs.existsSync(outPath()) ? fs.readFileSync(outPath(), "utf8") : "" };
  }

  /**
   * A `.tpl.` child renders even though its host is a plain file; the host's
   * own text is copied verbatim.
   *
   * ENTRY.md "plain {{ who }}" + @child.tpl.md "hi {{ who }}"
   * // -> "plain {{ who }}" and "hi world"
   */
  it("should render a .tpl. child in a plain host and leave the host literal", async () => {
    write("ENTRY.md", "plain {{ who }}\n\n@child.tpl.md\n");
    write("child.tpl.md", "hi {{ who }}");

    const { ok, output } = await compile(path.join(tmp.path, "ENTRY.md"));

    expect(ok).toBe(true);
    expect(output).toContain("plain {{ who }}");
    expect(output).toContain("hi world");
  });

  /**
   * A plain child of a `.tpl.` host stays literal; the host renders.
   *
   * ENTRY.tpl.md "host {{ who }}" + @child.md "kid {{ who }}"
   * // -> "host world" and "kid {{ who }}"
   */
  it("should leave a plain child literal inside a .tpl. host", async () => {
    write("ENTRY.tpl.md", "host {{ who }}\n\n@child.md\n");
    write("child.md", "kid {{ who }}");

    const { ok, output } = await compile(path.join(tmp.path, "ENTRY.tpl.md"));

    expect(ok).toBe(true);
    expect(output).toContain("host world");
    expect(output).toContain("kid {{ who }}");
  });

  /**
   * The name of the file found decides, not the spelling of the include:
   * `@x.md` finding `x.tpl.md` renders it; `@y.tpl.md` finding `y.md` does not.
   *
   * @x.md (only x.tpl.md exists) -> rendered; @y.tpl.md (only y.md exists) -> literal
   */
  it("should decide by the resolved file name, including through a .tpl. twin", async () => {
    write("ENTRY.md", "@x.md\n\n@y.tpl.md\n");
    write("x.tpl.md", "x {{ who }}");
    write("y.md", "y {{ who }}");

    const { ok, output } = await compile(path.join(tmp.path, "ENTRY.md"));

    expect(ok).toBe(true);
    expect(output).toContain("x world");
    expect(output).toContain("y {{ who }}");
  });

  /**
   * An include line inside a condition of a `.tpl.` host appears only when the
   * condition holds.
   *
   * {% if who == "world" %}@a.md{% endif %} and {% if who == "nobody" %}@b.md{% endif %}
   * // -> A only
   */
  it("should honor a condition around an include line", async () => {
    write(
      "ENTRY.tpl.md",
      '{% if who == "world" %}\n@a.md\n{% endif %}\n{% if who == "nobody" %}\n@b.md\n{% endif %}\n'
    );
    write("a.md", "AAA");
    write("b.md", "BBB");

    const { ok, output } = await compile(path.join(tmp.path, "ENTRY.tpl.md"));

    expect(ok).toBe(true);
    expect(output).toContain("AAA");
    expect(output).not.toContain("BBB");
  });

  /**
   * Nothing renders twice: a variable whose value holds Liquid syntax comes out
   * as that text, even though a `.tpl.` host includes the `.tpl.` child that
   * printed it.
   *
   * who = "{{ again }}"; child.tpl.md "{{ who }}" included by ENTRY.tpl.md
   * // -> "{{ again }}"
   */
  it("should not render a rendered child again", async () => {
    write("ENTRY.tpl.md", "@child.tpl.md\n");
    write("child.tpl.md", "{{ who }}");

    const { ok, output } = await compile(path.join(tmp.path, "ENTRY.tpl.md"), {
      who: "{{ again }}",
    });

    expect(ok).toBe(true);
    expect(output.trim()).toBe("{{ again }}");
  });

  /**
   * A child's own includes expand inside it, and each renders by its own name.
   *
   * ENTRY.md -> mid.tpl.md -> leaf.md, with Liquid in all three
   * // -> mid rendered, leaf literal
   */
  it("should expand a child's includes before putting it in place", async () => {
    write("ENTRY.md", "@mid.tpl.md\n");
    write("mid.tpl.md", "mid {{ who }}\n@leaf.md\n");
    write("leaf.md", "leaf {{ who }}");

    const { output } = await compile(path.join(tmp.path, "ENTRY.md"));

    expect(output).toContain("mid world");
    expect(output).toContain("leaf {{ who }}");
  });

  /**
   * A file may be included twice and renders each time.
   *
   * @c.tpl.md twice -> "c world" twice
   */
  it("should render a file included more than once each time", async () => {
    write("ENTRY.md", "@c.tpl.md\n\n@c.tpl.md\n");
    write("c.tpl.md", "c {{ who }}");

    const { output } = await compile(path.join(tmp.path, "ENTRY.md"));

    expect(output.match(/c world/g)).toHaveLength(2);
  });

  /**
   * The source hash covers every included file and the scope: changing a
   * `.tpl.` child of a plain host, or a variable, re-renders the output;
   * changing nothing leaves it alone.
   *
   * first build, unchanged build -> "(unchanged)"; edit child -> rewritten
   */
  it("should re-render when an included child or a variable changes", async () => {
    const entry = write("ENTRY.md", "@child.tpl.md\n");
    const child = write("child.tpl.md", "v1 {{ who }}");
    const stateFile = path.join(tmp.path, "state.json");

    await compile(entry, { who: "world" }, { stateFile, rebuild: false });
    expect(fs.readFileSync(outPath(), "utf8")).toContain("v1 world");

    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    await compile(entry, { who: "world" }, { stateFile, rebuild: false });
    expect(lines.join("\n")).toContain("(unchanged)");

    fs.writeFileSync(child, "v2 {{ who }}");
    await compile(entry, { who: "world" }, { stateFile, rebuild: false });
    expect(fs.readFileSync(outPath(), "utf8")).toContain("v2 world");

    await compile(entry, { who: "moon" }, { stateFile, rebuild: false });
    expect(fs.readFileSync(outPath(), "utf8")).toContain("v2 moon");
  });

  /**
   * A `.tpl.` child written to an output with no vars is reported, naming the
   * child, and nothing renders.
   *
   * output without vars, child.tpl.md in a plain host -> warning names child.tpl.md
   */
  it("should name a .tpl. child that could not render for lack of vars", async () => {
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const entry = write("ENTRY.md", "@child.tpl.md\n");
    write("child.tpl.md", "{{ who }}");

    const compiler = new CompilationService({});
    await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: outPath() }] }],
    });

    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("child.tpl.md");
    expect(text).toContain("WITHOUT BEING RENDERED");
  });

  /**
   * The compiler remembers every file it read, for the unincluded-memory check.
   *
   * compile ENTRY.md that includes a.md -> includedFiles() has both
   */
  it("should report every file the compile read", async () => {
    const entry = write("ENTRY.md", "@a.md\n");
    const a = write("a.md", "A");
    const compiler = new CompilationService({ rebuild: true });
    await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: outPath(), vars: {} }] }],
    });

    expect(compiler.includedFiles().has(fs.realpathSync(a))).toBe(true);
    expect(compiler.includedFiles().has(fs.realpathSync(entry))).toBe(true);
  });
});
