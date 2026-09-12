import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import YAML from "yaml";
import { EXAMPLE_RECIPE_NAME, scaffoldRepo } from "./index.js";
import { parseIndexFile } from "../formats/index-file.js";
import { parseRecipeManifest } from "../formats/recipe-manifest.js";
import { parseRepoManifest } from "../formats/repo-manifest.js";
import { isConfigError } from "../../errors.js";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";

/** The version recorded in scaffolded indexes; any valid semver will do. */
const SOUS_VERSION = "0.1.1";

describe("scaffoldRepo()", () => {
  let tmp: TmpDir;
  let target: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-scaffold-");
    target = path.join(tmp.path, "my-recipes");
    fs.mkdirSync(target, { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * scaffoldRepo should write every file a new repository needs, and report
   * them in the order they were written.
   *
   * scaffoldRepo({ directory: "/tmp/my-recipes", sousVersion: "0.1.1" });
   * // -> writes sous.repo.yaml, sous.index.json, the example recipe, a README,
   * //    the release workflow and a .gitignore
   */
  it("should write every file a new repository needs", () => {
    const result = scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    for (const relative of result.files) {
      expect(fs.existsSync(path.join(target, relative))).toBe(true);
    }

    expect(result.files).toContain("sous.repo.yaml");
    expect(result.files).toContain("sous.index.json");
    expect(result.files).toContain("README.md");
    expect(result.files).toContain(".gitignore");
    expect(result.files).toContain(".github/workflows/sous-release.yml");
    expect(result.files).toContain(
      `recipes/my-recipes/${EXAMPLE_RECIPE_NAME}/sous.recipe.yaml`
    );
    expect(result.files).toContain(
      `recipes/my-recipes/${EXAMPLE_RECIPE_NAME}/skills/example-skill/SKILL.md`
    );
  });

  /**
   * Everything the scaffold writes should parse through the very schemas sous
   * uses to read a published repository. A scaffold sous cannot read would be
   * worse than no scaffold at all.
   */
  it("should write files that round-trip through the real parsers", () => {
    scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const manifestPath = path.join(target, "sous.repo.yaml");
    const manifest = parseRepoManifest(
      YAML.parse(fs.readFileSync(manifestPath, "utf8")),
      manifestPath
    );
    expect(manifest.name).toBe("my-recipes");
    expect(Object.keys(manifest.namespaces)).toEqual(["my-recipes"]);
    expect(manifest.recipes).toEqual([`recipes/my-recipes/${EXAMPLE_RECIPE_NAME}`]);

    const recipePath = path.join(target, manifest.recipes[0]!, "sous.recipe.yaml");
    const recipe = parseRecipeManifest(
      YAML.parse(fs.readFileSync(recipePath, "utf8")),
      recipePath
    );
    expect(recipe.namespace).toBe("my-recipes");
    expect(recipe.name).toBe(EXAMPLE_RECIPE_NAME);
    expect(recipe.version).toBe("0.1.0");
    expect(recipe.contents[0]!.kind).toBe("skills");

    const indexPath = path.join(target, "sous.index.json");
    const index = parseIndexFile(
      JSON.parse(fs.readFileSync(indexPath, "utf8")),
      indexPath
    );
    expect(index.name).toBe("my-recipes");
    expect(index.generator).toBe(SOUS_VERSION);
    expect(index.recipes).toEqual({});
    expect(Object.keys(index.namespaces)).toEqual(["my-recipes"]);
  });

  /**
   * The recipe manifest should carry the variables section as a commented-out
   * example, so an author sees the shape without the scaffold declaring a
   * variable nobody asked for.
   */
  it("should show the variables section as a commented example", () => {
    scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const text = fs.readFileSync(
      path.join(target, "recipes/my-recipes", EXAMPLE_RECIPE_NAME, "sous.recipe.yaml"),
      "utf8"
    );

    expect(text).toContain("# variables:");
    expect(text).toContain("#   - name: apiBaseUrl");
    // Commented out, so the parsed manifest declares no variables at all.
    const parsed = YAML.parse(text) as Record<string, unknown>;
    expect(parsed.variables).toBeUndefined();
  });

  /**
   * The release workflow should run the check on pull requests and the tagging
   * release on pushes to main, and should explain what each flag does.
   */
  it("should write a release workflow that checks pull requests and publishes merges", () => {
    scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    const workflow = fs.readFileSync(
      path.join(target, ".github/workflows/sous-release.yml"),
      "utf8"
    );

    expect(workflow).toContain("npx --yes @sous-io/sous repo release --check");
    expect(workflow).toContain("npx --yes @sous-io/sous repo release --ci --push --yes");
    expect(workflow).toContain("pull_request");
    expect(workflow).toContain("- main");
    // It parses as YAML, so GitHub can actually run it.
    expect(YAML.parse(workflow)).toBeTypeOf("object");
  });

  /**
   * scaffoldRepo should take the repository name from the directory when no
   * name is given, and should accept explicit name and namespace overrides.
   *
   * scaffoldRepo({ directory, name: "custom", namespace: "core" });
   * // -> recipes/core/example/sous.recipe.yaml, declaring namespace "core"
   */
  it("should honour explicit name and namespace overrides", () => {
    const result = scaffoldRepo({
      directory: target,
      name: "custom-name",
      namespace: "core",
      sousVersion: SOUS_VERSION,
    });

    expect(result.name).toBe("custom-name");
    expect(result.namespace).toBe("core");

    const manifestPath = path.join(target, "sous.repo.yaml");
    const manifest = parseRepoManifest(
      YAML.parse(fs.readFileSync(manifestPath, "utf8")),
      manifestPath
    );
    expect(manifest.name).toBe("custom-name");
    expect(Object.keys(manifest.namespaces)).toEqual(["core"]);
    expect(manifest.recipes).toEqual([`recipes/core/${EXAMPLE_RECIPE_NAME}`]);
  });

  /**
   * A directory whose own name is not kebab-case should be lower-cased where
   * that is enough, and rejected with an explanation where it is not.
   *
   * scaffoldRepo({ directory: ".../My-Recipes" }); // -> name "my-recipes"
   * scaffoldRepo({ directory: ".../my recipes" }); // throws ConfigError
   */
  it("should lower-case a usable directory name and reject an unusable one", () => {
    const upper = path.join(tmp.path, "My-Recipes");
    fs.mkdirSync(upper, { recursive: true });
    expect(scaffoldRepo({ directory: upper, sousVersion: SOUS_VERSION }).name).toBe(
      "my-recipes"
    );

    const spaced = path.join(tmp.path, "my recipes");
    fs.mkdirSync(spaced, { recursive: true });
    let caught: unknown;
    try {
      scaffoldRepo({ directory: spaced, sousVersion: SOUS_VERSION });
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("--name");
  });

  /**
   * scaffoldRepo should refuse to write over a directory that is already a
   * repository, and should say how to do it anyway.
   */
  it("should refuse to overwrite an existing repository without --force", () => {
    scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });

    let caught: unknown;
    try {
      scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain("--force");
  });

  /**
   * With force, scaffoldRepo should write over the existing repository, so a
   * half-edited scaffold can be reset deliberately.
   */
  it("should overwrite an existing repository when forced", () => {
    scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION });
    fs.writeFileSync(path.join(target, "README.md"), "edited\n", "utf8");

    scaffoldRepo({ directory: target, force: true, sousVersion: SOUS_VERSION });

    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).not.toBe("edited\n");
  });

  /**
   * A dry run should report exactly the files it would write and write none of
   * them.
   *
   * scaffoldRepo({ directory, dryRun: true }); // -> { dryRun: true, files: [...] }
   */
  it("should write nothing on a dry run", () => {
    const result = scaffoldRepo({
      directory: target,
      dryRun: true,
      sousVersion: SOUS_VERSION,
    });

    expect(result.dryRun).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  /**
   * The generated index should carry the timestamp it was given, so a caller
   * can make the output reproducible.
   */
  it("should record the given timestamp in the index", () => {
    const now = new Date("2026-09-09T14:03:11.482Z");
    scaffoldRepo({ directory: target, sousVersion: SOUS_VERSION, now });

    const index = JSON.parse(
      fs.readFileSync(path.join(target, "sous.index.json"), "utf8")
    ) as { generatedAt: string };
    expect(index.generatedAt).toBe("2026-09-09T14:03:11.482Z");
  });
});
