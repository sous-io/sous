import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import { buildReleasePlan, describeScope, releaseScope, scopeProblems } from "./plan.js";
import { errorsIn, validateRepo, warningsIn } from "./validate.js";

/**
 * Unit tests for the release plan, against a real git repository: whether a
 * recipe has changed since its tag is a content question answered by hashing a
 * real tagged tree, which no mock reproduces faithfully.
 */

let tmp: TmpDir;
let repo: string;

beforeEach(() => {
  tmp = makeTmpDir("sous-release-plan-");
  repo = tmp.path;
  initRepo(repo);
  writeRepoManifest(["recipes/core/one", "recipes/core/two"]);
  writeRecipe("one", "1.0.0");
  writeRecipe("two", "2.0.0");
  commitAll(repo, "first commit");
  git(repo, "tag", "--annotate", "core/one@1.0.0", "--message", "release");
  git(repo, "tag", "--annotate", "core/two@2.0.0", "--message", "release");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes the repository manifest listing the given recipe folders. */
function writeRepoManifest(recipes: string[]): void {
  writeFile(
    repo,
    "sous.repo.yaml",
    "formatVersion: 1\nname: test-repo\nnamespaces:\n  core:\n    description: Core.\n" +
      `recipes:\n${recipes.map((entry) => `  - ${entry}\n`).join("")}`
  );
}

/** Writes one recipe's manifest and a file of its own. */
function writeRecipe(name: string, version: string, depends: string[] = []): void {
  const dependsBlock =
    depends.length === 0
      ? ""
      : `depends:\n${depends.map((entry) => `  - ${entry}\n`).join("")}`;
  writeFile(
    repo,
    `recipes/core/${name}/sous.recipe.yaml`,
    `formatVersion: 1\nnamespace: core\nname: ${name}\nversion: ${version}\n` +
      `description: The ${name} recipe.\n${dependsBlock}`
  );
  writeFile(repo, `recipes/core/${name}/skills/${name}.md`, `${name}\n`);
}

/** Builds a plan over the repository as it stands. */
async function plan(options: Parameters<typeof buildReleasePlan>[0] | undefined = undefined) {
  return buildReleasePlan({
    validation: validateRepo(repo),
    scope: releaseScope(),
    ...(options ?? {}),
  } as Parameters<typeof buildReleasePlan>[0]);
}

describe("buildReleasePlan()", () => {
  /**
   * A repository where nothing has been touched since its tags releases
   * nothing: a published version that says the same thing as the one before it
   * is noise.
   */
  it("should release nothing when nothing has changed", async () => {
    const result = await plan();

    expect(result.releases).toEqual([]);
    expect(result.skipped.map((entry) => entry.key).sort()).toEqual([
      "core/one",
      "core/two",
    ]);
    expect(result.skipped[0]!.reason).toContain("core/one@1.0.0");
  });

  /**
   * A changed recipe whose version still equals its last tag is patch-bumped by
   * default, and the plan says which tag that would cut.
   */
  it("should patch-bump a changed recipe", async () => {
    writeFile(repo, "recipes/core/one/skills/one.md", "edited\n");
    commitAll(repo, "edit one");

    const result = await plan();

    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({
      key: "core/one",
      from: "1.0.0",
      to: "1.0.1",
      bump: "patch",
      tag: "core/one@1.0.1",
    });
  });

  /** `--bump` decides how far the version is raised. */
  it("should raise by the level it is given", async () => {
    writeFile(repo, "recipes/core/one/skills/one.md", "edited\n");
    commitAll(repo, "edit one");

    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope(),
      bump: "major",
    });

    expect(result.releases[0]!.to).toBe("2.0.0");
  });

  /**
   * A recipe whose version was already raised past its last tag needs no bump;
   * the run only publishes it. That is what a merge looks like to the CI run.
   */
  it("should publish an already-raised version without bumping it", async () => {
    writeRecipe("one", "1.1.0");
    commitAll(repo, "raise one");

    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope(),
      noBump: true,
    });

    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({ key: "core/one", to: "1.1.0" });
    expect(result.releases[0]!.bump).toBeUndefined();
    expect(errorsIn(result.problems)).toEqual([]);
  });

  /**
   * With no bumping allowed, a change nobody raised a version for is an error
   * naming the manifest that has to change.
   */
  it("should refuse an unbumped change when nothing may be bumped", async () => {
    writeFile(repo, "recipes/core/one/skills/one.md", "edited\n");
    commitAll(repo, "edit one");

    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope(),
      noBump: true,
    });

    expect(result.releases).toEqual([]);
    expect(errorsIn(result.problems)[0]!.message).toMatch(/Raise the version/);
  });

  /** `--include-unchanged` releases everything in scope anyway. */
  it("should release an unchanged recipe when asked to", async () => {
    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope(),
      includeUnchanged: true,
    });

    expect(result.releases.map((entry) => entry.to).sort()).toEqual(["1.0.1", "2.0.1"]);
  });

  /** The scope narrows the run, and everything outside it is named as skipped. */
  it("should release only what the scope names", async () => {
    writeFile(repo, "recipes/core/one/skills/one.md", "edited\n");
    writeFile(repo, "recipes/core/two/skills/two.md", "edited\n");
    commitAll(repo, "edit both");

    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope([], ["core/two"]),
    });

    expect(result.releases.map((entry) => entry.key)).toEqual(["core/two"]);
    expect(result.skipped).toEqual([
      { key: "core/one", reason: "it is outside this release's scope." },
    ]);
  });

  /**
   * Tags are cut dependency-first, so a recipe is never published before
   * something it depends on.
   */
  it("should order the releases dependency-first", async () => {
    writeRecipe("one", "1.0.0", ["core/two"]);
    writeFile(repo, "recipes/core/two/skills/two.md", "edited\n");
    commitAll(repo, "depend on two, and edit it");

    const result = await plan();

    expect(result.releases.map((entry) => entry.key)).toEqual(["core/two", "core/one"]);
  });

  /**
   * A sibling that has changed but sits outside the scope is not an error: the
   * release goes ahead depending on the sibling's last published version, and
   * the warning states only what a reader can check.
   */
  it("should warn about a changed sibling outside the scope", async () => {
    writeRecipe("one", "1.0.0", ["core/two"]);
    writeFile(repo, "recipes/core/two/skills/two.md", "edited\n");
    commitAll(repo, "depend on two, and edit it");

    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope([], ["core/one"]),
    });

    expect(errorsIn(result.problems)).toEqual([]);
    expect(warningsIn(result.problems)[0]!.message).toBe(
      "'core/two' has changes since 'core/two@2.0.0' that are outside this release's " +
        "scope; 'core/one@1.0.1' will depend on 'core/two@2.0.0'."
    );
  });

  /**
   * A sibling that has never been published cannot be depended on at all, and
   * the error names the tag that has to be cut.
   */
  it("should refuse a dependency on a sibling that was never published", async () => {
    writeRepoManifest(["recipes/core/one", "recipes/core/two", "recipes/core/three"]);
    writeRecipe("three", "1.0.0");
    writeRecipe("one", "1.0.0", ["core/three"]);
    commitAll(repo, "add an unpublished sibling and depend on it");

    // The scope leaves the sibling out, so this run cannot publish it either.
    const result = await plan({
      validation: validateRepo(repo),
      scope: releaseScope([], ["core/one"]),
    });

    expect(errorsIn(result.problems)[0]!.message).toMatch(/has never been published/);
    expect(errorsIn(result.problems)[0]!.message).toContain("core/three@1.0.0");
  });
});

describe("releaseScope() and describeScope()", () => {
  /** An empty scope is the whole repository, and says so. */
  it("should describe an empty scope as the whole repository", () => {
    expect(describeScope(releaseScope())).toBe("The whole repository");
  });

  /** A scope lists what it covers, in plain words. */
  it("should describe what a narrowed scope covers", () => {
    expect(describeScope(releaseScope(["workflow"], ["core/one"]))).toBe(
      "The namespace workflow, and the recipe core/one"
    );
  });

  /** A scope naming something the repository does not publish is a typo. */
  it("should report a scope that names nothing", () => {
    const problems = scopeProblems(validateRepo(repo), releaseScope(["nope"], ["core/nope"]));

    expect(problems).toHaveLength(2);
    expect(problems[0]!.message).toContain("no namespace called 'nope'");
    expect(problems[1]!.message).toContain("no recipe called 'core/nope'");
  });
});
