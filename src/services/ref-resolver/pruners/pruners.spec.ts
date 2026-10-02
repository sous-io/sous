import { describe, expect, it } from "vitest";
import { sharedRefResolver } from "../container.js";
import { formatRef } from "../format.js";
import { RefSource } from "../source.js";

const resolver = sharedRefResolver();

/** Every kind the place keeps for a ref, as `kind:canonical`. */
function kept(input: string, from: RefSource): string[] {
  return resolver.parse(input, from).refs.map((ref) => `${ref.kind}:${formatRef(ref)}`);
}

/** The refusal a place gives a ref, or undefined when it keeps something. */
function refusal(input: string, from: RefSource): string | undefined {
  try {
    resolver.parse(input, from);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("CommandLinePruner", () => {
  /**
   * The command line keeps every reading of a bare word, a variable path and
   * an environment variable name.
   *
   * parse("apiUrl") // -> repo, namespace, recipe, variable and envVar
   */
  it("should keep every kind a command may take", () => {
    expect(kept("apiUrl", RefSource.CommandLine)).toEqual([
      "repo:apiUrl",
      "namespace:apiUrl",
      "recipe:apiUrl",
      "variable:apiUrl",
      "envVar:apiUrl",
    ]);
  });

  /**
   * A glob and a file inside a recipe are refused.
   *
   * parse("a/b/c.md") // throws "copied from the browser"
   */
  it("should refuse a recipe file and a glob", () => {
    expect(refusal("a/b/c.md", RefSource.CommandLine)).toContain("copied from the browser");
    expect(refusal("wor*/x", RefSource.CommandLine)).toContain("glob pattern is not accepted");
  });

  /**
   * Query values are allowed on the command line.
   *
   * parse("workflow?x=1") // -> keeps vars
   */
  it("should allow query values", () => {
    expect(kept("workflow?x=1", RefSource.CommandLine)).toContain("namespace:workflow?x=1");
  });
});

describe("ConfigPruner and LockfilePruner", () => {
  /**
   * A stored key is a lowercase namespace or namespace/recipe, nothing else.
   *
   * parse("workflow/alpha", Config) // -> the recipe only
   */
  it("should keep only the stored form", () => {
    expect(kept("workflow/alpha", RefSource.Config)).toEqual(["recipe:workflow/alpha"]);
    expect(kept("workflow", RefSource.Lockfile)).toEqual(["namespace:workflow"]);
  });

  /**
   * Each refusal says what to write instead, and the config and lockfile
   * differ in how.
   *
   * parse("w/a?x=1", Config) // throws
   */
  it("should refuse what is attached to a key, in each place's words", () => {
    expect(refusal("w/a?x=1", RefSource.Config)).toContain("carries no query values");
    expect(refusal("w/a@^1", RefSource.Lockfile)).toContain("carries no version range");
    expect(refusal("w/a@^1", RefSource.Config)).toContain("'range' field");
    expect(refusal("r:w/a", RefSource.Lockfile)).toContain("never names a repository");
    expect(refusal("w/a/b.md", RefSource.Config)).toContain("kebab-case");
    expect(refusal("wor*", RefSource.Lockfile)).toContain("glob pattern is not a stored key");
    expect(refusal("a.md/b/c", RefSource.Lockfile)).toBeDefined();
  });
});

describe("ManifestPruner", () => {
  /**
   * A manifest lowercases names, accepts a range and a wildcard, and keeps a
   * browser URL for settling.
   *
   * parse("Workflow/Alpha@^1", Manifest) // -> workflow/alpha@^1
   */
  it("should keep what a dependency may be", () => {
    expect(kept("Workflow/Alpha@^1", RefSource.Manifest)).toEqual(["recipe:workflow/alpha@^1"]);
    expect(kept("workflow/*", RefSource.Manifest)).toEqual(["namespace:workflow"]);
    expect(kept("github://o/r/tree/main/x/y", RefSource.Manifest)).toEqual([
      "repo:github://o/r/tree/main/x/y",
    ]);
  });

  /**
   * A bare recipe name, a variable, a glob and query values are refused.
   *
   * parse("alpha@^1", Manifest) // throws "namespaces are not versioned"
   */
  it("should refuse what is not a namespace or a recipe", () => {
    expect(refusal("alpha@^1", RefSource.Manifest)).toContain("namespaces are not versioned");
    expect(refusal("w/a.apiUrl", RefSource.Manifest)).toContain("kebab-case");
    expect(refusal("w*/a", RefSource.Manifest)).toContain("kebab-case");
    expect(refusal("w/a?x=1", RefSource.Manifest)).toContain("carries no query values");
    expect(refusal("r:w/a", RefSource.Manifest)).toContain("only the consuming project knows");
    expect(refusal("github://o/r", RefSource.Manifest)).toContain(
      "Write 'github://o/r/namespace/recipe' instead."
    );
  });
});

describe("IncludePruner", () => {
  /**
   * An include line keeps a recipe file, glob and all.
   *
   * parse("w/a/**\/*.md", Include) // -> a recipeFile
   */
  it("should keep a recipe file", () => {
    expect(kept("w/a/**/*.md", RefSource.Include)).toEqual(["recipeFile:w/a/**/*.md"]);
  });

  /**
   * Everything else is refused, saying how an include is written.
   *
   * parse("w/a", Include) // throws
   */
  it("should refuse every other kind, a repository, a range and a path that climbs", () => {
    expect(refusal("w/a", RefSource.Include)).toContain("names a file inside a recipe");
    expect(refusal("r:w/a/f.md", RefSource.Include)).toContain("never through a repository's short name");
    expect(refusal("github://o/r/w/a/f.md", RefSource.Include)).toBeDefined();
    expect(refusal("w/a/f.md@^1", RefSource.Include)).toContain("takes no version range");
    expect(refusal("w/a/../f.md", RefSource.Include)).toContain("'.' or '..'");
    expect(refusal("w/a/./f.md", RefSource.Include)).toContain("'.' or '..'");
  });
});
