import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompilationService } from "../../lib/markdown-compiler.js";
import { resolveAliases, type Settings } from "../../lib/settings.js";
import { StaticNamespaceResolver } from "../../lib/repos/namespace-resolver.js";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

/**
 * Integration coverage for the include pipeline through the real
 * CompilationService: globs, a file included more than once, cycles, malformed
 * include lines, the `#` sigil and recipe references that go through the ref
 * resolver service.
 */
describe("include globs and the # sigil (real compile path)", () => {
  let tmp: TmpDir;
  afterEach(() => {
    tmp?.cleanup();
    vi.restoreAllMocks();
  });

  /** Write a file relative to the temp dir, creating parent directories. */
  function write(rel: string, content: string): string {
    const abs = path.join(tmp.path, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  /** Absolute path inside the temp dir. */
  const at = (rel: string): string => path.join(tmp.path, rel);

  /** Strip ANSI escape codes. */
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  /** Compile one entry and return whether it passed, the output and everything printed. */
  async function compileEntry(
    entry: string,
    options: {
      resolver?: StaticNamespaceResolver;
      aliases?: Record<string, string[]>;
      includeScope?: Record<string, string>;
    } = {}
  ): Promise<{ ok: boolean; output: string; log: string }> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(strip(args.map(String).join(" ")));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(strip(args.map(String).join(" ")));
    });
    const dest = at("out/OUT.md");
    const compiler = new CompilationService(
      options.resolver === undefined ? {} : { namespaceResolver: options.resolver }
    );
    const ok = await compiler.compile({
      ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
      ...(options.includeScope === undefined ? {} : { includeScope: options.includeScope }),
      targets: [{ rootInputPath: entry, outputs: [{ destinationFile: dest, vars: {} }] }],
    });
    vi.restoreAllMocks();
    return {
      ok,
      output: fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "",
      log: lines.join("\n"),
    };
  }

  /** Two recipes, each with memories, one library with none. */
  function seedRecipes(): StaticNamespaceResolver {
    write("store/alpha/one/memories/a.md", "ONE-A");
    write("store/alpha/one/memories/b.md", "ONE-B");
    write("store/alpha/one/other/c.md", "ONE-C");
    write("store/beta/two/memories/z.md", "TWO-Z");
    write("store/beta/lib/readme.md", "LIB-README");
    return new StaticNamespaceResolver({
      recipes: {
        "alpha/one": at("store/alpha/one"),
        "beta/two": at("store/beta/two"),
        "beta/lib": at("store/beta/lib"),
      },
      repos: { "alpha/one": "main-repo", "beta/two": "main-repo", "beta/lib": "other-repo" },
      dependencies: { "alpha/one": ["beta/lib"] },
    });
  }

  // -------------------------------------------------------------------------
  // Globs
  // -------------------------------------------------------------------------

  /**
   * A glob over relative files includes every match in sorted path order, each
   * expanded as a single include would be.
   *
   * "@parts/*.md" with parts/b.md, parts/a.md, parts/c.md
   * // -> A, B, C in that order
   */
  it("should include every file a relative glob matches in sorted order", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/parts/b.md", "BBB");
    write("p/parts/a.md", "AAA");
    write("p/parts/c.md", "CCC");
    write("p/parts/skip.txt", "NOPE");
    const entry = write("p/ENTRY.md", "top\n\n@parts/*.md\n");

    const { ok, output } = await compileEntry(entry);

    expect(ok).toBe(true);
    expect(output.indexOf("AAA")).toBeLessThan(output.indexOf("BBB"));
    expect(output.indexOf("BBB")).toBeLessThan(output.indexOf("CCC"));
    expect(output).not.toContain("NOPE");
  });

  /**
   * An included file's own include lines expand when it is reached through a
   * glob, exactly as through a single include.
   */
  it("should expand include lines inside files a glob reaches", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/parts/a.md", "AAA\n@../deep/x.md\n");
    write("p/deep/x.md", "DEEP");
    const entry = write("p/ENTRY.md", "@parts/**/*.md\n");

    const { ok, output } = await compileEntry(entry);

    expect(ok).toBe(true);
    expect(output).toContain("AAA");
    expect(output).toContain("DEEP");
  });

  /**
   * A glob over recipes reaches the same folder in every pinned recipe.
   *
   * "@~*\/*\/memories/*.md" // -> memories of alpha/one and beta/two, not the library's readme
   */
  it("should include a folder from every recipe a recipe glob matches", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    const entry = write("project/ENTRY.md", "@~*/*/memories/*.md\n");

    const { ok, output } = await compileEntry(entry, { resolver });

    expect(ok).toBe(true);
    expect(output.indexOf("ONE-A")).toBeLessThan(output.indexOf("ONE-B"));
    expect(output.indexOf("ONE-B")).toBeLessThan(output.indexOf("TWO-Z"));
    expect(output).not.toContain("LIB-README");
    expect(output).not.toContain("ONE-C");
  });

  /**
   * A glob inside a recipe's own file reaches only that recipe and the recipes
   * it declares, never every pinned recipe.
   */
  it("should limit a recipe glob inside a recipe to its declared dependencies", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    write("store/alpha/one/SKILL.md", "@~*/*/readme.md\n");

    const { ok, output } = await compileEntry(at("store/alpha/one/SKILL.md"), { resolver });

    expect(ok).toBe(true);
    expect(output).toContain("LIB-README");
    expect(output).not.toContain("TWO-Z");
  });

  /**
   * A glob that matches nothing is a build error naming the pattern.
   *
   * "@missing/*.md" // -> the build fails and says the include matched no files
   */
  it("should fail the build when a glob matches nothing", async () => {
    tmp = makeTmpDir("inc-glob-");
    const entry = write("p/ENTRY.md", "@missing/*.md\n");

    const { ok, log } = await compileEntry(entry);

    expect(ok).toBe(false);
    expect(log).toContain("Include matched no files: @missing/*.md");
  });

  /** The same holds for a recipe glob that matches no recipe. */
  it("should fail the build when a recipe glob matches nothing", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    const entry = write("project/ENTRY.md", "@~*/*/nothing-here/*.md\n");

    const { ok, log } = await compileEntry(entry, { resolver });

    expect(ok).toBe(false);
    expect(log).toContain("Include matched no files");
  });

  // -------------------------------------------------------------------------
  // Included more than once, cycles
  // -------------------------------------------------------------------------

  /**
   * A file may be included in more than one place, and appears each time.
   *
   * "@shared.md" twice // -> SHARED appears twice
   */
  it("should include the same file twice", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/shared.md", "SHARED");
    const entry = write("p/ENTRY.md", "@shared.md\n\nmiddle\n\n@shared.md\n");

    const { ok, output } = await compileEntry(entry);

    expect(ok).toBe(true);
    expect(output.match(/SHARED/g)).toHaveLength(2);
  });

  /** A glob includes a file even when a plain include already did. */
  it("should include a file a glob matches even when it was already included", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/parts/a.md", "AAA");
    const entry = write("p/ENTRY.md", "@parts/a.md\n\n@parts/*.md\n");

    const { output } = await compileEntry(entry);

    expect(output.match(/AAA/g)).toHaveLength(2);
  });

  /**
   * A file that includes itself, directly or through another, is still an
   * error.
   *
   * a.md includes b.md which includes a.md // -> "Circular dependency detected"
   */
  it("should still catch a cycle", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/a.md", "A\n@b.md\n");
    write("p/b.md", "B\n@a.md\n");
    const entry = write("p/ENTRY.md", "@a.md\n");

    const { ok, log } = await compileEntry(entry);

    expect(ok).toBe(false);
    expect(log).toContain("Circular dependency detected");
  });

  /** A glob that matches the including file itself is a cycle too. */
  it("should catch a glob that matches the file including it", async () => {
    tmp = makeTmpDir("inc-glob-");
    const entry = write("p/parts/ENTRY.md", "@*.md\n");

    const { ok, log } = await compileEntry(entry);

    expect(ok).toBe(false);
    expect(log).toContain("Circular dependency detected");
  });

  // -------------------------------------------------------------------------
  // Malformed include lines
  // -------------------------------------------------------------------------

  /**
   * A line that starts with `@` and looks like an include but is not one is a
   * build error naming the file and the line.
   *
   * "@docs/notes.txt" // -> error, "Malformed include line", line 3
   */
  it("should fail the build on a malformed include line", async () => {
    tmp = makeTmpDir("inc-glob-");
    const entry = write("p/ENTRY.md", "top\n\n@docs/notes.txt\n");

    const { ok, log, output } = await compileEntry(entry);

    expect(ok).toBe(false);
    expect(output).toBe("");
    expect(log).toContain("Malformed include line: @docs/notes.txt");
    expect(log).toContain("line 3");
    expect(log).toContain("ENTRY.md");
  });

  /** A malformed line inside an included file names that file. */
  it("should name the included file of a malformed include line", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/inner.md", "ok\n@~/bad path.md\n@broken/\n");
    const entry = write("p/ENTRY.md", "@inner.md\n");

    const { ok, log } = await compileEntry(entry);

    expect(ok).toBe(false);
    expect(log).toContain("inner.md, line 3");
  });

  /**
   * Ordinary prose that merely starts with `@` passes through as text: a mention
   * or an email address followed by words, and a lone mention.
   */
  it("should pass a prose line that starts with @ through as text", async () => {
    tmp = makeTmpDir("inc-glob-");
    const entry = write(
      "p/ENTRY.md",
      "@alice thanks for the review\n\n@alice\n\n@bob,\n\n@docs and @more words/with a slash\n"
    );

    const { ok, output } = await compileEntry(entry);

    expect(ok).toBe(true);
    expect(output).toContain("@alice thanks for the review");
    expect(output).toContain("@alice\n");
    expect(output).toContain("@bob,");
    expect(output).toContain("@docs and @more words/with a slash");
  });

  /** A malformed-looking line inside a fenced code block is left alone. */
  it("should leave a malformed-looking line inside a fence alone", async () => {
    tmp = makeTmpDir("inc-glob-");
    const entry = write("p/ENTRY.md", "```\n@docs/notes.txt\n```\n");

    const { ok, output } = await compileEntry(entry);

    expect(ok).toBe(true);
    expect(output).toContain("@docs/notes.txt");
  });

  /** A `?name=value` query on an include line is accepted and does not change the file found. */
  it("should accept a query on an include line", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("p/part.md", "PART");
    const entry = write("p/ENTRY.md", "@part.md?mood=calm\n");

    const { ok, output } = await compileEntry(entry);

    expect(ok).toBe(true);
    expect(output).toContain("PART");
  });

  // -------------------------------------------------------------------------
  // The # sigil
  // -------------------------------------------------------------------------

  /**
   * `#project` is the project root.
   *
   * "@#project/notes/a.md" // -> the file under the project root
   */
  it("should resolve a #project include", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("root/notes/a.md", "ROOT NOTE");
    const entry = write("elsewhere/ENTRY.md", "@#project/notes/a.md\n");

    const { ok, output } = await compileEntry(entry, {
      aliases: { "#project": [at("root")] },
    });

    expect(ok).toBe(true);
    expect(output).toContain("ROOT NOTE");
  });

  /** A glob works under `#project` too. */
  it("should resolve a glob under #project", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("root/notes/a.md", "NOTE-A");
    write("root/notes/b.md", "NOTE-B");
    const entry = write("elsewhere/ENTRY.md", "@#project/notes/*.md\n");

    const { output } = await compileEntry(entry, { aliases: { "#project": [at("root")] } });

    expect(output).toContain("NOTE-A");
    expect(output).toContain("NOTE-B");
  });

  /**
   * `@~project/...` no longer means the project root: it is a recipe namespace
   * named "project", which does not exist here.
   */
  it("should no longer treat ~project as the project root", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("root/notes/a.md", "ROOT NOTE");
    const resolver = seedRecipes();
    const entry = write("project/ENTRY.md", "@~project/notes/a.md\n");

    const { ok, log, output } = await compileEntry(entry, {
      resolver,
      aliases: { "#project": [at("root")] },
    });

    expect(ok).toBe(false);
    expect(output).not.toContain("ROOT NOTE");
    expect(log).toContain('no recipe namespace named "project"');
  });

  /** A `#` name nothing registered says which names exist. */
  it("should explain an unknown # name", async () => {
    tmp = makeTmpDir("inc-glob-");
    const entry = write("p/ENTRY.md", "@#nope/x.md\n");

    const { ok, log } = await compileEntry(entry, { aliases: { "#project": [at("root")] } });

    expect(ok).toBe(false);
    expect(log).toContain('There is no built-in name "#nope"');
  });

  /** `{% render "#project/x.md" %}` resolves through the same names. */
  it("should render a partial named by #project", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("root/x.md", "RENDERED FROM ROOT");
    const entry = write("p/ENTRY.tpl.md", `{% render "#project/x.md" %}`);

    const { ok, output } = await compileEntry(entry, { aliases: { "#project": [at("root")] } });

    expect(ok).toBe(true);
    expect(output).toContain("RENDERED FROM ROOT");
  });

  /** A user alias may not start with `~` or `#`; it is a ConfigError. */
  it("should refuse a user alias that starts with # or ~", () => {
    const settings = { _aliases: { "#x": "/somewhere" } } as unknown as Settings;
    expect(() => resolveAliases(settings, { projectRoot: "/p" })).toThrow(/reserved/);
    const tilde = { _aliases: { "~y": "/somewhere" } } as unknown as Settings;
    expect(() => resolveAliases(tilde, { projectRoot: "/p" })).toThrow(/reserved/);
    const fine = { _aliases: { docs: "/docs" } } as unknown as Settings;
    expect(resolveAliases(fine, { projectRoot: "/p" })).toEqual({
      "#project": ["/p"],
      docs: ["/docs"],
    });
  });

  // -------------------------------------------------------------------------
  // Recipe references through the ref service
  // -------------------------------------------------------------------------

  /**
   * A `repo:` qualifier names the repository by its short name, and a name in
   * a different case still resolves to the known recipe.
   *
   * "@~main-repo:Alpha/One/memories/a.md" // -> alpha/one's memories/a.md
   */
  it("should resolve a repo-qualified, differently cased recipe reference", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    const entry = write("project/ENTRY.md", "@~main-repo:Alpha/One/memories/a.md\n");

    const { ok, output } = await compileEntry(entry, { resolver });

    expect(ok).toBe(true);
    expect(output).toContain("ONE-A");
  });

  /** A qualifier naming a repository the recipe does not come from finds nothing. */
  it("should not find a recipe through the wrong repository qualifier", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    const entry = write("project/ENTRY.md", "@~other-repo:alpha/one/memories/a.md\n");

    const { ok, log } = await compileEntry(entry, { resolver });

    expect(ok).toBe(false);
    expect(log).toContain("Include not found");
  });

  /** An exact spelling wins over a case-insensitive one when both exist. */
  it("should prefer the exact spelling of a recipe name", async () => {
    tmp = makeTmpDir("inc-glob-");
    write("store/alpha/thing/f.md", "LOWER");
    write("store/alpha/Thing/f.md", "UPPER");
    const resolver = new StaticNamespaceResolver({
      recipes: { "alpha/thing": at("store/alpha/thing") },
    });
    const entry = write("project/ENTRY.md", "@~alpha/thing/f.md\n");

    const { output } = await compileEntry(entry, { resolver });

    expect(output).toContain("LOWER");
  });

  /** A reference that an include line may not hold says how to write it. */
  it("should explain a recipe reference with a version range", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    const entry = write("project/ENTRY.md", "@~alpha/one/memories/a.md@^1\n");

    const { ok } = await compileEntry(entry, { resolver });

    expect(ok).toBe(false);
  });

  /**
   * The scoping rules hold: a recipe's file reaching a recipe it does not
   * declare is an error naming the missing declaration.
   */
  it("should keep the not-a-dependency rule", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    write("store/alpha/one/SKILL.md", "@~beta/two/memories/z.md\n");

    const { ok, log } = await compileEntry(at("store/alpha/one/SKILL.md"), { resolver });

    expect(ok).toBe(false);
    expect(log).toContain('does not declare "beta/two"');
  });

  /** The escape protection holds: `..` in the path never leaves the recipe. */
  it("should keep the escape protection", async () => {
    tmp = makeTmpDir("inc-glob-");
    const resolver = seedRecipes();
    write("store/secret.md", "SECRET");
    const entry = write("project/ENTRY.md", "@~alpha/one/../../secret.md\n");

    const { ok, log, output } = await compileEntry(entry, { resolver });

    expect(ok).toBe(false);
    expect(output).not.toContain("SECRET");
    expect(log).toContain("points outside the recipe");
  });
});
