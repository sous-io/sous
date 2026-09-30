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
   * The version a manifest declares right now is the one a release is in the
   * middle of publishing: the index is committed first and the tag is cut on
   * that commit, so an index recording it without a tag is expected.
   */
  it("should keep the current version an index records while its tag is pending", async () => {
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

    // A release writes the index, commits it, and tags that commit, so between
    // the two the index describes a version whose tag is about to exist. That
    // is the version the manifest declares, and only that one.
    expect(errorsIn(result.problems)).toEqual([]);
    expect(Object.keys(result.index.recipes["core/example"]!.versions)).toEqual(["1.0.0"]);
    expect(result.pending.map((entry) => entry.tag)).toEqual(["core/example@1.0.0"]);
  });

  /**
   * An OLDER version the index publishes is history, and history with no tag is
   * a published version nothing can fetch.
   */
  it("should report an older index version whose tag does not exist", async () => {
    writeRecipe("1.1.0");
    commitAll(repo, "raise the version");

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
   * Each published version records what it was released against, so a consumer
   * installs the versions the recipe was published with rather than
   * re-resolving its ranges later. A sibling with no range means "the version
   * released alongside me".
   */
  it("should record a sibling dependency at the version it is released with", async () => {
    writeFile(
      repo,
      "sous.repo.yaml",
      "formatVersion: 1\nname: test-repo\nnamespaces:\n  core:\n    description: Core recipes.\n" +
        "recipes:\n  - recipes/core/example\n  - recipes/core/partials\n"
    );
    writeFile(
      repo,
      "recipes/core/partials/sous.recipe.yaml",
      "formatVersion: 1\nnamespace: core\nname: partials\nversion: 2.0.0\n"
    );
    writeFile(repo, "recipes/core/partials/one.md", "partial\n");
    writeFile(
      repo,
      "recipes/core/example/sous.recipe.yaml",
      "formatVersion: 1\nnamespace: core\nname: example\nversion: 1.0.0\n" +
        "description: An example recipe.\ndepends:\n  - core/partials\n"
    );
    commitAll(repo, "add a sibling dependency");
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");
    git(repo, "tag", "--annotate", "core/partials@2.0.0", "--message", "release");

    const result = await build();

    expect(
      result.index.recipes["core/example"]!.versions["1.0.0"]!.dependencies
    ).toEqual({
      "core/partials": { version: "2.0.0", declared: "core/partials", kind: "depends" },
    });
  });

  /**
   * A dependency in another repository carries that repository's identity,
   * which is what a consumer needs in order to add it and find the recipe; its
   * exact version belongs to that repository's own index.
   */
  it("should record a cross-repository dependency by identity", async () => {
    writeFile(
      repo,
      "recipes/core/example/sous.recipe.yaml",
      "formatVersion: 1\nnamespace: core\nname: example\nversion: 1.0.0\n" +
        "description: An example recipe.\n" +
        "depends:\n  - github://sous-io/sous-recipes/workflow/task-files@^1.1\n"
    );
    commitAll(repo, "depend on another repository");
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");

    const result = await build();

    expect(
      result.index.recipes["core/example"]!.versions["1.0.0"]!.dependencies
    ).toEqual({
      "workflow/task-files": {
        repo: "github.com/sous-io/sous-recipes",
        range: "^1.1",
        declared: "github://sous-io/sous-recipes/workflow/task-files@^1.1",
        kind: "depends",
      },
    });
  });

  /**
   * A dependency that reads more than one way is recorded as the release
   * settled it: under every key it reached, with the repository it settled on,
   * so a consumer reads the answer instead of probing. One that reads one way
   * and names a whole namespace elsewhere records nothing, because the
   * consumer reads that namespace from the other repository's own index.
   *
   * settled: { "gitlab://a/b/c/d" -> gitlab.com/a/b/c, keys ["d/x", "d/y"] }
   * // -> dependencies { "d/x": { repo, range: "*" }, "d/y": { repo, range: "*" } }
   */
  it("should record a settled dependency under every key it reached", async () => {
    writeFile(
      repo,
      "recipes/core/example/sous.recipe.yaml",
      "formatVersion: 1\nnamespace: core\nname: example\nversion: 1.0.0\n" +
        "description: An example recipe.\n" +
        "depends:\n  - gitlab://a/b/c/d\n  - github://o/r/workflow\n"
    );
    commitAll(repo, "depend on a nested group");
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");

    const settledEntry = {
      repo: "gitlab.com/a/b/c",
      range: "*",
      declared: "gitlab://a/b/c/d",
      kind: "depends",
    };
    const result = await buildIndex({
      validation: validateRepo(repo),
      sousVersion: GENERATOR,
      now: new Date("2026-09-10T12:00:00.000Z"),
      settled: new Map([
        ["gitlab://a/b/c/d", { identity: "gitlab.com/a/b/c", keys: ["d/x", "d/y"] }],
      ]),
    });

    expect(
      result.index.recipes["core/example"]!.versions["1.0.0"]!.dependencies
    ).toEqual({
      "d/x": { ...settledEntry },
      "d/y": { ...settledEntry },
    });
    // The namespace in another repository has no key to record under, so the
    // version's own lists are what carries it to a consumer.
    expect(result.index.recipes["core/example"]!.versions["1.0.0"]!.depends).toEqual([
      "gitlab://a/b/c/d",
      "github://o/r/workflow",
    ]);
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

/**
 * The repository the frozen-dependency tests release: a preset set,
 * `omakase/house`, that subscribes to the whole `workflow` namespace and to
 * `tools/gamma`, beside the recipes it names.
 */
function writeSetRepository(recipes: string[]): void {
  writeFile(
    repo,
    "sous.repo.yaml",
    "formatVersion: 1\nname: test-repo\nnamespaces:\n  omakase: {}\n  workflow: {}\n" +
      "  tools: {}\nrecipes:\n" +
      recipes.map((key) => `  - recipes/${key}\n`).join("")
  );
}

/** Writes one recipe of the set repository, with a file so it has content. */
function writeSetRecipe(key: string, version: string, extra = ""): void {
  const [namespace, name] = key.split("/");
  writeFile(
    repo,
    `recipes/${key}/sous.recipe.yaml`,
    `formatVersion: 1\nnamespace: ${namespace}\nname: ${name}\nversion: ${version}\n${extra}`
  );
  writeFile(repo, `recipes/${key}/skills/${name}.md`, `${key} ${version}\n`);
}

/**
 * Publishes the given versions the way `sous repo release` does: regenerate the
 * index against the committed one, write it, commit, then tag. Fails the test
 * on any error the regeneration reports.
 */
async function publish(versions: Record<string, string>): Promise<IndexFile> {
  const result = await buildIndex({
    validation: validateRepo(repo),
    existing: readIndexFile(repo),
    sousVersion: GENERATOR,
    now: new Date("2026-09-10T12:00:00.000Z"),
    publishing: versions,
  });
  expect(errorsIn(result.problems)).toEqual([]);
  saveIndex(result.text);
  commitAll(repo, `release ${Object.keys(versions).join(", ")}`);
  for (const [key, version] of Object.entries(versions)) {
    git(repo, "tag", "--annotate", `${key}@${version}`, "--message", "release");
  }
  return result.index;
}

/** The index entry of `omakase/house@0.1.0`, exactly as it is written to disk. */
function houseEntryText(): string {
  const index = readIndexFile(repo)!;
  return JSON.stringify(index.recipes["omakase/house"]!.versions["0.1.0"]);
}

/** Regenerates the index against the committed one, publishing nothing new. */
async function regenerate() {
  return buildIndex({
    validation: validateRepo(repo),
    existing: readIndexFile(repo),
    sousVersion: GENERATOR,
    now: new Date("2026-09-11T12:00:00.000Z"),
  });
}

/** Rewrites the committed index through a function, and commits it. */
function editIndex(edit: (index: Record<string, any>) => void): void {
  const index = JSON.parse(fs.readFileSync(indexFilePath(repo), "utf8"));
  edit(index);
  saveIndex(`${JSON.stringify(index, null, 2)}\n`);
  commitAll(repo, "edit the index");
}

describe("buildIndex() and published dependencies", () => {
  const HOUSE = "subscribes:\n  - workflow\n  - tools/gamma\n";

  /** What each member of the set records: the version, and the entry naming it. */
  const member = (version: string, declared: string) => ({
    version,
    declared,
    kind: "subscribes",
  });

  beforeEach(async () => {
    writeSetRepository(["omakase/house", "workflow/alpha", "workflow/beta", "tools/gamma"]);
    fs.rmSync(path.join(repo, "recipes/core"), { recursive: true, force: true });
    writeSetRecipe("omakase/house", "0.1.0", HOUSE);
    writeSetRecipe("workflow/alpha", "0.1.0");
    writeSetRecipe("workflow/beta", "0.1.0");
    writeSetRecipe("tools/gamma", "0.1.0");
    commitAll(repo, "the set and its recipes");
    await publish({
      "omakase/house": "0.1.0",
      "workflow/alpha": "0.1.0",
      "workflow/beta": "0.1.0",
      "tools/gamma": "0.1.0",
    });
  });

  /**
   * A version being published resolves its dependencies once: a whole
   * namespace expands to the recipes it holds, and a sibling with no range is
   * the version released alongside it.
   *
   * house subscribes [workflow, tools/gamma]
   * // -> { tools/gamma: 0.1.0, workflow/alpha: 0.1.0, workflow/beta: 0.1.0 }
   */
  it("should resolve a new version's dependencies when it is first published", () => {
    expect(readIndexFile(repo)!.recipes["omakase/house"]!.versions["0.1.0"]!.dependencies).toEqual({
      "tools/gamma": member("0.1.0", "tools/gamma"),
      "workflow/alpha": member("0.1.0", "workflow"),
      "workflow/beta": member("0.1.0", "workflow"),
    });
  });

  /**
   * A version being published is described in full: each dependency carries
   * the manifest entry that brings it in and its kind, and the version carries
   * the variable definitions its manifest publishes. A recipe with neither
   * records both as empty, so "none" reads differently from "not recorded".
   *
   * house@0.2.0 depends [workflow/alpha], subscribes [workflow], asks houseName
   * // -> alpha declared "workflow/alpha" (subscribes, through the namespace);
   * //    beta declared "workflow" (subscribes); variables [houseName]
   */
  it("should describe how each dependency is declared and what the version asks", async () => {
    writeSetRecipe(
      "omakase/house",
      "0.2.0",
      "depends:\n  - workflow/alpha\nsubscribes:\n  - workflow\n" +
        "variables:\n  - name: houseName\n    type: string\n" +
        "    prompt: What is the house called?\n" +
        "    description: The name every skill in the set signs with.\n" +
        "    example: Harbor\n"
    );
    commitAll(repo, "describe the set");
    const index = await publish({ "omakase/house": "0.2.0" });

    const house = index.recipes["omakase/house"]!.versions["0.2.0"]!;
    expect(house.dependencies).toEqual({
      "workflow/alpha": member("0.1.0", "workflow/alpha"),
      "workflow/beta": member("0.1.0", "workflow"),
    });
    expect(house.depends).toEqual(["workflow/alpha"]);
    expect(house.subscribes).toEqual(["workflow"]);
    expect(house.variables).toEqual([
      {
        name: "houseName",
        type: "string",
        prompt: "What is the house called?",
        description: "The name every skill in the set signs with.",
        example: "Harbor",
        required: true,
        secret: false,
        scope: "shared",
      },
    ]);

    const gamma = index.recipes["tools/gamma"]!.versions["0.1.0"]!;
    expect(gamma.dependencies).toEqual({});
    expect(gamma.depends).toEqual([]);
    expect(gamma.subscribes).toEqual([]);
    expect(gamma.variables).toEqual([]);
  });

  /**
   * The lists a published version records are copied from its manifest, so a
   * recorded list that differs from the manifest means the index was edited,
   * and it is an error like any other disagreement.
   *
   * recorded subscribes [workflow], manifest subscribes [workflow, tools/gamma] // -> error
   */
  it("should report recorded lists that disagree with the manifest", async () => {
    editIndex((index) => {
      index.recipes["omakase/house"].versions["0.1.0"].subscribes = ["workflow"];
    });

    const result = await regenerate();

    expect(errorsIn(result.problems).map((problem) => problem.message).join("\n")).toContain(
      "'subscribes': the index records [workflow], and the manifest declares " +
        "[workflow, tools/gamma]"
    );
  });

  /**
   * A version published before sous described recipes in the index records no
   * declaration, kind or variables. Its entry is carried forward exactly as it
   * is, without an error, and nothing fills the new fields in afterwards.
   */
  it("should leave an entry published before descriptions were recorded as it is", async () => {
    editIndex((index) => {
      const entry = index.recipes["omakase/house"].versions["0.1.0"];
      delete entry.variables;
      delete entry.depends;
      delete entry.subscribes;
      for (const dependency of Object.values(entry.dependencies) as Array<Record<string, unknown>>) {
        delete dependency.declared;
        delete dependency.kind;
      }
    });
    const before = houseEntryText();

    const result = await regenerate();

    expect(errorsIn(result.problems)).toEqual([]);
    expect(result.stale).toBe(false);
    expect(JSON.stringify(result.index.recipes["omakase/house"]!.versions["0.1.0"])).toBe(before);
  });

  /**
   * A recorded declaration or kind that disagrees with the manifest of the
   * version it describes is an error, like any other disagreement.
   *
   * recorded { tools/gamma: kind "depends" }, manifest subscribes [tools/gamma] // -> error
   */
  it("should report a recorded kind that disagrees with the manifest", async () => {
    editIndex((index) => {
      index.recipes["omakase/house"].versions["0.1.0"].dependencies["tools/gamma"].kind =
        "depends";
    });

    const result = await regenerate();

    expect(errorsIn(result.problems).map((problem) => problem.message).join("\n")).toContain(
      "'tools/gamma': the index records version 0.1.0, through the entry 'tools/gamma' as a " +
        "build dependency, and the manifest declares it with no range, through the entry " +
        "'tools/gamma' as a co-subscription"
    );
  });

  /**
   * Releasing other recipes never changes a published version's entry: not a
   * recipe its namespace gains, and not a newer version of a sibling it names.
   * The entry stays byte for byte what it was, with no error.
   *
   * publish(workflow/epsilon@0.1.0); publish(tools/gamma@0.2.0);
   * // -> omakase/house@0.1.0 unchanged
   */
  it("should leave a published version's entry unchanged while other recipes release", async () => {
    const before = houseEntryText();

    writeSetRepository([
      "omakase/house",
      "workflow/alpha",
      "workflow/beta",
      "tools/gamma",
      "workflow/epsilon",
    ]);
    writeSetRecipe("workflow/epsilon", "0.1.0");
    commitAll(repo, "add epsilon");
    await publish({ "workflow/epsilon": "0.1.0" });
    expect(houseEntryText()).toBe(before);

    writeSetRecipe("tools/gamma", "0.2.0");
    commitAll(repo, "raise gamma");
    await publish({ "tools/gamma": "0.2.0" });
    expect(houseEntryText()).toBe(before);

    const check = await regenerate();
    expect(errorsIn(check.problems)).toEqual([]);
    expect(check.stale).toBe(false);
  });

  /**
   * A new version of the set resolves afresh, against what is published when it
   * is released, while the older version keeps what it recorded.
   */
  it("should resolve a newly published version against the repository as it stands", async () => {
    writeSetRecipe("tools/gamma", "0.2.0");
    commitAll(repo, "raise gamma");
    await publish({ "tools/gamma": "0.2.0" });
    writeSetRecipe("omakase/house", "0.2.0", HOUSE);
    commitAll(repo, "raise the set");
    const index = await publish({ "omakase/house": "0.2.0" });

    const versions = index.recipes["omakase/house"]!.versions;
    expect(versions["0.1.0"]!.dependencies!["tools/gamma"]).toEqual(
      member("0.1.0", "tools/gamma")
    );
    expect(versions["0.2.0"]!.dependencies!["tools/gamma"]).toEqual(
      member("0.2.0", "tools/gamma")
    );
  });

  /**
   * A lost index is rebuilt from the tags, and each tagged version records the
   * dependencies it was released against: the repository as it stood at its
   * tag, not as it stands now.
   *
   * rm sous.index.json; buildIndex(...)
   * // -> house@0.1.0 still depends on tools/gamma 0.1.0, with no workflow/epsilon
   */
  it("should rebuild each tagged version's dependencies from its tag", async () => {
    writeSetRepository([
      "omakase/house",
      "workflow/alpha",
      "workflow/beta",
      "tools/gamma",
      "workflow/epsilon",
    ]);
    writeSetRecipe("workflow/epsilon", "0.1.0");
    writeSetRecipe("tools/gamma", "0.2.0");
    commitAll(repo, "add epsilon, raise gamma");
    await publish({ "workflow/epsilon": "0.1.0", "tools/gamma": "0.2.0" });
    writeSetRecipe("omakase/house", "0.2.0", HOUSE);
    commitAll(repo, "raise the set");
    const published = await publish({ "omakase/house": "0.2.0" });

    fs.rmSync(indexFilePath(repo));
    const rebuilt = await buildIndex({
      validation: validateRepo(repo),
      sousVersion: GENERATOR,
      now: new Date("2026-09-12T12:00:00.000Z"),
    });

    expect(errorsIn(rebuilt.problems)).toEqual([]);
    const house = rebuilt.index.recipes["omakase/house"]!.versions;
    expect(house["0.1.0"]!.dependencies).toEqual({
      "tools/gamma": member("0.1.0", "tools/gamma"),
      "workflow/alpha": member("0.1.0", "workflow"),
      "workflow/beta": member("0.1.0", "workflow"),
    });
    for (const [key, recipe] of Object.entries(published.recipes)) {
      for (const [version, entry] of Object.entries(recipe.versions)) {
        const again = rebuilt.index.recipes[key]!.versions[version]!;
        expect(again.dependencies).toEqual(entry.dependencies);
        expect(again.variables).toEqual(entry.variables);
        expect(again.subscribes).toEqual(entry.subscribes);
      }
    }
  });

  /**
   * An index whose published entry names a recipe the manifest names, or lists
   * one it does not declare, disagrees with the version it describes. That is an
   * error naming the recipe, the version and each difference, and telling the
   * author to bump rather than republish.
   */
  it("should report recorded dependencies that disagree with the manifest", async () => {
    editIndex((index) => {
      const dependencies = index.recipes["omakase/house"].versions["0.1.0"].dependencies;
      delete dependencies["tools/gamma"];
      dependencies["tools/ghost"] = { version: "1.0.0" };
    });

    const result = await regenerate();

    const errors = errorsIn(result.problems);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.where).toBe(
      "sous.index.json recipes['omakase/house'].versions['0.1.0'].dependencies"
    );
    expect(errors[0]!.message).toContain("version 0.1.0 of 'omakase/house' is already published");
    expect(errors[0]!.message).toContain(
      "'tools/gamma': the manifest declares it with no range, through the entry " +
        "'tools/gamma' as a co-subscription, and the index records nothing for it"
    );
    expect(errors[0]!.message).toContain(
      "'tools/ghost': the index records version 1.0.0, and the manifest does not declare it"
    );
    expect(errors[0]!.message).toContain("'sous repo release --bump patch'");
    // The recorded list is still carried forward, never rewritten.
    expect(
      result.index.recipes["omakase/house"]!.versions["0.1.0"]!.dependencies!["tools/ghost"]
    ).toEqual({ version: "1.0.0" });
  });

  /**
   * A sibling the manifest constrains with a range must be recorded at a
   * version inside it.
   *
   * subscribes: [tools/gamma@^0.1.0], recorded { tools/gamma: 0.2.0 } // -> error
   */
  it("should report a recorded sibling outside its declared range", async () => {
    writeSetRecipe("omakase/house", "0.1.0", "subscribes:\n  - tools/gamma@^0.1.0\n");
    git(repo, "tag", "--delete", "omakase/house@0.1.0");
    fs.rmSync(indexFilePath(repo));
    commitAll(repo, "republish the set with a range");
    await publish({ "omakase/house": "0.1.0" });
    editIndex((index) => {
      index.recipes["omakase/house"].versions["0.1.0"].dependencies["tools/gamma"] = {
        version: "0.2.0",
        declared: "tools/gamma@^0.1.0",
        kind: "subscribes",
      };
    });

    const result = await regenerate();

    expect(errorsIn(result.problems).map((problem) => problem.message).join("\n")).toContain(
      "'tools/gamma': the index records version 0.2.0, through the entry " +
        "'tools/gamma@^0.1.0' as a co-subscription, and the manifest declares the range '^0.1.0'"
    );
  });

  /**
   * A recipe the declared namespace held when the version was published, and
   * has since been retired, stays in that version's entry without an error: it
   * is history, not a disagreement.
   */
  it("should keep a retired namespace member without reporting it", async () => {
    writeSetRepository(["omakase/house", "workflow/alpha", "tools/gamma"]);
    commitAll(repo, "retire beta");
    const before = houseEntryText();

    const result = await regenerate();

    expect(errorsIn(result.problems)).toEqual([]);
    expect(
      JSON.stringify(result.index.recipes["omakase/house"]!.versions["0.1.0"])
    ).toBe(before);
  });

  /**
   * An entry recorded before sous wrote dependencies at all carries none, and a
   * consumer resolves that version's ranges instead. It is left exactly as it
   * is, and it is not an error.
   */
  it("should carry forward an entry published before dependencies were recorded", async () => {
    editIndex((index) => {
      delete index.recipes["omakase/house"].versions["0.1.0"].dependencies;
    });

    const result = await regenerate();

    expect(errorsIn(result.problems)).toEqual([]);
    expect(result.index.recipes["omakase/house"]!.versions["0.1.0"]!.dependencies).toBeUndefined();
  });

  /**
   * A field a later sous wrote into a published entry is carried forward with
   * it, so a release run by an older sous never strips it.
   */
  it("should carry forward fields this sous does not define", async () => {
    editIndex((index) => {
      const entry = index.recipes["omakase/house"].versions["0.1.0"];
      entry.futureVersionField = [{ name: "board" }];
      entry.dependencies["tools/gamma"].futureDependencyField = "tools/gamma";
    });

    const result = await regenerate();

    expect(errorsIn(result.problems)).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.text).toContain('"futureDependencyField": "tools/gamma"');
    expect(result.text).toContain('"futureVersionField"');
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
