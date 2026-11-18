import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, type TmpDir } from "../test/tmp.js";
import {
  findManifest,
  findRecipeManifest,
  findRepoManifest,
  loadJsonFile,
  loadManifestFile,
  parseJsoncText,
  parseYamlText,
  requireRecipeManifest,
  requireRepoManifest,
  createManifests,
} from "./manifests.js";
import { isConfigError } from "../test/errors.js";

/**
 * Unit tests for reading Repositories files off disk. These use a real
 * temporary directory rather than memfs, matching the dominant pattern in this
 * project and keeping real path behavior in play.
 */

let tmp: TmpDir;

beforeEach(() => {
  tmp = makeTmpDir("sous-repos-loader-");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes a file into the temp directory and returns its absolute path. */
function write(name: string, contents: string): string {
  const filePath = path.join(tmp.path, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Runs a function and returns the ConfigError message it throws, or fails. */
function expectRejectMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected the call to throw, but it returned");
}

describe("loadManifestFile()", () => {
  /**
   * A `.yaml` manifest is parsed as YAML.
   *
   * loadManifestFile("/repo/sous.repo.yaml");
   * // -> { formatVersion: 1, name: "sous-recipes" }
   */
  it("should parse a .yaml manifest as YAML", () => {
    const file = write(
      "sous.repo.yaml",
      "formatVersion: 1\nname: sous-recipes\nnamespaces:\n  core: {}\nrecipes:\n  - recipes/core/sous-skills\n"
    );
    expect(loadManifestFile(file)).toEqual({
      formatVersion: 1,
      name: "sous-recipes",
      namespaces: { core: {} },
      recipes: ["recipes/core/sous-skills"],
    });
  });

  /**
   * `.yml` is the same format under the other spelling.
   */
  it("should parse a .yml manifest as YAML", () => {
    const file = write("sous.recipe.yml", "formatVersion: 1\nname: task-files\n");
    expect(loadManifestFile(file)).toEqual({ formatVersion: 1, name: "task-files" });
  });

  /**
   * A `.json` manifest is parsed as plain JSON when it contains no extras.
   */
  it("should parse a plain .json manifest", () => {
    const file = write("sous.repo.json", '{ "formatVersion": 1, "name": "sous-recipes" }');
    expect(loadManifestFile(file)).toEqual({ formatVersion: 1, name: "sous-recipes" });
  });

  /**
   * Hand-written JSON manifests may carry line comments, block comments and
   * trailing commas, so a manifest can explain itself.
   *
   * loadManifestFile("/repo/sous.repo.json");
   * // -> { formatVersion: 1, name: "sous-recipes", recipes: ["a"] }
   */
  it("should parse a .json manifest with comments and trailing commas", () => {
    const file = write(
      "sous.repo.json",
      [
        "{",
        "  // the only format version sous understands",
        '  "formatVersion": 1,',
        "  /* the suggested short name */",
        '  "name": "sous-recipes",',
        '  "recipes": [',
        '    "recipes/core/sous-skills",',
        "  ],",
        "}",
      ].join("\n")
    );
    expect(loadManifestFile(file)).toEqual({
      formatVersion: 1,
      name: "sous-recipes",
      recipes: ["recipes/core/sous-skills"],
    });
  });

  /**
   * A `//` sequence inside a string is data, not a comment, so a URL survives
   * the permissive parse intact.
   */
  it("should not treat a URL inside a string as a comment", () => {
    const file = write(
      "sous.repo.json",
      '{ "contribute": "https://github.com/sous-io/sous-recipes" }'
    );
    expect(loadManifestFile(file)).toEqual({
      contribute: "https://github.com/sous-io/sous-recipes",
    });
  });

  /**
   * A missing file is reported as a ConfigError naming the path, not as a raw
   * filesystem error.
   */
  it("should report a missing file with a ConfigError", () => {
    const missing = path.join(tmp.path, "sous.repo.yaml");
    expect(expectRejectMessage(() => loadManifestFile(missing))).toContain(
      `The manifest at ${missing} does not exist`
    );
  });

  /**
   * Broken YAML is reported with the parser's own message and the file path.
   */
  it("should report broken YAML with the file path", () => {
    const file = write("sous.repo.yaml", "formatVersion: 1\n  bad: [indent\n");
    const message = expectRejectMessage(() => loadManifestFile(file));
    expect(message).toContain(`Could not parse ${file} as YAML`);
  });

  /**
   * Broken JSON is reported with a line and column, and a reminder of what the
   * permissive dialect does allow.
   */
  it("should report broken JSON with a line and column", () => {
    const file = write("sous.repo.json", '{\n  "name": "sous-recipes"\n  "extra": 1\n}');
    const message = expectRejectMessage(() => loadManifestFile(file));
    expect(message).toContain(`Could not parse ${file} as JSON`);
    expect(message).toContain("line 3, column 3");
    expect(message).toContain("Comments and trailing commas are allowed");
  });

  /**
   * A manifest is never JavaScript. The rejection says why, since the reason
   * (a manifest is data, readable without executing anything) is not an
   * arbitrary limitation.
   */
  it("should refuse a JavaScript manifest and say why", () => {
    const file = write("sous.repo.js", "export const config = {};");
    const message = expectRejectMessage(() => loadManifestFile(file));
    expect(message).toContain("'.js' is not a manifest format");
    expect(message).toContain("without executing anything");
  });
});

describe("parseJsoncText() and parseYamlText()", () => {
  /**
   * The text parsers are exported for callers that already hold the contents,
   * such as a provider that fetched a manifest over the network.
   *
   * parseJsoncText('{ "a": 1, }', "<remote>");  // -> { a: 1 }
   */
  it("should parse text without touching the filesystem", () => {
    expect(parseJsoncText('{ "a": 1, }', "<remote>")).toEqual({ a: 1 });
    expect(parseYamlText("a: 1\n", "<remote>")).toEqual({ a: 1 });
  });

  /**
   * Both name the label they were given, so a remote source is identifiable in
   * the error.
   */
  it("should name the given source label in errors", () => {
    expect(expectRejectMessage(() => parseJsoncText("{", "<remote index>"))).toContain(
      "<remote index>"
    );
    expect(expectRejectMessage(() => parseYamlText("a: [\n", "<remote index>"))).toContain(
      "<remote index>"
    );
  });
});

describe("loadJsonFile()", () => {
  /**
   * Machine-written files are strict JSON.
   *
   * loadJsonFile("/project/.sous/sous.lock.json", "lockfile");  // -> the parsed object
   */
  it("should parse a machine-written JSON file", () => {
    const file = write("sous.lock.json", '{ "formatVersion": 1 }');
    expect(loadJsonFile(file, "lockfile")).toEqual({ formatVersion: 1 });
  });

  /**
   * A comment is not tolerated in a machine-written file, and the message says
   * the file is written by sous and suggests restoring it.
   */
  it("should reject a comment in a machine-written file", () => {
    const file = write("sous.lock.json", '{\n  // hand edited\n  "formatVersion": 1\n}');
    const message = expectRejectMessage(() => loadJsonFile(file, "lockfile"));
    expect(message).toContain(`Could not parse the lockfile at ${file} as JSON`);
    expect(message).toContain("restoring it from version control");
  });

  /**
   * A missing machine-written file is reported with the label it was given.
   */
  it("should report a missing file using its label", () => {
    const missing = path.join(tmp.path, "sous.index.json");
    expect(expectRejectMessage(() => loadJsonFile(missing, "repo index"))).toContain(
      `The repo index at ${missing} does not exist`
    );
  });
});

describe("findRepoManifest() and findRecipeManifest()", () => {
  /**
   * Each finder returns the single manifest with its base name, whichever
   * supported extension it uses.
   *
   * findRepoManifest("/repo");  // -> "/repo/sous.repo.yaml"
   */
  it("should find a manifest under any supported extension", () => {
    const yaml = write("sous.repo.yaml", "formatVersion: 1\n");
    expect(findRepoManifest(tmp.path)).toBe(yaml);
    fs.rmSync(yaml);

    const json = write("sous.repo.json", "{}");
    expect(findRepoManifest(tmp.path)).toBe(json);
    fs.rmSync(json);

    const yml = write("sous.recipe.yml", "formatVersion: 1\n");
    expect(findRecipeManifest(tmp.path)).toBe(yml);
  });

  /**
   * A directory with no manifest returns undefined rather than throwing, so a
   * caller can decide whether that is a problem.
   *
   * findRepoManifest("/empty");  // -> undefined
   */
  it("should return undefined when there is no manifest", () => {
    expect(findRepoManifest(tmp.path)).toBeUndefined();
    expect(findRecipeManifest(tmp.path)).toBeUndefined();
  });

  /**
   * A missing directory is not an error either; there is simply no manifest in
   * it.
   */
  it("should return undefined for a directory that does not exist", () => {
    expect(findRepoManifest(path.join(tmp.path, "nowhere"))).toBeUndefined();
  });

  /**
   * Two manifests in one directory is a hard error rather than a silent
   * first-match-win, mirroring how sous treats two primary configs in one
   * `.sous/` directory.
   */
  it("should reject more than one manifest in a directory", () => {
    write("sous.repo.yaml", "formatVersion: 1\n");
    write("sous.repo.json", "{}");
    const message = expectRejectMessage(() => findRepoManifest(tmp.path));
    expect(message).toContain("Found more than one repo manifest");
    expect(message).toContain("sous.repo.yaml, sous.repo.json");
    expect(message).toContain("exactly one repo manifest");
  });

  /**
   * A directory named like a manifest is not a manifest.
   */
  it("should ignore a directory that shares the manifest name", () => {
    fs.mkdirSync(path.join(tmp.path, "sous.repo.yaml"));
    expect(findRepoManifest(tmp.path)).toBeUndefined();
  });

  /**
   * The generic finder is exported so later phases can look for other manifest
   * base names without reimplementing the exactly-one rule.
   *
   * findManifest("/repo", "sous.repo", "repo manifest");  // -> "/repo/sous.repo.yaml"
   */
  it("should expose the generic finder", () => {
    const file = write("sous.repo.yaml", "formatVersion: 1\n");
    expect(findManifest(tmp.path, "sous.repo", "repo manifest")).toBe(file);
  });
});

describe("requireRepoManifest() and requireRecipeManifest()", () => {
  /**
   * The requiring forms return the path when a manifest exists.
   */
  it("should return the manifest path when one exists", () => {
    const file = write("sous.repo.yaml", "formatVersion: 1\n");
    expect(requireRepoManifest(tmp.path)).toBe(file);
  });

  /**
   * When none exists they raise a ConfigError that names the directory and the
   * file sous was looking for.
   */
  it("should raise a ConfigError naming the directory and the expected file", () => {
    expect(expectRejectMessage(() => requireRepoManifest(tmp.path))).toContain(
      `No repo manifest in ${tmp.path}`
    );
    const recipeMessage = expectRejectMessage(() => requireRecipeManifest(tmp.path));
    expect(recipeMessage).toContain(`No recipe manifest in ${tmp.path}`);
    expect(recipeMessage).toContain("sous.recipe.yaml");
  });
});

describe("createManifests() (formats.manifests)", () => {
  const recipeYaml =
    "formatVersion: 1\nnamespace: workflow\nname: task-files\nversion: 1.0.0\ndepends:\n  - workflow/other\n";
  const repoYaml =
    "formatVersion: 1\nname: sous-recipes\nnamespaces:\n  workflow: {}\nrecipes:\n  - recipes/workflow/task-files\n";

  /** A recipe manifest is found, read and checked, with its path. */
  it("should read the recipe manifest in a directory", async () => {
    const file = write("r/sous.recipe.yaml", recipeYaml);
    const manifests = createManifests();

    expect(manifests.find(path.dirname(file), "recipe")).toBe(file);
    const found = await manifests.readRecipe(path.dirname(file));
    expect(found?.path).toBe(file);
    expect(found?.manifest.name).toBe("task-files");
  });

  /** A repo manifest is read the same way. */
  it("should read the repo manifest at a root", async () => {
    const file = write("repo/sous.repo.json", JSON.stringify({
      formatVersion: 1, name: "sous-recipes", namespaces: { workflow: {} }, recipes: [],
    }));
    const found = await createManifests().readRepo(path.dirname(file));
    expect(found?.manifest.name).toBe("sous-recipes");
    expect(repoYaml).toContain("sous-recipes");
  });

  /** The ref checker given is used on dependencies. */
  it("should check dependency refs with the given checker", async () => {
    const file = write("c/sous.recipe.yaml", recipeYaml);
    const manifests = createManifests({ checkRef: () => { throw new Error("refused"); } });
    await expect(manifests.readRecipe(path.dirname(file))).rejects.toThrow("refused");
  });

  /** No manifest gives undefined from read and a NotFoundError from require. */
  it("should return undefined from read and throw NotFoundError from require", async () => {
    const dir = write("empty/readme.md", "x");
    const manifests = createManifests();
    expect(await manifests.readRecipe(path.dirname(dir))).toBeUndefined();
    await expect(manifests.requireRecipe(path.dirname(dir))).rejects.toMatchObject({ sousErrorKind: "not-found" });
    await expect(manifests.requireRepo(path.dirname(dir))).rejects.toThrow("No repo manifest");
  });

  /** Text and files are parsed by extension, unchecked. */
  it("should parse text and read files by extension", async () => {
    const manifests = createManifests();
    expect(manifests.parseText("a: 1", "x.yaml")).toEqual({ a: 1 });
    expect(manifests.parseText('{"a": 1, /* c */}', "x.jsonc")).toEqual({ a: 1 });
    expect(() => manifests.parseText("a", "x.js")).toThrow("not a manifest format");
    expect(await manifests.readFile(write("f.yml", "b: 2"))).toEqual({ b: 2 });
    await expect(manifests.readFile(path.join(tmp.path, "missing.yaml"))).rejects.toThrow("does not exist");
  });
});
