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
   * A later sous may publish an index carrying fields this one does not
   * define. They are accepted at every level and kept as they are, so an older
   * sous still reads the index, and a release it runs writes a published
   * version back unchanged.
   *
   * parseIndexFile({ ...index, futureField: 1, recipes: { ...: { versions: { ...: { futureDependencyField: "x" } } } } });
   * // -> the same object, every unknown field still in place
   */
  it("should accept and keep a field it does not define, at every level", () => {
    const index = validIndex() as Record<string, any>;
    index.futureTopLevel = { anything: true };
    index.namespaces.workflow.futureNamespaceField = "kept";
    const recipe = index.recipes["workflow/task-files"];
    recipe.futureRecipeField = ["kept"];
    const version = recipe.versions["1.0.0"];
    version.futureVersionField = [{ name: "board" }];
    version.dependencies = {
      "workflow/partials": { version: "1.0.0", futureDependencyField: "workflow" },
    };
    version.variables = [
      {
        name: "board",
        type: "string",
        prompt: "Which board?",
        description: "The board the task files link to.",
        example: "Sous",
        required: true,
        secret: false,
        scope: "shared",
        futureVariableField: "kept",
        validate: { minLength: 1, futureRuleField: "kept" },
      },
    ];

    const parsed = parseIndexFile(index, SOURCE);

    expect(parsed).toEqual(index);
    expect(stringifyIndexFile(parsed)).toContain('"futureDependencyField": "workflow"');
    expect(stringifyIndexFile(parsed)).toContain('"futureVariableField": "kept"');
    expect(stringifyIndexFile(parsed)).toContain('"futureTopLevel"');
  });

  /**
   * A version described in full records, per dependency, the manifest entry
   * that declared it and whether it is a co-subscription, and the variable
   * definitions the version publishes, so a consumer can describe it before
   * fetching anything. Defaults the manifest schema applies are applied here
   * too.
   *
   * parseIndexFile(indexWith({ dependencies: { "workflow/partials": { version: "1.0.0",
   *   declared: "workflow", kind: "subscribes" } }, variables: [{ name: "board", ... }] }));
   * // -> the same entry, with `required: true`, `secret: false` and `scope: "shared"` filled in
   */
  it("should read a version's declarations and variable definitions", () => {
    const index = validIndex() as Record<string, any>;
    const version = index.recipes["workflow/task-files"].versions["1.0.0"];
    version.dependencies = {
      "workflow/partials": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
    };
    version.variables = [
      {
        name: "board",
        type: "string",
        prompt: "Which board?",
        description: "The board the task files link to.",
        example: "Sous",
      },
    ];

    const parsed = parseIndexFile(index, SOURCE);
    const entry = parsed.recipes["workflow/task-files"]!.versions["1.0.0"]!;

    expect(entry.dependencies!["workflow/partials"]).toEqual({
      version: "1.0.0",
      declared: "workflow",
      kind: "subscribes",
    });
    expect(entry.variables).toEqual([
      {
        name: "board",
        type: "string",
        prompt: "Which board?",
        description: "The board the task files link to.",
        example: "Sous",
        required: true,
        secret: false,
        scope: "shared",
      },
    ]);
  });

  /**
   * The recorded fields are checked as strictly as their manifest was: a kind
   * other than the two dependency kinds, and a definition breaking a rule the
   * manifest enforces, are both refused.
   *
   * parseIndexFile(indexWith({ kind: "requires" }));   // -> throws, naming 'kind'
   * parseIndexFile(indexWith({ type: "enum" }));       // -> throws, naming 'validate.enum'
   */
  it("should reject a recorded kind or definition its manifest could not have had", () => {
    const index = validIndex() as Record<string, any>;
    const version = index.recipes["workflow/task-files"].versions["1.0.0"];
    version.dependencies = {
      "workflow/partials": { version: "1.0.0", declared: "workflow", kind: "requires" },
    };
    version.variables = [
      {
        name: "depth",
        type: "enum",
        prompt: "How deep?",
        description: "How thorough a review is.",
        example: "quick",
      },
    ];

    const message = expectRejectMessage(index);

    expect(message).toContain("dependencies.workflow/partials.kind");
    expect(message).toContain("must list its options under 'validate.enum'");
  });

  /**
   * Keeping unknown fields does not loosen the known ones: a field this sous
   * defines is still checked in full, next to a field it does not.
   */
  it("should still reject a known field with a bad value beside an unknown one", () => {
    const index = validIndex() as Record<string, any>;
    const version = index.recipes["workflow/task-files"].versions["1.0.0"];
    version.futureField = true;
    version.prerelease = "no";

    const message = expectRejectMessage(index);

    expect(message).toContain(`Invalid repo index at ${SOURCE}:`);
    expect(message).toContain("prerelease");
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
   * A version's tag is what the provider actually fetches, so an index
   * publishing a "version" whose tag is a branch name hands `git clone
   * --branch` a moving target: the content behind the pin changes on every
   * push and the pinned hash simply starts failing. The tag has to name the
   * recipe and the version it sits under.
   *
   * { "workflow/task-files": { versions: { "1.0.0": { tag: "main" } } } }
   * // -> rejected, naming 'workflow/task-files@1.0.0'
   */
  it("should reject a version whose tag does not name that recipe and version", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          versions: {
            "1.0.0": { hash: HASH, tag: "main", prerelease: false },
          },
        },
      },
    });
    expect(message).toContain("workflow/task-files@1.0.0");
  });

  /**
   * The same check catches a tag borrowed from another recipe in the same
   * repository, which would install the wrong files under the right name.
   */
  it("should reject a version tagged with another recipe's tag", () => {
    const index = validIndex();
    const message = expectRejectMessage({
      ...index,
      recipes: {
        "workflow/task-files": {
          ...index.recipes["workflow/task-files"],
          versions: {
            "1.0.0": { hash: HASH, tag: "core/sous-skills@1.0.0", prerelease: false },
          },
        },
      },
    });
    expect(message).toContain("workflow/task-files@1.0.0");
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
