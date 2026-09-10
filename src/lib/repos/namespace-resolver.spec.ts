import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  StaticNamespaceResolver,
  formatNamespaceProblem,
  normalizeRef,
  type NamespaceResolution,
} from "./namespace-resolver.js";

const STORE = "/store/recipes";

/** A resolver holding two namespaces, with one recipe declaring a dependency on another. */
function makeResolver(overrides: {
  dependencies?: Record<string, string[]>;
  projectScope?: string[];
} = {}) {
  return new StaticNamespaceResolver({
    recipes: {
      "core/sous-skills": path.join(STORE, "core", "sous-skills"),
      "workflow/task-files": path.join(STORE, "workflow", "task-files"),
      "workflow/github-projects": path.join(STORE, "workflow", "github-projects"),
    },
    dependencies: overrides.dependencies,
    projectScope: overrides.projectScope,
  });
}

describe("StaticNamespaceResolver", () => {
  /**
   * A project template (a file outside every recipe directory) addressing a
   * known recipe gets the file's absolute path inside that recipe's directory.
   *
   * resolve({ namespace: "workflow", rest: "task-files/_partials/resume.md",
   *           fromFile: "/project/prompts/AGENTS.md" })
   * // -> { kind: "candidates",
   * //      candidates: ["/store/recipes/workflow/task-files/_partials/resume.md"] }
   */
  it("should map a namespace reference to a path inside the recipe directory", () => {
    const result = makeResolver().resolve({
      namespace: "workflow",
      rest: "task-files/_partials/resume.md",
      fromFile: "/project/prompts/AGENTS.md",
    });

    expect(result).toEqual({
      kind: "candidates",
      candidates: [path.join(STORE, "workflow", "task-files", "_partials", "resume.md")],
    });
  });

  /**
   * A namespace nobody declared is reported as unknown, together with the sorted
   * list of namespaces that do exist, so the error can name the alternatives.
   *
   * resolve({ namespace: "nope", ... })
   * // -> { kind: "unknown-namespace", known: ["core", "workflow"] }
   */
  it("should report an unknown namespace and list the known ones", () => {
    const result = makeResolver().resolve({
      namespace: "nope",
      rest: "thing/file.md",
      fromFile: "/project/prompts/AGENTS.md",
    });

    expect(result).toEqual({ kind: "unknown-namespace", known: ["core", "workflow"] });
  });

  /**
   * A known namespace that holds no such recipe is reported separately from an
   * unknown namespace, listing the recipes it does hold.
   *
   * resolve({ namespace: "workflow", rest: "missing/file.md", ... })
   * // -> { kind: "unknown-recipe", recipe: "workflow/missing",
   * //      known: ["workflow/github-projects", "workflow/task-files"] }
   */
  it("should report an unknown recipe inside a known namespace", () => {
    const result = makeResolver().resolve({
      namespace: "workflow",
      rest: "missing/file.md",
      fromFile: "/project/prompts/AGENTS.md",
    });

    expect(result).toEqual({
      kind: "unknown-recipe",
      recipe: "workflow/missing",
      known: ["workflow/github-projects", "workflow/task-files"],
    });
  });

  /**
   * A file inside a recipe directory may address the recipes that recipe
   * declares, and nothing else. The including recipe is identified by which
   * recipe directory contains the file.
   *
   * core/sous-skills declares workflow/task-files, so its own files resolve
   * "~workflow/task-files/..." but not "~workflow/github-projects/...".
   */
  it("should allow a recipe to address a declared dependency", () => {
    const resolver = makeResolver({
      dependencies: { "core/sous-skills": ["workflow/task-files"] },
    });

    const result = resolver.resolve({
      namespace: "workflow",
      rest: "task-files/partial.md",
      fromFile: path.join(STORE, "core", "sous-skills", "SKILL.md"),
    });

    expect(result).toEqual({
      kind: "candidates",
      candidates: [path.join(STORE, "workflow", "task-files", "partial.md")],
    });
  });

  /**
   * The same recipe asking for a recipe it does NOT declare gets the specific
   * not-a-dependency answer, naming both recipes so the message can say which
   * manifest to edit.
   */
  it("should refuse a recipe the including recipe does not declare", () => {
    const resolver = makeResolver({
      dependencies: { "core/sous-skills": ["workflow/task-files"] },
    });

    const result = resolver.resolve({
      namespace: "workflow",
      rest: "github-projects/partial.md",
      fromFile: path.join(STORE, "core", "sous-skills", "SKILL.md"),
    });

    expect(result).toEqual({
      kind: "not-a-dependency",
      recipe: "workflow/github-projects",
      includingRecipe: "core/sous-skills",
    });
  });

  /**
   * Declaring a bare namespace covers every recipe in it, matching the design
   * rule that depending on a namespace makes the whole namespace addressable.
   */
  it("should accept a dependency declared as a bare namespace", () => {
    const resolver = makeResolver({ dependencies: { "core/sous-skills": ["workflow"] } });

    const result = resolver.resolve({
      namespace: "workflow",
      rest: "github-projects/partial.md",
      fromFile: path.join(STORE, "core", "sous-skills", "SKILL.md"),
    });

    expect(result.kind).toBe("candidates");
  });

  /**
   * A declared reference may carry a repository qualifier and a version range;
   * both are decoration around the same recipe ref and are ignored when
   * matching.
   *
   * "sous-public:workflow/task-files@^1.2" matches "workflow/task-files".
   */
  it("should match a dependency written with a repo qualifier and a version range", () => {
    const resolver = makeResolver({
      dependencies: { "core/sous-skills": ["sous-public:workflow/task-files@^1.2"] },
    });

    const result = resolver.resolve({
      namespace: "workflow",
      rest: "task-files/partial.md",
      fromFile: path.join(STORE, "core", "sous-skills", "SKILL.md"),
    });

    expect(result.kind).toBe("candidates");
  });

  /**
   * A recipe always addresses itself, with no declaration needed, since its own
   * files are trivially in scope.
   */
  it("should let a recipe address itself without declaring a dependency", () => {
    const resolver = makeResolver({ dependencies: {} });

    const result = resolver.resolve({
      namespace: "workflow",
      rest: "task-files/_partials/x.md",
      fromFile: path.join(STORE, "workflow", "task-files", "SKILL.md"),
    });

    expect(result.kind).toBe("candidates");
  });

  /**
   * With a project scope configured, a project template may address only the
   * project's subscriptions; the answer carries a null includingRecipe because
   * the including file belongs to no recipe.
   */
  it("should refuse a recipe the project does not subscribe to", () => {
    const resolver = makeResolver({ projectScope: ["core/sous-skills"] });

    const result = resolver.resolve({
      namespace: "workflow",
      rest: "task-files/partial.md",
      fromFile: "/project/prompts/AGENTS.md",
    });

    expect(result).toEqual({
      kind: "not-a-dependency",
      recipe: "workflow/task-files",
      includingRecipe: null,
    });
  });
});

describe("normalizeRef()", () => {
  /**
   * normalizeRef strips a leading repository qualifier and a trailing version
   * range, leaving the bare namespace or namespace/recipe form.
   *
   * normalizeRef("sous-public:misc/stuff@^1.2"); // -> "misc/stuff"
   */
  it("should strip a repo qualifier and a version range", () => {
    expect(normalizeRef("sous-public:misc/stuff@^1.2")).toBe("misc/stuff");
    expect(normalizeRef("misc/stuff")).toBe("misc/stuff");
    expect(normalizeRef("misc")).toBe("misc");
  });
});

describe("formatNamespaceProblem()", () => {
  const base = {
    namespace: "workflow",
    rest: "task-files/x.md",
    fromFile: "/project/prompts/AGENTS.md",
  };

  /**
   * An unknown namespace produces lines naming the including file, the
   * namespace, and the namespaces that do exist. Every line is indented by two
   * spaces so it slots into the compiler's error block.
   */
  it("should explain an unknown namespace and list the available ones", () => {
    const text = formatNamespaceProblem({
      ...base,
      resolution: { kind: "unknown-namespace", known: ["core", "workflow"] },
    });

    expect(text).toContain("  in file: /project/prompts/AGENTS.md");
    expect(text).toContain("  namespace: workflow");
    expect(text).toContain('There is no recipe namespace named "workflow" available here.');
    expect(text).toContain("Available namespaces: core, workflow.");
  });

  /**
   * A not-a-dependency answer from inside a recipe tells the author which
   * manifest to edit.
   */
  it("should tell a recipe author to declare the dependency", () => {
    const text = formatNamespaceProblem({
      ...base,
      resolution: {
        kind: "not-a-dependency",
        recipe: "workflow/task-files",
        includingRecipe: "core/sous-skills",
      },
    });

    expect(text).toContain(
      'The recipe "core/sous-skills" does not declare "workflow/task-files" as a dependency.'
    );
    expect(text).toContain('Add "workflow/task-files" to the "depends" list');
  });

  /**
   * The same answer from a project template talks about subscribing instead,
   * since a project has no manifest to edit.
   */
  it("should tell a project to subscribe when no recipe is including", () => {
    const text = formatNamespaceProblem({
      ...base,
      resolution: {
        kind: "not-a-dependency",
        recipe: "workflow/task-files",
        includingRecipe: null,
      },
    });

    expect(text).toContain('This project does not subscribe to "workflow/task-files".');
  });

  /**
   * A successful resolution has nothing to explain, so the formatter returns an
   * empty string rather than a stray block of text.
   */
  it("should return an empty string for a successful resolution", () => {
    const resolution: NamespaceResolution = { kind: "candidates", candidates: ["/x/y.md"] };
    expect(formatNamespaceProblem({ ...base, resolution })).toBe("");
  });
});
