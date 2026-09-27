/**
 * Unit tests for the submission changelog: the comparison itself is pure and
 * is tested on manifests built in memory; reading the default branch's
 * manifests runs real git against a temporary repository.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import {
  parseRecipeManifest,
  type RecipeManifest,
  type VariableDefinition,
} from "../formats/recipe-manifest.js";
import { parseRepoManifest } from "../formats/repo-manifest.js";
import {
  BREAKING_VARIABLE_WARNING,
  buildChangelog,
  changelogIsEmpty,
  compareVariables,
  composeProposalBody,
  isTightened,
  readManifestsAt,
  renderChangelog,
  snapshotOf,
  type ManifestSnapshot,
} from "./changelog.js";
import { validateRepo } from "./validate.js";

/** A recipe manifest, parsed the way sous parses one. */
function recipe(key: string, version: string, extra: Record<string, unknown> = {}): RecipeManifest {
  const [namespace, name] = key.split("/");
  return parseRecipeManifest({ formatVersion: 1, namespace, name, version, ...extra }, key);
}

/** A variable definition with the required fields filled in. */
function variable(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    type: "string",
    prompt: `What is ${name}?`,
    description: `The ${name} setting.`,
    example: "value",
    ...extra,
  };
}

/** A snapshot of a repository holding the given namespaces and recipes. */
function snapshot(namespaces: string[], recipes: RecipeManifest[]): ManifestSnapshot {
  const repo = parseRepoManifest(
    {
      formatVersion: 1,
      name: "test-repo",
      namespaces: Object.fromEntries(namespaces.map((entry) => [entry, {}])),
      recipes: recipes.map((entry) => `recipes/${entry.namespace}/${entry.name}`),
    },
    "sous.repo.yaml"
  );
  return {
    repo,
    recipes: new Map(
      recipes.map((entry) => [
        `${entry.namespace}/${entry.name}`,
        { path: `recipes/${entry.namespace}/${entry.name}`, manifest: entry },
      ])
    ),
  };
}

/** A parsed variable definition. */
function parsedVariable(name: string, extra: Record<string, unknown> = {}): VariableDefinition {
  return recipe("core/x", "1.0.0", { variables: [variable(name, extra)] }).variables![0]!;
}

describe("buildChangelog()", () => {
  /**
   * Every kind of change the manifests can show is listed: recipes added and
   * retired (a rename is one of each), version changes, files changed without
   * a raise, namespaces added and removed, and variables.
   */
  it("should list every kind of change against the default branch", () => {
    const base = snapshot(
      ["core", "old"],
      [
        recipe("core/kept", "1.0.0"),
        recipe("core/raised", "1.0.0"),
        recipe("core/renamed", "2.0.0"),
        recipe("old/gone", "0.3.0"),
      ]
    );
    const head = snapshot(
      ["core", "fresh"],
      [
        recipe("core/kept", "1.0.0", { variables: [variable("apiUrl")] }),
        recipe("core/raised", "1.1.0"),
        recipe("core/new-name", "2.0.0"),
        recipe("fresh/brand-new", "0.1.0"),
      ]
    );

    const changelog = buildChangelog({
      baseBranch: "main",
      base,
      head,
      changedPaths: ["recipes/core/kept/skills/one.md"],
    });

    expect(changelog.recipesAdded).toEqual([
      { key: "core/new-name", version: "2.0.0" },
      { key: "fresh/brand-new", version: "0.1.0" },
    ]);
    expect(changelog.recipesRemoved).toEqual([
      { key: "core/renamed", version: "2.0.0" },
      { key: "old/gone", version: "0.3.0" },
    ]);
    expect(changelog.versionChanges).toEqual([{ key: "core/raised", from: "1.0.0", to: "1.1.0" }]);
    expect(changelog.unraised).toEqual([{ key: "core/kept", version: "1.0.0", next: "1.0.1" }]);
    expect(changelog.namespacesAdded).toEqual(["fresh"]);
    expect(changelog.namespacesRemoved).toEqual(["old"]);
    expect(changelog.variables).toEqual([
      { recipe: "core/kept", name: "apiUrl", change: "added", breaking: false },
    ]);
  });

  /**
   * With nothing to compare with, the changelog says so and lists nothing.
   */
  it("should list nothing when there is no default branch to compare with", () => {
    const changelog = buildChangelog({
      baseBranch: "main",
      base: undefined,
      head: snapshot(["core"], [recipe("core/x", "1.0.0")]),
      changedPaths: [],
    });

    expect(changelog.compared).toBe(false);
    expect(changelogIsEmpty(changelog)).toBe(true);
    expect(renderChangelog(changelog)).toMatch(/could not compare this change with the branch 'main'/);
  });
});

describe("compareVariables()", () => {
  /**
   * A removed variable is always flagged as breaking; a changed one is flagged
   * only when it accepts less than before.
   */
  it("should flag removals and tightening, and nothing else", () => {
    const changes = compareVariables(
      "core/x",
      [
        parsedVariable("gone") as VariableDefinition,
        parsedVariable("reworded"),
        parsedVariable("narrowed", { validate: { maxLength: 20 } }),
      ],
      [
        parsedVariable("reworded", { prompt: "Say it differently?" }),
        parsedVariable("narrowed", { validate: { maxLength: 10 } }),
      ]
    );

    expect(changes).toEqual([
      { recipe: "core/x", name: "reworded", change: "changed", fields: ["prompt"], breaking: false },
      { recipe: "core/x", name: "narrowed", change: "changed", fields: ["validate"], breaking: true },
      { recipe: "core/x", name: "gone", change: "removed", breaking: true },
    ]);
  });
});

describe("isTightened()", () => {
  /**
   * Each way a rule can reject something it used to accept counts as
   * tightening; loosening does not.
   *
   * isTightened(before({ min: 1 }), after({ min: 5 }));  // -> true
   */
  it("should recognize every way a definition can accept less", () => {
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>, boolean]> = [
      [{}, { validate: { pattern: "^a" } }, true],
      [{ validate: { minLength: 1 } }, { validate: { minLength: 3 } }, true],
      [{ validate: { maxLength: 9 } }, { validate: { maxLength: 3 } }, true],
      [{ validate: { min: 1 } }, { validate: { min: 5 } }, true],
      [{ validate: { max: 9 } }, { validate: { max: 5 } }, true],
      [{ required: false }, { required: true }, true],
      [{ type: "string" }, { type: "url", example: "https://example.com" }, true],
      [
        { type: "enum", example: "a", validate: { enum: ["a", "b"] } },
        { type: "enum", example: "a", validate: { enum: ["a"] } },
        true,
      ],
      [{ validate: { maxLength: 3 } }, { validate: { maxLength: 9 } }, false],
      [{ required: true }, { required: false }, false],
      [{}, { prompt: "Reworded?" }, false],
    ];

    for (const [before, after, expected] of pairs) {
      expect(isTightened(parsedVariable("v", before), parsedVariable("v", after))).toBe(expected);
    }
  });
});

describe("renderChangelog()", () => {
  /**
   * The rendered changelog carries a section for each kind of change and the
   * major-change warning when a variable change is breaking.
   */
  it("should render the sections and the warning as Markdown", () => {
    const base = snapshot(["core"], [recipe("core/x", "1.0.0", { variables: [variable("gone")] })]);
    const head = snapshot(["core"], [recipe("core/x", "2.0.0")]);

    const text = renderChangelog(
      buildChangelog({ baseBranch: "main", base, head, changedPaths: [] })
    );

    expect(text).toContain("## What merging this changes");
    expect(text).toContain("**Version changes**");
    expect(text).toContain("`core/x`: 1.0.0 becomes 2.0.0");
    expect(text).toContain("the variable `gone` was removed");
    expect(text).toContain(BREAKING_VARIABLE_WARNING);
    expect(text).not.toContain("\u2014");
  });

  /**
   * A change the manifests do not show says that merging changes nothing a
   * subscriber sees.
   */
  it("should say when merging changes nothing the manifests describe", () => {
    const same = snapshot(["core"], [recipe("core/x", "1.0.0")]);

    const text = renderChangelog(
      buildChangelog({ baseBranch: "main", base: same, head: same, changedPaths: [] })
    );

    expect(text).toContain("Merging changes no recipe, namespace, version or variable.");
  });
});

describe("composeProposalBody()", () => {
  /**
   * The body is the contributor's description, then the changelog.
   */
  it("should put the description before the changelog", () => {
    const same = snapshot(["core"], [recipe("core/x", "1.0.0")]);
    const changelog = buildChangelog({ baseBranch: "main", base: same, head: same, changedPaths: [] });

    expect(composeProposalBody("  Why this matters.  ", changelog)).toMatch(
      /^Why this matters\.\n\n## What merging this changes/
    );
  });
});

describe("readManifestsAt()", () => {
  let tmp: TmpDir;
  let repo: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-changelog-");
    repo = path.join(tmp.path, "recipes");
    fs.mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeFile(
      repo,
      "sous.repo.yaml",
      "formatVersion: 1\nname: test-repo\nnamespaces:\n  core: {}\nrecipes:\n  - recipes/core/example\n"
    );
    writeFile(
      repo,
      "recipes/core/example/sous.recipe.json",
      '{ "formatVersion": 1, "namespace": "core", "name": "example", "version": "1.0.0" }\n'
    );
    commitAll(repo, "first");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * The manifests are read as they stood at the commit, whatever the working
   * tree holds now, and in whichever supported format each one was written.
   */
  it("should read the manifests as a commit holds them", async () => {
    const first = git(repo, "rev-parse", "HEAD");
    writeFile(
      repo,
      "recipes/core/example/sous.recipe.json",
      '{ "formatVersion": 1, "namespace": "core", "name": "example", "version": "2.0.0" }\n'
    );
    commitAll(repo, "second");

    const then = await readManifestsAt(repo, first);
    const now = snapshotOf(validateRepo(repo));

    expect(then?.recipes.get("core/example")?.manifest.version).toBe("1.0.0");
    expect(now.recipes.get("core/example")?.manifest.version).toBe("2.0.0");
  });

  /**
   * A commit with no repo manifest has nothing to compare with.
   */
  it("should return undefined for a commit with no repo manifest", async () => {
    git(repo, "rm", "--quiet", "sous.repo.yaml");
    commitAll(repo, "remove it");

    expect(await readManifestsAt(repo, git(repo, "rev-parse", "HEAD"))).toBeUndefined();
  });
});
