import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { StaticNamespaceResolver } from "../../lib/repos/namespace-resolver.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * Integration coverage for the reserved `~` namespace sigil through the real
 * CompilationService: a project template and a recipe file addressing recipes
 * by namespace, the scoping rules that gate those references, alias precedence,
 * and the guarantee that a bare `@path` never consults a namespace.
 *
 * The resolver used here is the static, in-memory implementation, so these
 * tests exercise the compiler wiring without depending on the repository store.
 */
describe("~namespace includes (real compile path)", () => {
  let tmp: TmpDir;
  afterEach(() => tmp?.cleanup());

  /** Write a file relative to the temp dir, creating parent directories. */
  function write(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  /** Absolute path inside the temp dir. */
  function at(rel: string): string {
    return path.join(tmp.path, rel);
  }

  /** Strip ANSI escape codes so assertions are not brittle against color. */
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  /** Run a compile while capturing everything written to console.log. */
  async function compileCapturingLog(fn: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(strip(args.map((a) => String(a)).join(" ")));
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  /**
   * Build the standard fixture: a store holding two namespaces, and a project
   * directory outside the store.
   */
  function seedStore(): void {
    write("store/workflow/task-files/_partials/resume.md", "RESUME PARTIAL BODY");
    write("store/workflow/github-projects/partial.md", "GITHUB PARTIAL BODY");
    write("store/core/sous-skills/notes.md", "CORE NOTES BODY");
  }

  /** A resolver over the seeded store. */
  function makeResolver(
    overrides: { dependencies?: Record<string, string[]>; projectScope?: string[] } = {}
  ) {
    return new StaticNamespaceResolver({
      recipes: {
        "workflow/task-files": at("store/workflow/task-files"),
        "workflow/github-projects": at("store/workflow/github-projects"),
        "core/sous-skills": at("store/core/sous-skills"),
      },
      dependencies: overrides.dependencies,
      projectScope: overrides.projectScope,
    });
  }

  // -------------------------------------------------------------------------
  // Project templates
  // -------------------------------------------------------------------------

  /**
   * A project template addressing `@~<namespace>/<recipe>/<file>` pulls the file
   * out of that recipe's directory in the store.
   *
   * project/AGENTS.md contains "@~workflow/task-files/_partials/resume.md".
   * After compile: the output holds "RESUME PARTIAL BODY".
   */
  it("should inline a recipe file addressed by namespace from a project template", async () => {
    tmp = makeTmpDir("ns-inc-");
    seedStore();
    const entry = write("project/AGENTS.md", "# Top\n\n@~workflow/task-files/_partials/resume.md\n");
    const dest = at("out/AGENTS.md");

    const compiler = new CompilationService({ namespaceResolver: makeResolver() });
    const ok = await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("RESUME PARTIAL BODY");
  });

  /**
   * A bare `@path` include is always a relative path or a declared alias; it
   * must never be handed to the namespace resolver, even when the first segment
   * happens to match a namespace name.
   *
   * project/AGENTS.md contains "@workflow/local.md" and project/workflow/local.md
   * exists. After compile: the LOCAL file is inlined and the resolver is never
   * called.
   */
  it("should resolve a bare @relative/path.md locally without consulting the resolver", async () => {
    tmp = makeTmpDir("ns-inc-");
    seedStore();
    write("project/workflow/local.md", "LOCAL RELATIVE BODY");
    const entry = write("project/AGENTS.md", "@workflow/local.md\n");
    const dest = at("out/AGENTS.md");

    const resolver = makeResolver();
    const calls: string[] = [];
    const spied = {
      resolve: (request: Parameters<typeof resolver.resolve>[0]) => {
        calls.push(request.namespace);
        return resolver.resolve(request);
      },
    };

    const compiler = new CompilationService({ namespaceResolver: spied });
    const ok = await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([]);
    expect(fs.readFileSync(dest, "utf8")).toContain("LOCAL RELATIVE BODY");
  });

  /**
   * A built-in or user alias keeps its meaning even when a recipe namespace
   * shares its name, because alias bases are tried before the resolver.
   *
   * With the built-in alias "~project" pointing at a real directory AND a
   * namespace named "project" in the store, the ALIAS file is inlined.
   */
  it("should prefer an alias over a namespace of the same name", async () => {
    tmp = makeTmpDir("ns-inc-");
    write("shared/recipe/file.md", "ALIAS WINS");
    write("store/project/recipe/file.md", "NAMESPACE LOSES");
    const entry = write("project/AGENTS.md", "@~project/recipe/file.md\n");
    const dest = at("out/AGENTS.md");

    const resolver = new StaticNamespaceResolver({
      recipes: { "project/recipe": at("store/project/recipe") },
    });

    const compiler = new CompilationService({ namespaceResolver: resolver });
    const ok = await compiler.compile({
      aliases: { "~project": [at("shared")] },
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
    });

    expect(ok).toBe(true);
    const out = fs.readFileSync(dest, "utf8");
    expect(out).toContain("ALIAS WINS");
    expect(out).not.toContain("NAMESPACE LOSES");
  });

  // -------------------------------------------------------------------------
  // Scoping inside recipes
  // -------------------------------------------------------------------------

  /**
   * A file that lives inside a recipe directory may address the recipes that
   * recipe declares. core/sous-skills declares workflow/task-files, so its own
   * file resolves "@~workflow/task-files/_partials/resume.md".
   */
  it("should resolve a namespace include from inside a recipe that declares the dependency", async () => {
    tmp = makeTmpDir("ns-inc-");
    seedStore();
    const entry = write(
      "store/core/sous-skills/SKILL.md",
      "# Skill\n\n@~workflow/task-files/_partials/resume.md\n"
    );
    const dest = at("out/SKILL.md");

    const compiler = new CompilationService({
      namespaceResolver: makeResolver({
        dependencies: { "core/sous-skills": ["workflow/task-files"] },
      }),
    });
    const ok = await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("RESUME PARTIAL BODY");
  });

  /**
   * The same recipe addressing a recipe it does NOT declare fails with a
   * message naming the including file, the namespace, both recipes, and the
   * fix: declare it in "depends".
   */
  it("should refuse a namespace include the including recipe does not declare", async () => {
    tmp = makeTmpDir("ns-inc-");
    seedStore();
    const entry = write(
      "store/core/sous-skills/SKILL.md",
      "before\n@~workflow/github-projects/partial.md\nafter\n"
    );
    const dest = at("out/SKILL.md");

    const compiler = new CompilationService({
      namespaceResolver: makeResolver({
        dependencies: { "core/sous-skills": ["workflow/task-files"] },
      }),
    });

    const output = await compileCapturingLog(() =>
      compiler.compile({
        targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
      })
    );

    expect(output).toContain("Include not found: @~workflow/github-projects/partial.md");
    expect(output).toContain(`in file: ${entry}`);
    expect(output).toContain("namespace: workflow");
    expect(output).toContain("recipe: workflow/github-projects");
    expect(output).toContain(
      'The recipe "core/sous-skills" does not declare "workflow/github-projects" as a dependency.'
    );
    expect(output).toContain('Add "workflow/github-projects" to the "depends" list');

    const written = fs.readFileSync(dest, "utf8");
    expect(written).toContain("before");
    expect(written).toContain("after");
    expect(written).not.toContain("GITHUB PARTIAL BODY");
  });

  /**
   * Addressing a namespace nobody publishes fails with a message that names the
   * namespaces which ARE available, so the author can see the typo.
   */
  it("should report an unknown namespace and list the available ones", async () => {
    tmp = makeTmpDir("ns-inc-");
    seedStore();
    const entry = write("project/AGENTS.md", "@~nosuch/recipe/file.md\n");
    const dest = at("out/AGENTS.md");

    const compiler = new CompilationService({ namespaceResolver: makeResolver() });

    const output = await compileCapturingLog(() =>
      compiler.compile({
        targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
      })
    );

    expect(output).toContain("Include not found: @~nosuch/recipe/file.md");
    expect(output).toContain('There is no recipe namespace named "nosuch" available here.');
    expect(output).toContain("Available namespaces: core, workflow.");
    expect(output).toContain("tried:");
  });

  // -------------------------------------------------------------------------
  // Circular includes and {% render %}
  // -------------------------------------------------------------------------

  /**
   * Circular include detection still applies when the cycle runs through
   * namespace references: two files inside one recipe that include each other
   * are reported rather than followed forever.
   */
  it("should detect a circular include that runs through namespace references", async () => {
    tmp = makeTmpDir("ns-inc-");
    seedStore();
    write("store/workflow/task-files/a.md", "A\n@~workflow/task-files/b.md\n");
    write("store/workflow/task-files/b.md", "B\n@~workflow/task-files/a.md\n");
    const entry = write("project/AGENTS.md", "@~workflow/task-files/a.md\n");
    const dest = at("out/AGENTS.md");

    const compiler = new CompilationService({ namespaceResolver: makeResolver() });

    const output = await compileCapturingLog(() =>
      compiler.compile({
        targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest }] }],
      })
    );

    expect(output).toContain("Circular dependency detected");
    expect(fs.readFileSync(dest, "utf8")).toContain("A");
  });

  /**
   * `{% render %}` reaches namespaces through the same resolver, with or
   * without the `@` prefix, so a template can pull a partial out of a recipe.
   *
   * project/AGENTS.tpl.md contains {% render "~workflow/task-files/_partials/resume.md" %}.
   * After compile: the output holds "RESUME PARTIAL BODY".
   */
  it("should render a partial addressed by namespace", async () => {
    tmp = makeTmpDir("ns-render-");
    seedStore();
    const entry = write(
      "project/AGENTS.tpl.md",
      `{% render "~workflow/task-files/_partials/resume.md" %}`
    );
    const dest = at("out/AGENTS.md");

    const compiler = new CompilationService({ namespaceResolver: makeResolver() });
    const ok = await compiler.compile({
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain("RESUME PARTIAL BODY");
  });

  /**
   * A render path naming a recipe the project may not address reports the
   * namespace problem instead of a bare "file not found".
   */
  it("should explain a refused namespace in a {% render %} path", async () => {
    tmp = makeTmpDir("ns-render-");
    seedStore();
    const entry = write(
      "project/AGENTS.tpl.md",
      `{% render "~workflow/task-files/_partials/resume.md" %}`
    );
    const dest = at("out/AGENTS.md");

    const compiler = new CompilationService({
      namespaceResolver: makeResolver({ projectScope: ["core/sous-skills"] }),
    });

    const output = await compileCapturingLog(() =>
      compiler.compile({
        targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
      })
    );

    expect(output).toContain("Template rendering error");
    expect(output).toContain('This project does not subscribe to "workflow/task-files".');
  });
});
