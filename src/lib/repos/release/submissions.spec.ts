/**
 * Unit tests for the `submissions` block: which manifest decides, which
 * changed paths fall inside a recipe, and the pull request check, which runs
 * real git against a temporary repository.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import {
  checkSubmissions,
  pathsInside,
  recipesRefusingSubmissions,
  submissionPolicy,
} from "./submissions.js";
import { validateRepo } from "./validate.js";

let tmp: TmpDir;
let repo: string;

/** Writes a repository with two recipes, and the given submissions blocks. */
function writeRepo(blocks: { repo?: string; first?: string } = {}): void {
  writeFile(
    repo,
    "sous.repo.yaml",
    "formatVersion: 1\nname: test-repo\nnamespaces:\n  core: {}\n" +
      "recipes:\n  - recipes/core/first\n  - recipes/core/second\n" +
      (blocks.repo ?? "")
  );
  writeFile(
    repo,
    "recipes/core/first/sous.recipe.yaml",
    "formatVersion: 1\nnamespace: core\nname: first\nversion: 1.0.0\n" + (blocks.first ?? "")
  );
  writeFile(
    repo,
    "recipes/core/second/sous.recipe.yaml",
    "formatVersion: 1\nnamespace: core\nname: second\nversion: 1.0.0\n"
  );
  writeFile(repo, "recipes/core/first/skills/one.md", "one\n");
  writeFile(repo, "recipes/core/second/skills/two.md", "two\n");
}

beforeEach(() => {
  tmp = makeTmpDir("sous-submissions-");
  repo = path.join(tmp.path, "recipes");
  fs.mkdirSync(repo, { recursive: true });
  initRepo(repo);
});

afterEach(() => {
  tmp.cleanup();
});

describe("submissionPolicy()", () => {
  /**
   * A recipe's own block wins over the repository's, and with neither a recipe
   * takes proposals.
   */
  it("should let the recipe's block win over the repository's", () => {
    writeRepo({
      repo: "submissions:\n  allowed: false\n  instead: Not here.\n",
      first: "submissions:\n  allowed: true\n",
    });
    const validation = validateRepo(repo);
    const [first, second] = validation.recipes;

    expect(submissionPolicy(validation, first!)).toEqual({ allowed: true, declaredBy: "recipe" });
    expect(submissionPolicy(validation, second!)).toEqual({
      allowed: false,
      instead: "Not here.",
      declaredBy: "repository",
    });
  });

  /**
   * With no block anywhere, every recipe takes proposals.
   */
  it("should allow proposals when no manifest says otherwise", () => {
    writeRepo();
    const validation = validateRepo(repo);

    expect(submissionPolicy(validation, validation.recipes[0]!)).toEqual({
      allowed: true,
      declaredBy: "default",
    });
  });
});

describe("pathsInside()", () => {
  /**
   * A path is inside a folder when it lies under it; a sibling whose name only
   * starts the same way is not.
   *
   * pathsInside("recipes/core/x", ["recipes/core/x/a.md", "recipes/core/xy/b.md"]);
   * // -> ["recipes/core/x/a.md"]
   */
  it("should keep only the paths under the folder", () => {
    expect(
      pathsInside("recipes/core/x/", ["recipes/core/x/a.md", "recipes/core/xy/b.md", "README.md"])
    ).toEqual(["recipes/core/x/a.md"]);
  });
});

describe("recipesRefusingSubmissions()", () => {
  /**
   * Only a recipe that declines proposals and holds a changed path is listed,
   * with where to go instead.
   */
  it("should list the declining recipes a change touches", () => {
    writeRepo({ first: "submissions:\n  allowed: false\n  instead: Upstream.\n" });
    const validation = validateRepo(repo);

    expect(
      recipesRefusingSubmissions(validation, [
        "recipes/core/first/skills/one.md",
        "recipes/core/second/skills/two.md",
      ])
    ).toEqual([
      {
        key: "core/first",
        path: "recipes/core/first",
        instead: "Upstream.",
        declaredBy: "recipe",
        changed: ["recipes/core/first/skills/one.md"],
      },
    ]);
    expect(recipesRefusingSubmissions(validation, ["recipes/core/second/skills/two.md"])).toEqual(
      []
    );
  });
});

describe("checkSubmissions()", () => {
  /**
   * With a copy of the default branch, the change is what HEAD holds beyond
   * the point it shares with that branch.
   */
  it("should compare with the default branch when the checkout holds it", async () => {
    writeRepo({ first: "submissions:\n  allowed: false\n" });
    commitAll(repo, "first");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeFile(repo, "recipes/core/first/skills/one.md", "edited\n");
    commitAll(repo, "edit a declining recipe");

    const result = await checkSubmissions(validateRepo(repo));

    expect(result.comparedWith).toEqual({ kind: "branch", branch: "main" });
    expect(result.refusing.map((entry) => entry.key)).toEqual(["core/first"]);
  });

  /**
   * With no copy of the default branch, each declining recipe is compared with
   * its last release tag.
   */
  it("should compare with the last release tag when there is no branch copy", async () => {
    writeRepo({ first: "submissions:\n  allowed: false\n" });
    commitAll(repo, "first");
    git(repo, "tag", "--annotate", "core/first@1.0.0", "--message", "release");
    writeFile(repo, "recipes/core/second/skills/two.md", "edited\n");
    commitAll(repo, "edit an ordinary recipe");

    const untouched = await checkSubmissions(validateRepo(repo));
    expect(untouched.comparedWith).toEqual({ kind: "tags" });
    expect(untouched.refusing).toEqual([]);

    writeFile(repo, "recipes/core/first/skills/one.md", "edited\n");
    commitAll(repo, "edit the declining recipe");

    const touched = await checkSubmissions(validateRepo(repo));
    expect(touched.refusing.map((entry) => entry.key)).toEqual(["core/first"]);
  });

  /**
   * A repository whose recipes all take proposals has nothing to check.
   */
  it("should say nothing declined when no recipe declines proposals", async () => {
    writeRepo();
    commitAll(repo, "first");

    expect((await checkSubmissions(validateRepo(repo))).comparedWith).toEqual({
      kind: "none declined",
    });
  });
});
