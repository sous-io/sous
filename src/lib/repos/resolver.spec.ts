/**
 * Unit tests for the resolver, against hand-built indexes. Nothing here reads a
 * file or reaches a network: the indexes are literals and the manifest loader
 * is a map lookup.
 */

import { describe, it, expect } from "vitest";
import {
  PROJECT_REQUESTER,
  resolveRefs,
  type RecipeManifestLoader,
  type ResolveContext,
  type ResolverRepo,
} from "./resolver.js";
import { parseRef } from "./ref.js";
import type { IndexFile } from "./formats/index-file.js";
import type { RecipeManifest } from "./formats/recipe-manifest.js";
import { makeIndexFile } from "../../test/utils/repo-fixtures.js";

/** Builds a manifest with only the fields the resolver reads. */
function manifest(
  key: string,
  version: string,
  extra: { depends?: string[]; subscribes?: string[] } = {}
): RecipeManifest {
  const [namespace, name] = key.split("/") as [string, string];
  return {
    formatVersion: 1,
    namespace,
    name,
    version,
    contents: [],
    ...extra,
  } as RecipeManifest;
}

/** Builds a resolve context from indexes, with a manifest loader keyed by recipe. */
function makeContext(options: {
  indexes: Record<string, IndexFile>;
  manifests?: Record<string, RecipeManifest>;
  repos?: Record<string, ResolverRepo>;
  prerelease?: boolean;
}): ResolveContext {
  const indexes = new Map(Object.entries(options.indexes));
  const repos: Record<string, ResolverRepo> =
    options.repos ??
    Object.fromEntries(
      [...indexes.keys()].map((name) => [name, { url: `https://github.com/sous-io/${name}` }])
    );
  const loadManifest: RecipeManifestLoader = (recipe) =>
    options.manifests?.[`${recipe.key}@${recipe.version}`] ?? options.manifests?.[recipe.key];

  return {
    indexes,
    repos,
    loadManifest,
    ...(options.prerelease === undefined ? {} : { prerelease: options.prerelease }),
  };
}

/** The one-line request shape most tests use. */
function ask(ref: string, requestedBy: string = PROJECT_REQUESTER) {
  return { ref: parseRef(ref), requestedBy };
}

describe("resolveRefs()", () => {
  /**
   * A plain recipe ref resolves to the highest published version, carries the
   * index's hash, tag and folder, and records who asked for it.
   *
   * resolveRefs([{ ref: parseRef("workflow/task-files"), requestedBy: "project" }], ctx)
   * // -> resolved[0] = { key: "workflow/task-files", version: "1.2.0", ... }
   */
  it("should resolve a recipe to its highest published version", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0", "1.2.0", "1.1.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      key: "workflow/task-files",
      repo: "sous-recipes",
      version: "1.2.0",
      tag: "workflow/task-files@1.2.0",
      path: "recipes/workflow/task-files",
      kind: "subscribes",
      requestedBy: ["project"],
    });
    expect(result.missingRepos).toEqual([]);
  });

  /**
   * A version range narrows the choice, exactly as npm's ranges do.
   *
   * resolveRefs([ask("workflow/task-files@^1.0.0")], ctx) // -> version 1.2.0, not 2.0.0
   */
  it("should honor a version range", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0", "1.2.0", "2.0.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files@^1.0.0")], context);

    expect(result.resolved[0]?.version).toBe("1.2.0");
  });

  /**
   * Prereleases stay out of range matching unless the request opts in, and the
   * error for an unsatisfiable range says so.
   */
  it("should exclude prereleases unless they are opted into", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0", "2.0.0-beta.1"],
        }),
      },
    });

    const without = await resolveRefs([ask("workflow/task-files")], context);
    expect(without.resolved[0]?.version).toBe("1.0.0");

    const withPrerelease = await resolveRefs(
      [{ ...ask("workflow/task-files"), prerelease: true }],
      context
    );
    expect(withPrerelease.resolved[0]?.version).toBe("2.0.0-beta.1");
  });

  /**
   * An unsatisfiable range names every version the repository publishes, so the
   * next step is obvious.
   */
  it("should raise a ConfigError naming the available versions", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0", "1.2.0"] }),
      },
    });

    await expect(resolveRefs([ask("workflow/task-files@^3.0.0")], context)).rejects.toThrow(
      /Versions this repository publishes: 1\.2\.0, 1\.0\.0/
    );
  });

  /**
   * A ref published by two added repositories is never resolved by picking a
   * winner: the error names both and shows the qualified form for each.
   */
  it("should refuse an ambiguous ref and show the qualified forms", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
        "team-recipes": makeIndexFile("team-recipes", { "workflow/task-files": ["2.0.0"] }),
      },
    });

    const promise = resolveRefs([ask("workflow/task-files")], context);
    await expect(promise).rejects.toThrow(/published by more than one added repository/);
    await promise.catch((error: unknown) => {
      expect((error as Error).message).toContain("sous-recipes:workflow/task-files");
      expect((error as Error).message).toContain("team-recipes:workflow/task-files");
    });
  });

  /**
   * The repo qualifier settles the ambiguity.
   */
  it("should resolve an ambiguous ref once it is qualified", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
        "team-recipes": makeIndexFile("team-recipes", { "workflow/task-files": ["2.0.0"] }),
      },
    });

    const result = await resolveRefs([ask("team-recipes:workflow/task-files")], context);

    expect(result.resolved[0]).toMatchObject({ repo: "team-recipes", version: "2.0.0" });
  });

  /**
   * A namespace ref means every recipe in that namespace, including any added
   * later, so it expands at resolution time.
   */
  it("should expand a namespace ref into every recipe in it", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0"],
          "workflow/github-projects": ["2.0.0"],
          "quality/reviews": ["1.0.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow")], context);

    expect(result.resolved.map((recipe) => recipe.key)).toEqual([
      "workflow/github-projects",
      "workflow/task-files",
    ]);
  });

  /**
   * A ref no added repository publishes is an error naming the repositories
   * that were searched.
   */
  it("should raise a ConfigError for a ref nothing publishes", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
      },
    });

    await expect(resolveRefs([ask("quality/reviews")], context)).rejects.toThrow(
      /No added repository publishes the recipe 'quality\/reviews'/
    );
  });

  /**
   * The dependency closure follows both lists: `depends` and `subscribes`. Each
   * resolved recipe records the recipe that pulled it in.
   */
  it("should walk depends and subscribes, recording who asked", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0"],
          "core/partials": ["1.0.0"],
          "communication/control-flow": ["1.0.0"],
        }),
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["core/partials"],
          subscribes: ["communication/control-flow"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    const byKey = Object.fromEntries(result.resolved.map((recipe) => [recipe.key, recipe]));
    expect(Object.keys(byKey).sort()).toEqual([
      "communication/control-flow",
      "core/partials",
      "workflow/task-files",
    ]);
    expect(byKey["core/partials"]).toMatchObject({
      kind: "depends",
      requestedBy: ["workflow/task-files"],
    });
    expect(byKey["communication/control-flow"]).toMatchObject({
      kind: "subscribes",
      requestedBy: ["workflow/task-files"],
    });
  });

  /**
   * Two holders of one recipe both appear under requestedBy, and the ranges
   * they asked for have to hold at once.
   */
  it("should satisfy every range asked for by every holder", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0"],
          "core/partials": ["1.0.0", "1.5.0", "2.0.0"],
        }),
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["core/partials@^1.0.0"],
        }),
      },
    });

    const result = await resolveRefs(
      [ask("workflow/task-files"), ask("core/partials@>=1.2.0")],
      context
    );

    const partials = result.resolved.find((recipe) => recipe.key === "core/partials");
    expect(partials).toMatchObject({ version: "1.5.0", kind: "subscribes" });
    expect(partials?.requestedBy).toEqual(["project", "workflow/task-files"]);
  });

  /**
   * Ranges that cannot both hold are an error naming each range and who asked
   * for it.
   */
  it("should raise when two holders ask for incompatible ranges", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0"],
          "core/partials": ["1.0.0", "2.0.0"],
        }),
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["core/partials@^1.0.0"],
        }),
      },
    });

    const promise = resolveRefs([ask("workflow/task-files"), ask("core/partials@^2.0.0")], context);
    await expect(promise).rejects.toThrow(/No published version of 'core\/partials'/);
    await promise.catch((error: unknown) => {
      expect((error as Error).message).toContain("required by workflow/task-files");
      expect((error as Error).message).toContain("required by project");
    });
  });

  /**
   * A dependency on a repository the project has not added never downloads
   * anything. It comes back as a missing repository carrying its provenance, so
   * the trust layer can ask about it by name.
   */
  it("should report a repository a dependency needs but the project has not added", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["vendor-recipes:core/partials"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.missingRepos).toEqual([
      {
        name: "vendor-recipes",
        requiredBy: [
          { ref: "vendor-recipes:core/partials", requestedBy: "workflow/task-files" },
        ],
      },
    ]);
    expect(result.resolved.map((recipe) => recipe.key)).toEqual(["workflow/task-files"]);
  });

  /**
   * A recipe whose manifest the loader cannot produce is reported rather than
   * guessed at; its dependencies stay unknown until it is fetched.
   */
  it("should report a resolved recipe whose manifest could not be loaded", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.missingManifests).toEqual(["workflow/task-files"]);
  });

  /**
   * Two recipes that depend on each other terminate rather than looping, and
   * the cycle is reported as the chain that formed it.
   */
  it("should terminate on a dependency cycle and report the chain", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "core/one": ["1.0.0"],
          "core/two": ["1.0.0"],
        }),
      },
      manifests: {
        "core/one": manifest("core/one", "1.0.0", { depends: ["core/two"] }),
        "core/two": manifest("core/two", "1.0.0", { depends: ["core/one"] }),
      },
    });

    const result = await resolveRefs([ask("core/one")], context);

    expect(result.resolved.map((recipe) => recipe.key)).toEqual(["core/one", "core/two"]);
    expect(result.cycles).toEqual([["core/one", "core/two", "core/one"]]);
  });
});
