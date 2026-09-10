import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import { buildIndex, indexFilePath, readIndexFile } from "./index-builder.js";
import { errorsIn, validateRepo, warningsIn } from "./validate.js";
import type { IndexFile } from "../formats/index-file.js";

let tmp: TmpDir;
let repo: string;

/** The sous version recorded as the index generator in these tests. */
const GENERATOR = "1.2.3";

beforeEach(() => {
  tmp = makeTmpDir("sous-release-index-");
  repo = tmp.path;
  initRepo(repo);
  writeFile(
    repo,
    "sous.repo.yaml",
    "formatVersion: 1\nname: test-repo\nnamespaces:\n  core:\n    description: Core recipes.\n" +
      "recipes:\n  - recipes/core/example\n"
  );
  writeRecipe("1.0.0");
  writeFile(repo, "recipes/core/example/skills/one.md", "first\n");
  commitAll(repo, "first commit");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes the example recipe's manifest at a version. */
function writeRecipe(version: string): void {
  writeFile(
    repo,
    "recipes/core/example/sous.recipe.yaml",
    `formatVersion: 1\nnamespace: core\nname: example\nversion: ${version}\n` +
      "description: An example recipe.\n"
  );
}

/** Regenerates the index from the repository as it stands. */
async function build(existing?: IndexFile) {
  return buildIndex({
    validation: validateRepo(repo),
    existing,
    sousVersion: GENERATOR,
    now: new Date("2026-09-10T12:00:00.000Z"),
  });
}

/** Writes the regenerated index to the repository, as `sous repo release` would. */
function saveIndex(text: string): void {
  fs.writeFileSync(indexFilePath(repo), text, "utf8");
}

describe("buildIndex()", () => {
  /**
   * A version with no tag is not published, and the index schema requires a tag
   * on every version entry, so the version is left out of the index and
   * reported as pending instead.
   *
   * buildIndex(...); // -> { pending: [{ version: "1.0.0", tag: "core/example@1.0.0" }] }
   */
  it("should leave an untagged version out of the index and report it as pending", async () => {
    const result = await build();

    expect(result.index.recipes).toEqual({});
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({
      key: "core/example",
      version: "1.0.0",
      tag: "core/example@1.0.0",
      path: "recipes/core/example",
    });
    expect(result.pending[0]!.hash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(result.problems).toEqual([]);
    expect(result.stale).toBe(true);
  });

  /**
   * Once the version is tagged it becomes a published version: the index
   * records the hash of the TAGGED tree, the tag that carries it, whether it is
   * a prerelease, and when it was released.
   */
  it("should publish a tagged version, with its hash, tag and release date", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");

    const result = await build();

    expect(result.pending).toEqual([]);
    expect(result.problems).toEqual([]);
    const entry = result.index.recipes["core/example"]!;
    expect(entry.path).toBe("recipes/core/example");
    expect(entry.description).toBe("An example recipe.");
    expect(entry.versions["1.0.0"]).toMatchObject({
      tag: "core/example@1.0.0",
      prerelease: false,
    });
    expect(entry.versions["1.0.0"]!.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * A prerelease version is marked as one, so a range that has not opted in
   * skips it.
   */
  it("should mark a prerelease version as a prerelease", async () => {
    writeRecipe("2.0.0-beta.1");
    commitAll(repo, "prerelease");
    git(repo, "tag", "--annotate", "core/example@2.0.0-beta.1", "--message", "beta");

    const result = await build();

    expect(result.index.recipes["core/example"]!.versions["2.0.0-beta.1"]!.prerelease).toBe(
      true
    );
  });

  /**
   * Regenerating an index that is already current changes nothing, including
   * the generated-at stamp: otherwise `--check` would call every index stale the
   * moment it looked at one.
   */
  it("should report a current index as unchanged, keeping its generated-at stamp", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");
    const first = await build();
    saveIndex(first.text);

    const second = await buildIndex({
      validation: validateRepo(repo),
      existing: readIndexFile(repo),
      sousVersion: GENERATOR,
      now: new Date("2026-12-31T23:59:59.000Z"),
    });

    expect(second.stale).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.index.generatedAt).toBe(first.index.generatedAt);
  });

  /**
   * Editing a recipe whose current version is already published is the mistake
   * the hash exists to catch: the version must be bumped, not republished.
   */
  it("should report content that changed after its version was published", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");
    writeFile(repo, "recipes/core/example/skills/one.md", "edited\n");
    commitAll(repo, "edit without bumping");

    const result = await build();

    expect(errorsIn(result.problems)[0]!.message).toMatch(
      /no longer match what that tag carries/
    );
  });

  /**
   * A tag whose manifest declares a different version disagrees with the
   * metadata that is the source of truth, and that is an error naming the tag.
   */
  it("should report a tag whose recipe manifest declares another version", async () => {
    // The tag names 1.1.0, but the commit it points at still declares 1.0.0.
    git(repo, "tag", "--annotate", "core/example@1.1.0", "--message", "mistagged");
    writeRecipe("1.1.0");
    commitAll(repo, "bump");

    const result = await build();

    expect(errorsIn(result.problems).map((problem) => problem.message).join("\n")).toMatch(
      /carries a manifest declaring version 1\.0\.0, not 1\.1\.0/
    );
  });

  /**
   * An index that publishes a version no tag carries is hiding a version behind
   * a missing tag, which the design forbids outright.
   */
  it("should report an index version whose tag does not exist", async () => {
    const existing: IndexFile = {
      formatVersion: 1,
      name: "test-repo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: GENERATOR,
      namespaces: { core: {} },
      recipes: {
        "core/example": {
          path: "recipes/core/example",
          versions: {
            "1.0.0": {
              hash: `sha256-${"0".repeat(64)}`,
              tag: "core/example@1.0.0",
              prerelease: false,
            },
          },
        },
      },
    };

    const result = await build(existing);

    expect(errorsIn(result.problems)[0]!.message).toMatch(
      /does not exist in this repository/
    );
  });

  /**
   * The tags are the backstop: deleting the index and regenerating it restores
   * the same catalog, because every tagged version is rebuilt from its tag.
   */
  it("should rebuild a lost index from the tags alone", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");
    const first = await build();
    saveIndex(first.text);

    fs.rmSync(indexFilePath(repo));
    const rebuilt = await build();

    expect(rebuilt.index.recipes).toEqual(first.index.recipes);
  });

  /**
   * Tags for a recipe the repository no longer publishes are ordinary history
   * after a rename, so they are reported as a warning and left alone.
   */
  it("should warn about release tags for a recipe that is no longer published", async () => {
    git(repo, "tag", "--annotate", "core/retired@1.0.0", "--message", "old");

    const result = await build();

    expect(warningsIn(result.problems)[0]!.message).toMatch(
      /which it no longer publishes/
    );
  });
});

describe("readIndexFile()", () => {
  /**
   * A repository with no index yet reads back as undefined rather than failing,
   * which is what a freshly scaffolded repository looks like before its first
   * release.
   */
  it("should return undefined when the repository has no index", () => {
    fs.rmSync(indexFilePath(repo), { force: true });
    expect(readIndexFile(repo)).toBeUndefined();
  });

  /**
   * An index that is present but not valid is a readable ConfigError naming the
   * file, not a raw JSON or schema failure.
   */
  it("should throw a readable error for an index that does not validate", () => {
    fs.writeFileSync(path.join(repo, "sous.index.json"), '{"formatVersion": 2}\n', "utf8");
    expect(() => readIndexFile(repo)).toThrow(/repo index/);
  });
});
