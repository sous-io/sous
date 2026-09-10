import { describe, it, expect } from "vitest";
import { indexFileSchema, parseIndexFile, stringifyIndexFile } from "./index-file.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the repo index (`sous.index.json`), the machine-written file
 * that every provider hands back and that sous resolves refs against.
 */

const SOURCE = "/repo/sous.index.json";
const HASH = `sha256-${"a".repeat(64)}`;

/** A valid index, used as the base for rejection cases. */
function validIndex() {
  return {
    formatVersion: 1,
    name: "sous-recipes",
    generatedAt: "2026-09-09T14:03:11.482Z",
    generator: "0.2.0",
    namespaces: {
      core: { description: "Skills that teach agents about sous itself." },
      workflow: {},
    },
    recipes: {
      "workflow/task-files": {
        path: "recipes/workflow/task-files",
        description: "Per-branch task file workflow.",
        versions: {
          "1.0.0": {
            hash: HASH,
            tag: "workflow/task-files@1.0.0",
            prerelease: false,
            releasedAt: "2026-08-01T09:00:00.000Z",
          },
          "1.1.0-beta.1": {
            hash: HASH,
            tag: "workflow/task-files@1.1.0-beta.1",
            prerelease: true,
          },
        },
      },
    },
  };
}

/** Runs parseIndexFile and returns the ConfigError message, or fails. */
function expectRejectMessage(value: unknown): string {
  try {
    parseIndexFile(value, SOURCE);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected parseIndexFile to throw, but it returned");
}

describe("parseIndexFile()", () => {
  /**
   * A complete index parses and is returned intact.
   */
  it("should accept an index using every field", () => {
    const index = validIndex();
    expect(parseIndexFile(index, SOURCE)).toEqual(index);
  });

  /**
   * The index is machine-written, so unknown keys are always a bug rather than
   * a forward-compatible extension. There is no `x-` escape hatch here.
   */
  it("should reject an unknown key", () => {
    const message = expectRejectMessage({ ...validIndex(), "x-extra": true });
    expect(message).toContain(`Invalid repo index at ${SOURCE}:`);
    expect(message).toContain("unknown key 'x-extra'");
  });

  /**
   * A recipe key is always two segments; a bare namespace is not a recipe.
   */
  it("should reject a recipe key that is not namespace and recipe", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: { workflow: index.recipes["workflow/task-files"] },
    });
    expect(message).toContain("invalid key; a recipe key must be a namespace and recipe");
  });

  /**
   * A recipe whose namespace the index does not declare could never be
   * resolved, so it is rejected with both names shown.
   */
  it("should reject a recipe in an undeclared namespace", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      namespaces: { core: {} },
    });
    expect(message).toContain("recipes.workflow/task-files:");
    expect(message).toContain("namespace 'workflow', which this index does not declare");
  });

  /**
   * Version keys are exact semantic versions; a range key would make lookups
   * ambiguous.
   */
  it("should reject a version key that is not an exact version", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          versions: { "^1.0.0": { hash: HASH, tag: "t", prerelease: false } },
        },
      },
    });
    expect(message).toContain("invalid key; must be an exact semantic version");
  });

  /**
   * A recipe with no published versions is not usable and signals a broken
   * release.
   */
  it("should reject a recipe with no versions", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          versions: {},
        },
      },
    });
    expect(message).toContain("must list at least one published version");
  });

  /**
   * Hashes are always the prefixed lowercase form, so a bare digest is caught
   * at read time rather than at verification time.
   */
  it("should reject a hash that is not the prefixed lowercase form", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          versions: {
            "1.0.0": { hash: "a".repeat(64), tag: "t", prerelease: false },
          },
        },
      },
    });
    expect(message).toContain("a content hash must be written as 'sha256-'");
  });

  /**
   * `prerelease` is not optional; ranges must be able to decide whether to skip
   * a version without re-deriving it.
   */
  it("should reject a version entry with no prerelease flag", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          versions: { "1.0.0": { hash: HASH, tag: "t" } },
        },
      },
    });
    expect(message).toContain("prerelease");
  });

  /**
   * A recipe path must stay inside the repo.
   */
  it("should reject a recipe path that escapes the repo root", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          path: "../elsewhere",
        },
      },
    });
    expect(message).toContain("a recipe path must not contain a '.' or '..' segment");
  });
});

describe("stringifyIndexFile()", () => {
  /**
   * The index is written with every key sorted and a trailing newline, so
   * regenerating it produces a minimal diff.
   *
   * JSON.parse(stringifyIndexFile(index));  // -> the same index
   */
  it("should write sorted, round-trippable JSON", () => {
    const index = parseIndexFile(validIndex(), SOURCE);
    const text = stringifyIndexFile(index);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(index);
    expect(text.indexOf('"formatVersion"')).toBeLessThan(text.indexOf('"generatedAt"'));
  });
});

describe("indexFileSchema", () => {
  /**
   * The schema is exported for callers that want zod's safeParse result.
   */
  it("should be usable directly through safeParse", () => {
    expect(indexFileSchema.safeParse(validIndex()).success).toBe(true);
    expect(indexFileSchema.safeParse({}).success).toBe(false);
  });
});
