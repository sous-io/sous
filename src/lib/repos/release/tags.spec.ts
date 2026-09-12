import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import {
  createAnnotatedTag,
  listRecipeTags,
  parseRecipeTag,
  readFileAtTag,
  recipeTagKey,
  tagCommitDate,
  tagFor,
  withTaggedTree,
} from "./tags.js";

let tmp: TmpDir;
let repo: string;

beforeEach(() => {
  tmp = makeTmpDir("sous-release-tags-");
  repo = tmp.path;
  initRepo(repo);
  writeFile(repo, "recipes/core/example/sous.recipe.yaml", "version: 1.0.0\n");
  writeFile(repo, "recipes/core/example/skills/one.md", "first\n");
  commitAll(repo, "first commit");
});

afterEach(() => {
  tmp.cleanup();
});

describe("tagFor() and parseRecipeTag()", () => {
  /**
   * A release tag joins the recipe key and the exact version with an at sign,
   * and parses back into the same three parts.
   *
   * tagFor("core", "example", "1.2.3");   // -> "core/example@1.2.3"
   * parseRecipeTag("core/example@1.2.3"); // -> { namespace: "core", name: "example", ... }
   */
  it("should round-trip a namespace, a name and a version", () => {
    const tag = tagFor("core", "example", "1.2.3");
    expect(tag).toBe("core/example@1.2.3");

    const parsed = parseRecipeTag(tag);
    expect(parsed).toEqual({
      tag,
      namespace: "core",
      name: "example",
      version: "1.2.3",
    });
    expect(recipeTagKey(parsed!)).toBe("core/example");
  });

  /**
   * A prerelease version carries its own hyphen and dots, and the LAST at sign
   * is the separator, so the version comes back whole.
   *
   * parseRecipeTag("core/example@2.0.0-beta.1").version; // -> "2.0.0-beta.1"
   */
  it("should keep a prerelease version whole", () => {
    expect(parseRecipeTag("core/example@2.0.0-beta.1")?.version).toBe("2.0.0-beta.1");
  });

  /**
   * A repository's own tags are not recipe release tags, and are left alone
   * rather than misread.
   *
   * parseRecipeTag("v1.2.0");        // -> undefined
   * parseRecipeTag("Core/Example@1"); // -> undefined (a key is lowercase kebab-case)
   */
  it("should return undefined for a tag that is not a recipe release", () => {
    expect(parseRecipeTag("v1.2.0")).toBeUndefined();
    expect(parseRecipeTag("core@1.0.0")).toBeUndefined();
    expect(parseRecipeTag("Core/Example@1.0.0")).toBeUndefined();
    expect(parseRecipeTag("core/example@")).toBeUndefined();
  });
});

describe("listRecipeTags()", () => {
  /**
   * Only tags shaped like a recipe release are listed; anything else the
   * repository tags for its own reasons is skipped.
   *
   * listRecipeTags(repo);
   * // -> [{ tag: "core/example@1.0.0", namespace: "core", ... }]
   */
  it("should list recipe release tags and skip the repository's own tags", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");
    git(repo, "tag", "--annotate", "v9.9.9", "--message", "not a recipe");

    const tags = await listRecipeTags(repo);

    expect(tags.map((entry) => entry.tag)).toEqual(["core/example@1.0.0"]);
  });

  /**
   * A repository with no tags at all yields an empty list rather than failing.
   */
  it("should return an empty list when nothing is tagged", async () => {
    expect(await listRecipeTags(repo)).toEqual([]);
  });
});

describe("readFileAtTag()", () => {
  /**
   * A file is read as it stood at the tag, not as it stands now, which is what
   * makes tag-to-metadata consistency checkable.
   *
   * readFileAtTag(repo, "core/example@1.0.0", "recipes/core/example/sous.recipe.yaml");
   * // -> "version: 1.0.0"
   */
  it("should return the file as it stood at the tag", async () => {
    await createAnnotatedTag(repo, "core/example@1.0.0", "release 1.0.0");
    writeFile(repo, "recipes/core/example/sous.recipe.yaml", "version: 2.0.0\n");
    commitAll(repo, "bump");

    const text = await readFileAtTag(
      repo,
      "core/example@1.0.0",
      "recipes/core/example/sous.recipe.yaml"
    );

    expect(text).toBe("version: 1.0.0");
  });

  /**
   * A tag that does not carry the file yields undefined rather than throwing,
   * so the caller can report it as the inconsistency it is.
   */
  it("should return undefined when the tag does not carry the file", async () => {
    await createAnnotatedTag(repo, "core/example@1.0.0", "release 1.0.0");
    expect(await readFileAtTag(repo, "core/example@1.0.0", "nowhere.yaml")).toBeUndefined();
  });
});

describe("tagCommitDate()", () => {
  /**
   * The date is the commit date of what the tag points at, normalized to an ISO
   * 8601 timestamp so it can be written straight into the index.
   *
   * tagCommitDate(repo, "core/example@1.0.0"); // -> "2026-09-10T12:34:56.000Z"
   */
  it("should return the tagged commit's date as an ISO timestamp", async () => {
    await createAnnotatedTag(repo, "core/example@1.0.0", "release 1.0.0");

    const date = await tagCommitDate(repo, "core/example@1.0.0");

    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  /**
   * A tag that does not exist has no date, and that is not an error.
   */
  it("should return undefined for a tag that does not exist", async () => {
    expect(await tagCommitDate(repo, "core/example@9.9.9")).toBeUndefined();
  });
});

describe("withTaggedTree()", () => {
  /**
   * The tagged content is materialized on disk so it can be read and hashed
   * exactly as a fetched copy would be, and the temporary checkout is gone
   * afterwards.
   *
   * withTaggedTree(repo, tag, "recipes/core/example", async (dir) => read(dir));
   */
  it("should hand the caller the tagged folder and clean up after itself", async () => {
    await createAnnotatedTag(repo, "core/example@1.0.0", "release 1.0.0");
    writeFile(repo, "recipes/core/example/skills/one.md", "changed\n");
    commitAll(repo, "edit after the tag");

    let seenDir = "";
    const contents = await withTaggedTree(
      repo,
      "core/example@1.0.0",
      "recipes/core/example",
      async (dir) => {
        seenDir = dir;
        return fs.readFileSync(path.join(dir, "skills", "one.md"), "utf8");
      }
    );

    expect(contents).toBe("first\n");
    expect(fs.existsSync(seenDir)).toBe(false);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  /**
   * A failure inside the callback still leaves no worktree behind; the cleanup
   * runs whatever happened.
   */
  it("should clean up when the callback throws", async () => {
    await createAnnotatedTag(repo, "core/example@1.0.0", "release 1.0.0");

    await expect(
      withTaggedTree(repo, "core/example@1.0.0", "recipes/core/example", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });
});
