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
import { parseShortRef as parseRef } from "../refs/parse.js";
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
      [...indexes.keys()].map((name) => [
        name,
        {
          url: `https://github.com/sous-io/${name}`,
          identity: `github.com/sous-io/${name}`,
        },
      ])
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
   * The walk resolves refs in the order it meets them, so a recipe can be walked
   * at one version and walked again at a lower one once a second holder narrows
   * its range. The lower version is what the closure settles on, and the
   * dependencies discovered from the higher one must not survive: they are
   * content nothing asked for, and the lockfile would record a holder that does
   * not hold them.
   *
   * a depends on c (any version); b depends on c@1.x; c@2.0.0 depends on d.
   * resolveRefs([a, b]);  // -> c@1.9.0, and no d
   */
  it("should drop dependencies of a version a later holder replaced", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/a": ["1.0.0"],
          "workflow/b": ["1.0.0"],
          "core/c": ["1.9.0", "2.0.0"],
          "core/only-in-two": ["1.0.0"],
        }),
      },
      manifests: {
        "workflow/a": manifest("workflow/a", "1.0.0", { depends: ["core/c"] }),
        "workflow/b": manifest("workflow/b", "1.0.0", { depends: ["core/c@1.x"] }),
        "core/c@2.0.0": manifest("core/c", "2.0.0", { depends: ["core/only-in-two"] }),
        "core/c@1.9.0": manifest("core/c", "1.9.0"),
        "core/only-in-two": manifest("core/only-in-two", "1.0.0"),
      },
    });

    const result = await resolveRefs([ask("workflow/a"), ask("workflow/b")], context);
    const keys = result.resolved.map((entry) => entry.key).sort();

    expect(keys).toEqual(["core/c", "workflow/a", "workflow/b"]);
    expect(result.resolved.find((entry) => entry.key === "core/c")).toMatchObject({
      version: "1.9.0",
      requestedBy: ["workflow/a", "workflow/b"],
    });
  });

  /**
   * The reachability pass must not trim a recipe a namespace dependency reaches,
   * since a namespace ref means every recipe in it, exactly as the walk expanded
   * it.
   *
   * a depends on the whole `core` namespace.
   * resolveRefs([a]);  // -> a, plus every core recipe
   */
  it("should keep every recipe a namespace dependency reaches", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/a": ["1.0.0"],
          "core/one": ["1.0.0"],
          "core/two": ["1.0.0"],
        }),
      },
      manifests: {
        "workflow/a": manifest("workflow/a", "1.0.0", { depends: ["core"] }),
        "core/one": manifest("core/one", "1.0.0"),
        "core/two": manifest("core/two", "1.0.0"),
      },
    });

    const result = await resolveRefs([ask("workflow/a")], context);

    expect(result.resolved.map((entry) => entry.key).sort()).toEqual([
      "core/one",
      "core/two",
      "workflow/a",
    ]);
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
          depends: ["github://vendor/vendor-recipes/core/partials"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.missingRepos).toEqual([
      {
        name: "vendor-recipes",
        url: "https://github.com/vendor/vendor-recipes",
        identity: "github.com/vendor/vendor-recipes",
        provider: "github",
        requiredBy: [
          {
            ref: "github://vendor/vendor-recipes/core/partials",
            requestedBy: "workflow/task-files",
          },
        ],
      },
    ]);
    expect(result.resolved.map((recipe) => recipe.key)).toEqual(["workflow/task-files"]);
  });

  /**
   * A dependency naming another repository BY LOCATION resolves against
   * whatever short name the project gave that repository, because the location
   * is the identity and the short name is only a label.
   */
  it("should match a remote dependency to an added repository by identity", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
        "our-mirror": makeIndexFile("our-mirror", { "core/partials": ["1.0.0", "1.1.0"] }),
      },
      repos: {
        "sous-recipes": {
          url: "https://github.com/sous-io/sous-recipes",
          identity: "github.com/sous-io/sous-recipes",
        },
        "our-mirror": {
          url: "https://github.com/vendor/vendor-recipes",
          identity: "github.com/vendor/vendor-recipes",
        },
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["github://vendor/vendor-recipes/core/partials@^1.0.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.missingRepos).toEqual([]);
    expect(
      result.resolved.map((recipe) => `${recipe.repo}:${recipe.key}@${recipe.version}`)
    ).toEqual([
      "our-mirror:core/partials@1.1.0",
      "sous-recipes:workflow/task-files@1.0.0",
    ]);
  });

  /**
   * Every location form a manifest may write resolves the same way: an HTTPS
   * URL, a host path and an SSH remote with a `.git` suffix all name the same
   * added repository.
   *
   * depends: ["https://github.com/vendor/vendor-recipes/core/partials"]
   * // -> our-mirror:core/partials
   */
  it("should resolve a dependency written in any location form", async () => {
    for (const written of [
      "https://github.com/vendor/vendor-recipes/core/partials",
      "github.com/vendor/vendor-recipes.git/core/partials",
      "git@github.com:vendor/vendor-recipes.git/core/partials",
      "github://vendor/vendor-recipes/core/*",
    ]) {
      const context = makeContext({
        indexes: {
          "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
          "our-mirror": makeIndexFile("our-mirror", { "core/partials": ["1.0.0"] }),
        },
        repos: {
          "sous-recipes": {
            url: "https://github.com/sous-io/sous-recipes",
            identity: "github.com/sous-io/sous-recipes",
          },
          "our-mirror": {
            url: "https://github.com/vendor/vendor-recipes",
            identity: "github.com/vendor/vendor-recipes",
          },
        },
        manifests: {
          "workflow/task-files": manifest("workflow/task-files", "1.0.0", { depends: [written] }),
        },
      });

      const result = await resolveRefs([ask("workflow/task-files")], context);
      expect(result.resolved.map((recipe) => `${recipe.repo}:${recipe.key}`), written).toEqual([
        "our-mirror:core/partials",
        "sous-recipes:workflow/task-files",
      ]);
    }
  });

  /**
   * A browser URL is settled through the folder each recipe of the added
   * repository lives in, once the project has that repository's index.
   *
   * depends: ["https://github.com/vendor/vendor-recipes/tree/main/packages/partials"]
   * // -> our-mirror:core/partials, the recipe in packages/partials
   */
  it("should settle a browser URL dependency through the recipe folders", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
        "our-mirror": makeIndexFile("our-mirror", {
          "core/partials": { versions: ["1.0.0"], path: "packages/partials" },
          "core/other": ["1.0.0"],
        }),
      },
      repos: {
        "sous-recipes": {
          url: "https://github.com/sous-io/sous-recipes",
          identity: "github.com/sous-io/sous-recipes",
        },
        "our-mirror": {
          url: "https://github.com/vendor/vendor-recipes",
          identity: "github.com/vendor/vendor-recipes",
        },
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["https://github.com/vendor/vendor-recipes/tree/main/packages/partials@^1"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.resolved.map((recipe) => `${recipe.repo}:${recipe.key}`)).toEqual([
      "our-mirror:core/partials",
      "sous-recipes:workflow/task-files",
    ]);
    expect(result.resolved[0]!.ranges).toEqual([
      { range: "^1", requestedBy: "workflow/task-files" },
    ]);
  });

  /**
   * A browser URL naming no recipe folder in the repository is an error that
   * says so, and names the recipe that asked for it.
   *
   * depends: ["https://github.com/vendor/vendor-recipes/tree/main/docs"] // throws
   */
  it("should refuse a browser URL dependency that names no recipe", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
        "our-mirror": makeIndexFile("our-mirror", { "core/partials": ["1.0.0"] }),
      },
      repos: {
        "sous-recipes": { url: "https://github.com/sous-io/sous-recipes", identity: "github.com/sous-io/sous-recipes" },
        "our-mirror": { url: "https://github.com/vendor/vendor-recipes", identity: "github.com/vendor/vendor-recipes" },
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["https://github.com/vendor/vendor-recipes/tree/main/docs"],
        }),
      },
    });

    await expect(resolveRefs([ask("workflow/task-files")], context)).rejects.toThrow(
      /names a folder, and the index .* publishes no recipe there/
    );
  });

  /**
   * A dependency that reads more than one way (a GitLab nested group) resolves
   * to the reading the release recorded in the index, without probing.
   *
   * depends: ["gitlab://acme/team/recipes/core/partials"], index records
   * core/partials -> gitlab.com/acme/team
   * // -> the recipe core/partials in the project acme/team
   */
  it("should settle an ambiguous dependency by what the index recorded", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": {
            versions: ["1.0.0"],
            dependencies: {
              "1.0.0": { "recipes/core": { repo: "gitlab.com/acme/team", range: "*" } },
            },
          },
        }),
        team: makeIndexFile("team", { "recipes/core": ["1.0.0"] }),
      },
      repos: {
        "sous-recipes": { url: "https://github.com/sous-io/sous-recipes", identity: "github.com/sous-io/sous-recipes" },
        team: { url: "https://gitlab.com/acme/team", identity: "gitlab.com/acme/team" },
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["gitlab://acme/team/recipes/core"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.resolved.map((recipe) => `${recipe.repo}:${recipe.key}`)).toEqual([
      "team:recipes/core",
      "sous-recipes:workflow/task-files",
    ]);
  });

  /**
   * With nothing recorded, a reading whose repository is already added and
   * whose cached index publishes it settles the dependency; with nothing known
   * either, the dependency is an error listing every reading.
   *
   * depends: ["gitlab://acme/team/recipes/core"], nothing recorded, nothing added
   * // throws "... can be read 2 ways ..."
   */
  it("should settle an ambiguous dependency by what is known, or refuse it", async () => {
    const base = {
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["gitlab://acme/team/recipes/core"],
        }),
      },
    };

    const known = await resolveRefs(
      [ask("workflow/task-files")],
      makeContext({
        ...base,
        indexes: {
          "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
          team: makeIndexFile("team", { "recipes/core": ["1.0.0"] }),
        },
        repos: {
          "sous-recipes": { url: "https://github.com/sous-io/sous-recipes", identity: "github.com/sous-io/sous-recipes" },
          team: { url: "https://gitlab.com/acme/team", identity: "gitlab.com/acme/team" },
        },
      })
    );
    expect(known.resolved.map((recipe) => recipe.key)).toEqual(["recipes/core", "workflow/task-files"]);

    await expect(
      resolveRefs(
        [ask("workflow/task-files")],
        makeContext({
          ...base,
          indexes: {
            "sous-recipes": makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] }),
          },
        })
      )
    ).rejects.toThrow(/can be read 2 ways[\s\S]*gitlab:\/\/acme\/team\/-\/recipes\/core/);
  });

  /**
   * When the index records what a version was released against, that exact
   * version is installed, whatever the manifest's range would reach today.
   */
  it("should install the version the index resolved a dependency to", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": {
            versions: ["1.0.0"],
            dependencies: { "1.0.0": { "core/partials": { version: "1.0.0" } } },
          },
          "core/partials": ["1.0.0", "1.1.0"],
        }),
      },
      manifests: {
        "workflow/task-files": manifest("workflow/task-files", "1.0.0", {
          depends: ["core/partials@^1.0.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], context);

    expect(result.resolved.find((recipe) => recipe.key === "core/partials")!.version).toBe(
      "1.0.0"
    );
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
   * A recipe whose manifest the loader cannot produce is walked from its index
   * entry when the entry records the manifest's lists, exactly as its manifest
   * would be walked: a namespace entry expands to the namespace as it stands
   * (here gaining workflow/b, published after the set), a pinned dependency
   * keeps its recorded version, and the version's recorded variable
   * definitions travel with it. Only a recipe whose entry records nothing is
   * reported as unreadable.
   *
   * omakase/house@1.0.0 records depends [tools/c], subscribes [workflow]
   * // -> house, tools/c 1.0.0 (depends), workflow/a and workflow/b (subscribes)
   */
  it("should walk a recipe from its index entry when its manifest cannot be loaded", async () => {
    const index = makeIndexFile("sous-recipes", {
      "omakase/house": {
        versions: ["1.0.0"],
        dependencies: {
          "1.0.0": {
            "workflow/a": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
            "tools/c": { version: "1.0.0", declared: "tools/c", kind: "depends" },
          },
        },
      },
      "workflow/a": ["1.0.0"],
      "workflow/b": ["1.0.0"],
      "tools/c": ["1.0.0", "2.0.0"],
    });
    const variables = [
      {
        name: "houseName",
        type: "string" as const,
        prompt: "What is the house called?",
        description: "The name every skill in the set signs with.",
        example: "Harbor",
        required: true,
        secret: false,
        scope: "shared" as const,
      },
    ];
    const house = index.recipes["omakase/house"]!.versions["1.0.0"]!;
    house.variables = variables;
    house.depends = ["tools/c"];
    house.subscribes = ["workflow"];
    const context = makeContext({ indexes: { "sous-recipes": index } });

    const result = await resolveRefs([ask("omakase/house")], context);

    expect(
      result.resolved.map((recipe) => [recipe.key, recipe.version, recipe.kind])
    ).toEqual([
      ["omakase/house", "1.0.0", "subscribes"],
      ["tools/c", "1.0.0", "depends"],
      ["workflow/a", "1.0.0", "subscribes"],
      ["workflow/b", "1.0.0", "subscribes"],
    ]);
    expect(result.resolved[0]!.variables).toEqual(variables);
    expect(result.missingManifests).toEqual(["tools/c", "workflow/a", "workflow/b"]);
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

describe("resolveRefs() with held versions", () => {
  /**
   * A held version is chosen over a newer one for as long as every range still
   * allows it; that is how an update moves only the pins it was asked to move.
   *
   * resolveRefs([ask("workflow/task-files")], { ...ctx, keep: { "workflow/task-files": "1.0.0" } })
   * // -> version 1.0.0, although 1.2.0 is published
   */
  it("should keep a held version that every range still allows", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0", "1.2.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], {
      ...context,
      keep: { "workflow/task-files": "1.0.0" },
    });

    expect(result.resolved[0]?.version).toBe("1.0.0");
  });

  /**
   * A range that no longer allows the held version wins, and the newest
   * version it does allow is chosen as usual.
   *
   * resolveRefs([ask("workflow/task-files@^2.0.0")], { ...ctx, keep: { "workflow/task-files": "1.0.0" } })
   * // -> version 2.1.0
   */
  it("should move a held version that a range no longer allows", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.0.0", "2.0.0", "2.1.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files@^2.0.0")], {
      ...context,
      keep: { "workflow/task-files": "1.0.0" },
    });

    expect(result.resolved[0]?.version).toBe("2.1.0");
  });

  /**
   * A held version the index no longer publishes cannot be kept, and the
   * newest satisfying version is chosen instead.
   *
   * resolveRefs([ask("workflow/task-files")], { ...ctx, keep: { "workflow/task-files": "1.0.0" } })
   * // -> version 1.2.0, when only 1.1.0 and 1.2.0 are published
   */
  it("should ignore a held version the index does not publish", async () => {
    const context = makeContext({
      indexes: {
        "sous-recipes": makeIndexFile("sous-recipes", {
          "workflow/task-files": ["1.1.0", "1.2.0"],
        }),
      },
    });

    const result = await resolveRefs([ask("workflow/task-files")], {
      ...context,
      keep: { "workflow/task-files": "1.0.0" },
    });

    expect(result.resolved[0]?.version).toBe("1.2.0");
  });
});
