import { describe, it, expect } from "vitest";
import { parseRepoManifest, repoManifestSchema } from "./repo-manifest.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the repo manifest schema (`sous.repo.yaml`).
 */

const SOURCE = "/repo/sous.repo.yaml";

/** A minimal manifest that passes, used as the base for rejection cases. */
function validManifest() {
  return {
    formatVersion: 1,
    name: "sous-recipes",
    description: "The official sous recipe repository.",
    contribute: "https://github.com/sous-io/sous-recipes/blob/main/CONTRIBUTING.md",
    namespaces: {
      core: { description: "Skills that teach agents about sous itself." },
      workflow: {},
    },
    recipes: ["recipes/core/sous-skills", "recipes/workflow/task-files"],
  };
}

/** Runs parseRepoManifest and returns the ConfigError message, or fails. */
function expectRejectMessage(value: unknown): string {
  try {
    parseRepoManifest(value, SOURCE);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected parseRepoManifest to throw, but it returned");
}

describe("parseRepoManifest()", () => {
  /**
   * A complete manifest exercising every field parses and is returned intact.
   *
   * parseRepoManifest(manifest, "/repo/sous.repo.yaml");  // -> the manifest
   */
  it("should accept a manifest using every field", () => {
    const manifest = validManifest();
    expect(parseRepoManifest(manifest, SOURCE)).toEqual(manifest);
  });

  /**
   * Only `formatVersion`, `name`, `namespaces` and `recipes` are required; a
   * repo with no description and no recipes yet is still valid.
   */
  it("should accept a manifest with only the required fields", () => {
    const manifest = {
      formatVersion: 1,
      name: "team-recipes",
      namespaces: { workflow: {} },
      recipes: [],
    };
    expect(parseRepoManifest(manifest, SOURCE)).toEqual(manifest);
  });

  /**
   * Keys in the reserved `x-` extension namespace are accepted and dropped, so
   * a repo may carry metadata sous does not know about.
   */
  it("should accept and drop x- extension keys", () => {
    const manifest = { ...validManifest(), "x-team": { owner: "platform" } };
    const parsed = parseRepoManifest(manifest, SOURCE);
    expect(parsed).not.toHaveProperty("x-team");
    expect(parsed.name).toBe("sous-recipes");
  });

  /**
   * An unknown top-level key is a typo, not an extension, and is rejected with
   * a message naming the file and the key.
   */
  it("should reject an unknown top-level key", () => {
    const message = expectRejectMessage({ ...validManifest(), recipies: [] });
    expect(message).toContain(`Invalid repo manifest at ${SOURCE}:`);
    expect(message).toContain("unknown key 'recipies' at the top level");
  });

  /**
   * A missing formatVersion is rejected; every Repositories format carries one
   * from day one.
   */
  it("should reject a manifest with no formatVersion", () => {
    const manifest = validManifest() as Record<string, unknown>;
    delete manifest.formatVersion;
    expect(expectRejectMessage(manifest)).toContain("formatVersion");
  });

  /**
   * A future format version is rejected with a message saying this sous
   * understands no other version.
   */
  it("should reject an unsupported formatVersion", () => {
    const message = expectRejectMessage({ ...validManifest(), formatVersion: 2 });
    expect(message).toContain("formatVersion: must be 1");
  });

  /**
   * Repo, namespace and recipe names are lowercase kebab-case.
   */
  it("should reject a name that is not kebab-case", () => {
    expect(expectRejectMessage({ ...validManifest(), name: "Sous_Recipes" })).toContain(
      "name: a repo name must be lowercase kebab-case"
    );
  });

  /**
   * A namespace key that is not kebab-case is rejected, so the key that appears
   * in a ref is always a legal ref segment.
   */
  it("should reject a namespace key that is not kebab-case", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      namespaces: { "Tool Usage": {} },
    });
    expect(message).toContain("namespace name must be lowercase kebab-case");
  });

  /**
   * A recipe path must stay inside the repo, so traversal and absolute paths
   * are rejected.
   */
  it("should reject a recipe path that escapes the repo root", () => {
    for (const bad of ["../elsewhere/recipe", "/etc/recipe", "recipes/../../escape"]) {
      const message = expectRejectMessage({ ...validManifest(), recipes: [bad] });
      expect(message).toContain("recipes[0]: a recipe path must");
    }
  });

  /**
   * Listing the same recipe folder twice is a mistake, and the message names
   * the duplicate.
   */
  it("should reject a duplicated recipe path", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      recipes: ["recipes/a", "recipes/a"],
    });
    expect(message).toContain("recipes[1]: the recipe path 'recipes/a' is listed more than once");
  });

  /**
   * An unknown key inside a namespace declaration is reported with its path, so
   * the author knows exactly which namespace is wrong.
   */
  it("should reject an unknown key inside a namespace declaration", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      namespaces: { core: { descrption: "typo" } },
    });
    expect(message).toContain("unknown key 'descrption' under 'namespaces.core'");
  });

  /**
   * An empty contribute pointer is worse than none, so it is rejected.
   */
  it("should reject an empty contribute pointer", () => {
    expect(expectRejectMessage({ ...validManifest(), contribute: "" })).toContain(
      "contribute:"
    );
  });
});

describe("repoManifestSchema", () => {
  /**
   * The schema itself is exported for callers that want zod's safeParse result
   * rather than a thrown ConfigError.
   *
   * repoManifestSchema.safeParse(manifest).success;  // -> true
   */
  it("should be usable directly through safeParse", () => {
    expect(repoManifestSchema.safeParse(validManifest()).success).toBe(true);
    expect(repoManifestSchema.safeParse({}).success).toBe(false);
  });
});
