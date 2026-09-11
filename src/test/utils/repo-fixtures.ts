/**
 * Builders for Repositories test data.
 *
 * A repo index is verbose to write out by hand, and almost every field is
 * irrelevant to any one test. These builders fill in valid values for
 * everything a test does not care about, so a spec can say just the part that
 * matters: which recipes exist, and at which versions.
 */

import type {
  IndexDependency,
  IndexFile,
} from "../../lib/repos/formats/index-file.js";

/** A valid but obviously fake content hash, keyed by a seed so entries differ. */
export function fakeHash(seed: string): string {
  let value = "";
  for (let index = 0; value.length < 64; index++) {
    value += Buffer.from(`${seed}:${index}`).toString("hex");
  }
  return `sha256-${value.slice(0, 64)}`;
}

/** How a recipe is described to the index builder: its versions, plus extras. */
export type RecipeSpec = {
  /** The versions this recipe publishes. */
  versions: string[];
  /** The recipe folder, relative to the repo root. Derived from the key by default. */
  path?: string;
  /** One-paragraph summary. */
  description?: string;
  /**
   * What each version was released against, keyed by version and then by the
   * recipe key it depends on. Left out entirely by default, which is what an
   * index written before resolved dependencies existed looks like.
   */
  dependencies?: Record<string, Record<string, IndexDependency>>;
};

/**
 * Builds a valid repo index from a compact description of its recipes.
 *
 * makeIndexFile("sous-recipes", { "workflow/task-files": { versions: ["1.0.0", "1.1.0"] } })
 *
 * Every version is marked as a prerelease when its version string carries one,
 * and its tag follows the `namespace/recipe@version` shape sous releases use.
 *
 * @param name - The repo's short name.
 * @param recipes - The recipes to publish, keyed `namespace/recipe`.
 */
export function makeIndexFile(
  name: string,
  recipes: Record<string, RecipeSpec | string[]>
): IndexFile {
  const namespaces: IndexFile["namespaces"] = {};
  const built: IndexFile["recipes"] = {};

  for (const [key, value] of Object.entries(recipes)) {
    const spec: RecipeSpec = Array.isArray(value) ? { versions: value } : value;
    const namespace = key.slice(0, key.indexOf("/"));
    namespaces[namespace] = {};

    const versions: Record<string, IndexFile["recipes"][string]["versions"][string]> = {};
    for (const version of spec.versions) {
      const dependencies = spec.dependencies?.[version];
      versions[version] = {
        hash: fakeHash(`${name}/${key}@${version}`),
        tag: `${key}@${version}`,
        prerelease: version.includes("-"),
        ...(dependencies === undefined ? {} : { dependencies }),
      };
    }

    built[key] = {
      path: spec.path ?? `recipes/${key}`,
      versions,
      ...(spec.description === undefined ? {} : { description: spec.description }),
    };
  }

  return {
    formatVersion: 1,
    name,
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "1.0.0",
    namespaces,
    recipes: built,
  };
}
