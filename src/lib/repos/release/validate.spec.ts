import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import {
  findRepoRoot,
  hasErrors,
  validateRepo,
  warningsIn,
  wellKnownEnvReason,
  errorsIn,
} from "./validate.js";

let tmp: TmpDir;

beforeEach(() => {
  tmp = makeTmpDir("sous-release-validate-");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes a file, creating the directories above it. */
function write(relativePath: string, contents: string): string {
  const target = path.join(tmp.path, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
  return target;
}

/** Writes a repo manifest listing the given recipe folders. */
function writeRepoManifest(namespaces: string[], recipes: string[]): void {
  const namespaceBlock = namespaces
    .map((name) => `  ${name}:\n    description: The ${name} namespace.`)
    .join("\n");
  const recipeBlock = recipes.map((entry) => `  - ${entry}`).join("\n");
  write(
    "sous.repo.yaml",
    `formatVersion: 1\nname: test-repo\nnamespaces:\n${namespaceBlock}\nrecipes:\n${recipeBlock}\n`
  );
}

/** Writes a minimal recipe manifest, with an optional extra block appended. */
function writeRecipe(
  folder: string,
  namespace: string,
  name: string,
  extra = ""
): void {
  write(
    `${folder}/sous.recipe.yaml`,
    `formatVersion: 1\nnamespace: ${namespace}\nname: ${name}\nversion: 1.0.0\n${extra}`
  );
}

describe("findRepoRoot()", () => {
  /**
   * findRepoRoot walks up from any directory inside a repository and returns
   * the directory holding the repo manifest.
   *
   * findRepoRoot("<repo>/recipes/core/example");
   * // -> "<repo>"
   */
  it("should return the directory holding the repo manifest", () => {
    writeRepoManifest(["core"], ["recipes/core/example"]);
    writeRecipe("recipes/core/example", "core", "example");

    const found = findRepoRoot(path.join(tmp.path, "recipes/core/example"));

    expect(fs.realpathSync(found)).toBe(fs.realpathSync(tmp.path));
  });

  /**
   * A directory with no repo manifest at or above it is not a repository, and
   * the error says how to get one.
   *
   * findRepoRoot("/tmp/not-a-repo");
   * // -> throws ConfigError naming 'sous repo init'
   */
  it("should throw a readable error when there is no repository above the directory", () => {
    const empty = path.join(tmp.path, "nowhere");
    fs.mkdirSync(empty);

    expect(() => findRepoRoot(empty)).toThrow(/is not inside a sous recipe repository/);
    expect(() => findRepoRoot(empty)).toThrow(/sous repo init/);
  });
});

describe("validateRepo()", () => {
  /**
   * A repository whose manifests agree with each other produces no problems and
   * reports every recipe it read.
   *
   * validateRepo("<clean repo>");
   * // -> { recipes: [{ key: "core/example" }], problems: [] }
   */
  it("should report no problems for a consistent repository", () => {
    writeRepoManifest(["core"], ["recipes/core/example"]);
    writeRecipe("recipes/core/example", "core", "example");

    const result = validateRepo(tmp.path);

    expect(result.problems).toEqual([]);
    expect(result.recipes.map((entry) => entry.key)).toEqual(["core/example"]);
    expect(result.recipes[0]!.manifest.version).toBe("1.0.0");
  });

  /**
   * A recipe folder listed by the repo manifest that is not on disk is an
   * error, named by the path the manifest used.
   */
  it("should report a listed recipe folder that does not exist", () => {
    writeRepoManifest(["core"], ["recipes/core/missing"]);

    const result = validateRepo(tmp.path);

    expect(hasErrors(result.problems)).toBe(true);
    expect(errorsIn(result.problems)[0]!.where).toBe("recipes/core/missing");
    expect(errorsIn(result.problems)[0]!.message).toMatch(/no directory there/);
  });

  /**
   * A published version's content hash covers the recipe folder, and sous
   * neither hashes nor installs what a link points at, so a published link is a
   * file that is simply missing for everyone who installs the recipe. It is
   * refused at release time rather than surfacing later as a puzzling absence.
   *
   * // recipes/core/example/link.md -> ../../../outside.md
   * validateRepo(repo);  // -> an error naming the link
   */
  it("should refuse a recipe folder that publishes a symbolic link", () => {
    writeRepoManifest(["core"], ["recipes/core/example"]);
    writeRecipe("recipes/core/example", "core", "example");
    write("outside.md", "bytes this recipe does not own");
    fs.symlinkSync(
      path.join(tmp.path, "outside.md"),
      path.join(tmp.path, "recipes/core/example/link.md")
    );
    write("recipes/core/example/nested/real.md", "a real file");
    fs.symlinkSync(
      path.join(tmp.path, "outside.md"),
      path.join(tmp.path, "recipes/core/example/nested/deep.md")
    );

    const result = validateRepo(tmp.path);

    expect(hasErrors(result.problems)).toBe(true);
    expect(errorsIn(result.problems).map((entry) => entry.where).sort()).toEqual([
      "recipes/core/example/link.md",
      "recipes/core/example/nested/deep.md",
    ]);
    expect(errorsIn(result.problems)[0]!.message).toMatch(/symbolic link/);
  });

  /**
   * A recipe folder with no recipe manifest in it is an error rather than a
   * silently skipped folder.
   */
  it("should report a recipe folder with no recipe manifest", () => {
    writeRepoManifest(["core"], ["recipes/core/example"]);
    fs.mkdirSync(path.join(tmp.path, "recipes/core/example"), { recursive: true });

    const result = validateRepo(tmp.path);

    expect(errorsIn(result.problems)[0]!.message).toMatch(/no recipe manifest/);
  });

  /**
   * A recipe naming a namespace the repo manifest does not declare could never
   * be resolved by a subscriber, so it is an error.
   */
  it("should report a recipe whose namespace the repo manifest does not declare", () => {
    writeRepoManifest(["core"], ["recipes/core/example"]);
    writeRecipe("recipes/core/example", "workflow", "example");

    const result = validateRepo(tmp.path);

    expect(errorsIn(result.problems)[0]!.message).toMatch(
      /namespace 'workflow', which sous.repo.yaml does not declare/
    );
  });

  /**
   * Two recipes with the same namespace and name would resolve ambiguously, so
   * the second one is an error naming the first.
   */
  it("should report two recipes publishing the same key", () => {
    writeRepoManifest(["core"], ["recipes/a", "recipes/b"]);
    writeRecipe("recipes/a", "core", "example");
    writeRecipe("recipes/b", "core", "example");

    const result = validateRepo(tmp.path);

    expect(errorsIn(result.problems)[0]!.message).toMatch(
      /'core\/example' is also published by recipes\/a\/sous.recipe.yaml/
    );
  });

  /**
   * A recipe manifest that does not parse is reported against its own file
   * rather than aborting the whole pass, so the rest of the repository is still
   * checked.
   */
  it("should report an unparseable recipe manifest and keep going", () => {
    writeRepoManifest(["core"], ["recipes/a", "recipes/b"]);
    write("recipes/a/sous.recipe.yaml", "formatVersion: 1\nnamespace: core\n");
    writeRecipe("recipes/b", "core", "good");

    const result = validateRepo(tmp.path);

    expect(errorsIn(result.problems)).toHaveLength(1);
    expect(result.recipes.map((entry) => entry.key)).toEqual(["core/good"]);
  });

  /**
   * Two definitions of DIFFERENT variables claiming one environment variable is
   * a collision: one answer would silently satisfy both.
   */
  it("should report two different variables claiming one environment variable", () => {
    writeRepoManifest(["core"], ["recipes/a", "recipes/b"]);
    writeRecipe(
      "recipes/a",
      "core",
      "first",
      "variables:\n  - name: apiUrl\n    type: url\n    prompt: Which URL?\n" +
        "    description: What this variable is for.\n    example: https://api.example.com\n"
    );
    writeRecipe(
      "recipes/b",
      "core",
      "second",
      "variables:\n  - name: endpoint\n    type: url\n    env: SOUS_VAR_API_URL\n" +
        "    prompt: Which endpoint?\n" +
        "    description: What this variable is for.\n    example: https://api.example.com\n"
    );

    const result = validateRepo(tmp.path);

    expect(errorsIn(result.problems)[0]!.message).toMatch(
      /claims the environment variable 'SOUS_VAR_API_URL'/
    );
  });

  /**
   * Two recipes declaring the SAME variable name share the shared rung of the
   * resolution ladder on purpose, so that is not a collision.
   */
  it("should accept the same variable name declared by two recipes", () => {
    writeRepoManifest(["core"], ["recipes/a", "recipes/b"]);
    const block =
      "variables:\n  - name: apiUrl\n    type: url\n    prompt: Which URL?\n" +
      "    description: What this variable is for.\n    example: https://api.example.com\n";
    writeRecipe("recipes/a", "core", "first", block);
    writeRecipe("recipes/b", "core", "second", block);

    const result = validateRepo(tmp.path);

    expect(result.problems).toEqual([]);
  });

  /**
   * A definition claiming a well-known system or secret name is a warning, not
   * an error: binding an existing GITHUB_TOKEN is legitimate, it just deserves
   * to be said out loud.
   */
  it("should warn when a definition claims a well-known environment name", () => {
    writeRepoManifest(["core"], ["recipes/a"]);
    writeRecipe(
      "recipes/a",
      "core",
      "first",
      "variables:\n  - name: token\n    type: string\n    env: GITHUB_TOKEN\n" +
        "    secret: true\n    scope: local\n    prompt: Which token?\n" +
        "    description: The token sous authenticates with.\n    example: tok_0123\n"
    );

    const result = validateRepo(tmp.path);

    expect(hasErrors(result.problems)).toBe(false);
    expect(warningsIn(result.problems)[0]!.message).toMatch(/'GITHUB_TOKEN' is a well-known name/);
  });

  /**
   * `x-intentional: true` on the definition says the author meant it, and
   * silences the warning. The flag lives in the reserved `x-` extension
   * namespace, which the schema accepts and drops, so it is read from the raw
   * manifest.
   */
  it("should silence the well-known name warning when the definition is marked intentional", () => {
    writeRepoManifest(["core"], ["recipes/a"]);
    writeRecipe(
      "recipes/a",
      "core",
      "first",
      "variables:\n  - name: token\n    type: string\n    env: GITHUB_TOKEN\n" +
        "    x-intentional: true\n    secret: true\n    scope: local\n    prompt: Which token?\n" +
        "    description: The token sous authenticates with.\n    example: tok_0123\n"
    );

    const result = validateRepo(tmp.path);

    expect(result.problems).toEqual([]);
  });

  /**
   * One variable name bound to two different environment variables in one
   * repository is legal but confusing, so it is a warning.
   */
  it("should warn when one variable name binds to two environment variables", () => {
    writeRepoManifest(["core"], ["recipes/a", "recipes/b"]);
    writeRecipe(
      "recipes/a",
      "core",
      "first",
      "variables:\n  - name: apiUrl\n    type: url\n    prompt: Which URL?\n" +
        "    description: What this variable is for.\n    example: https://api.example.com\n"
    );
    writeRecipe(
      "recipes/b",
      "core",
      "second",
      "variables:\n  - name: apiUrl\n    type: url\n    env: OTHER_API_URL\n" +
        "    prompt: Which URL?\n" +
        "    description: What this variable is for.\n    example: https://api.example.com\n"
    );

    const result = validateRepo(tmp.path);

    expect(hasErrors(result.problems)).toBe(false);
    expect(warningsIn(result.problems)[0]!.message).toMatch(/One answer will not serve both/);
  });
});

describe("wellKnownEnvReason()", () => {
  /**
   * An exact well-known name and a reserved prefix both produce a reason; an
   * ordinary derived name produces none.
   *
   * wellKnownEnvReason("PATH");             // -> a reason
   * wellKnownEnvReason("AWS_REGION");       // -> a reason
   * wellKnownEnvReason("SOUS_VAR_API_URL"); // -> undefined
   */
  it("should flag well-known names and reserved prefixes, but never a derived answer name", () => {
    expect(wellKnownEnvReason("PATH")).toMatch(/well-known name/);
    expect(wellKnownEnvReason("AWS_REGION")).toMatch(/reserved by the system/);
    expect(wellKnownEnvReason("SOUS_HOME")).toMatch(/reserved by the system/);
    expect(wellKnownEnvReason("SOUS_VAR_API_URL")).toBeUndefined();
    expect(wellKnownEnvReason("MY_APP_URL")).toBeUndefined();
  });
});
