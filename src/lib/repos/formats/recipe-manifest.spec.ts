import { describe, it, expect } from "vitest";
import {
  parseRecipeManifest,
  recipeManifestKey,
  recipeManifestSchema,
} from "./recipe-manifest.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the recipe manifest schema (`sous.recipe.yaml`), including its
 * dependency lists, content groups and variable definitions.
 */

const SOURCE = "/repo/recipes/workflow/task-files/sous.recipe.yaml";

/** A minimal manifest that passes, used as the base for rejection cases. */
function validManifest() {
  return {
    formatVersion: 1,
    namespace: "workflow",
    name: "task-files",
    version: "1.2.0",
    description: "Per-branch task file workflow.",
    contents: [{ kind: "skills", include: ["skills/**/*.md"] }],
  };
}

/** Runs parseRecipeManifest and returns the ConfigError message, or fails. */
function expectRejectMessage(value: unknown): string {
  try {
    parseRecipeManifest(value, SOURCE);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected parseRecipeManifest to throw, but it returned");
}

/**
 * Fills in the two documentation fields every definition must carry, so a test
 * about some other field does not have to restate them.
 */
function variable(fields: Record<string, unknown>) {
  const options = (fields.validate as { enum?: string[] } | undefined)?.enum;
  const example =
    fields.type === "number"
      ? 1
      : fields.type === "boolean"
        ? true
        : fields.type === "enum"
          ? (options?.[0] ?? "fast")
          : "sample-answer";
  return {
    description: "What this variable is for, in a sentence.",
    example,
    ...fields,
  };
}

/** Builds a manifest carrying exactly one variable definition. */
function withVariable(fields: Record<string, unknown>) {
  return { ...validManifest(), variables: [variable(fields)] };
}

describe("parseRecipeManifest()", () => {
  /**
   * A manifest exercising every field parses, and the optional fields with
   * defaults come back filled in.
   */
  it("should accept a manifest using every field", () => {
    const manifest = {
      ...validManifest(),
      depends: ["core/sous-skills@^1.0.0", "communication/control-flow"],
      subscribes: ["github://sous-io/sous-recipes/quality/reviews@~2.1"],
      contents: [
        { kind: "skills", include: ["skills/**/*.md"], exclude: ["skills/**/draft-*.md"] },
        { kind: "memories", include: ["memories/*.md"] },
        { kind: "config", include: ["config/510-task-files.json"] },
      ],
      variables: [
        {
          name: "taskFileRoot",
          env: "SOUS_VAR_TASK_FILE_ROOT",
          type: "path",
          prompt: "Where should task files live?",
          description: "One file per git branch is written here.",
          example: ".sous/tasks",
          default: ".sous/tasks",
          required: true,
          secret: false,
          scope: "shared",
          validate: { minLength: 1, maxLength: 200, pattern: "^[^\\s]+$" },
        },
        {
          name: "ticketSystem",
          type: "enum",
          prompt: "Which ticket system do you use?",
          description: "Decides which ticket identifiers the skills expect.",
          example: "github",
          default: "github",
          validate: { enum: ["github", "jira", "linear"] },
        },
      ],
    };
    const parsed = parseRecipeManifest(manifest, SOURCE);
    expect(parsed.name).toBe("task-files");
    expect(parsed.variables?.[1]?.required).toBe(true);
    expect(parsed.variables?.[1]?.secret).toBe(false);
    expect(parsed.variables?.[1]?.scope).toBe("shared");
  });

  /**
   * A curated bundle contributes no files of its own, so `contents` may be
   * omitted and defaults to an empty list.
   *
   * parseRecipeManifest({ ..., subscribes: [...] }).contents;  // -> []
   */
  it("should default contents to an empty list for a curated bundle", () => {
    const manifest = {
      formatVersion: 1,
      namespace: "workflow",
      name: "everything",
      version: "1.0.0",
      subscribes: ["workflow/task-files", "workflow/github-projects"],
    };
    expect(parseRecipeManifest(manifest, SOURCE).contents).toEqual([]);
  });

  /**
   * Keys in the reserved `x-` extension namespace are accepted and dropped.
   */
  it("should accept and drop x- extension keys", () => {
    const parsed = parseRecipeManifest(
      { ...validManifest(), "x-maintainer": "platform" },
      SOURCE
    );
    expect(parsed).not.toHaveProperty("x-maintainer");
  });

  /**
   * An unknown top-level key is a typo and is rejected, naming the file.
   */
  it("should reject an unknown top-level key", () => {
    const message = expectRejectMessage({ ...validManifest(), dependencies: [] });
    expect(message).toContain(`Invalid recipe manifest at ${SOURCE}:`);
    expect(message).toContain("unknown key 'dependencies' at the top level");
  });

  /**
   * A recipe's version is exact, never a range; the version a subscriber gets
   * is chosen by resolving ranges against published versions.
   */
  it("should reject a version that is a range", () => {
    expect(expectRejectMessage({ ...validManifest(), version: "^1.2.0" })).toContain(
      "version: must be an exact semantic version"
    );
  });

  /**
   * `recipeManifestKey` composes the identity used by the index, the lockfile
   * and a project's subscriptions.
   *
   * recipeManifestKey(manifest);  // -> "workflow/task-files"
   */
  it("should expose the recipe key as namespace and name", () => {
    expect(recipeManifestKey(parseRecipeManifest(validManifest(), SOURCE))).toBe(
      "workflow/task-files"
    );
  });
});

describe("recipe manifest dependency lists", () => {
  /**
   * Both `depends` and `subscribes` hold ref strings, validated by the same
   * parser the command line uses, so the manifest and the CLI never disagree.
   */
  it("should accept every ref shape in depends and subscribes", () => {
    const manifest = {
      ...validManifest(),
      depends: ["workflow", "workflow/task-files", "workflow/task-files@^1.0.0"],
      subscribes: [
        "github://sous-io/sous-recipes/core/sous-skills@>=1.0.0 <2.0.0",
        "gitlab://gitlab.example.com/group/subgroup/project/quality/reviews",
      ],
    };
    expect(parseRecipeManifest(manifest, SOURCE).depends).toHaveLength(3);
    expect(parseRecipeManifest(manifest, SOURCE).subscribes).toHaveLength(2);
  });

  /**
   * A short name is a consuming project's own label for a repository, so it
   * cannot name anything in a published manifest.
   */
  it("should reject the consumer-side repo qualifier", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      depends: ["sous-recipes:workflow/task-files"],
    });
    expect(message).toContain("depends[0]:");
    expect(message).toContain("short name");
  });

  /**
   * A local path is a convenience on one machine, never a location a published
   * recipe can point at.
   */
  it("should reject a local locator", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      depends: ["local://var/recipes/workflow/task-files"],
    });
    expect(message).toContain("not a published location");
  });

  /**
   * A bad ref is reported with the ref parser's own message, so the author sees
   * the grammar rather than a bare "invalid string".
   */
  it("should reject a bad ref with the ref parser's message", () => {
    const message = expectRejectMessage({ ...validManifest(), depends: ["@workflow"] });
    expect(message).toContain("depends[0]:");
    expect(message).toContain("refs take no '@' prefix");
  });

  /**
   * A version range on a namespace ref is rejected here too, since namespaces
   * are not versioned.
   */
  it("should reject a range on a namespace ref", () => {
    expect(expectRejectMessage({ ...validManifest(), subscribes: ["workflow@^1.0.0"] })).toContain(
      "namespaces are not versioned"
    );
  });

  /**
   * Listing the same target twice is a mistake, and the message names the list
   * and the duplicate.
   */
  it("should reject a duplicated dependency", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      depends: ["workflow/task-files", "workflow/task-files"],
    });
    expect(message).toContain("depends[1]: 'workflow/task-files' is listed more than once");
  });
});

describe("recipe manifest contents", () => {
  /**
   * A content group's kind decides where its files land, and only the four
   * known kinds are accepted.
   */
  it("should reject an unknown content kind", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      contents: [{ kind: "scripts", include: ["scripts/*.sh"] }],
    });
    expect(message).toContain("contents[0].kind:");
  });

  /**
   * A content group with no include patterns contributes nothing, which is
   * almost certainly a mistake.
   */
  it("should reject a content group with no include patterns", () => {
    expect(
      expectRejectMessage({ ...validManifest(), contents: [{ kind: "skills", include: [] }] })
    ).toContain("must list at least one include pattern");
  });

  /**
   * Include and exclude patterns are relative to the recipe folder and may not
   * escape it, so a manifest can never reach into the rest of the repo.
   */
  it("should reject include and exclude patterns that escape the recipe folder", () => {
    expect(
      expectRejectMessage({
        ...validManifest(),
        contents: [{ kind: "skills", include: ["../../etc/**"] }],
      })
    ).toContain("contents[0].include[0]: an include pattern must not contain");
    expect(
      expectRejectMessage({
        ...validManifest(),
        contents: [{ kind: "skills", include: ["**/*.md"], exclude: ["/etc/passwd"] }],
      })
    ).toContain("contents[0].exclude[0]: an exclude pattern must be relative");
  });
});

describe("recipe manifest variable definitions", () => {
  /**
   * Omitted flags take their documented defaults: an answer is required, is not
   * a secret, and is written to the shared, committed env file.
   *
   * parsed.variables[0];  // -> { ..., required: true, secret: false, scope: "shared" }
   */
  it("should apply the documented defaults", () => {
    const parsed = parseRecipeManifest(
      withVariable({ name: "apiUrl", type: "url", prompt: "API base URL?" }),
      SOURCE
    );
    expect(parsed.variables?.[0]).toMatchObject({
      required: true,
      secret: false,
      scope: "shared",
    });
  });

  /**
   * Variable names are camelCase and environment variable names are upper snake
   * case, matching the project's existing conventions.
   */
  it("should reject a bad variable name or environment variable name", () => {
    expect(
      expectRejectMessage(withVariable({ name: "api_url", type: "string", prompt: "?" }))
    ).toContain("variables[0].name: a variable name must be camelCase");
    expect(
      expectRejectMessage(
        withVariable({ name: "apiUrl", env: "apiUrl", type: "string", prompt: "?" })
      )
    ).toContain("variables[0].env: an environment variable name must be upper snake case");
  });

  /**
   * A question with no text cannot be asked.
   */
  it("should reject an empty prompt", () => {
    expect(
      expectRejectMessage(withVariable({ name: "apiUrl", type: "string", prompt: "" }))
    ).toContain("variables[0].prompt: must not be empty");
  });

  /**
   * An enum variable is unanswerable without its options.
   */
  it("should reject an enum variable with no options", () => {
    expect(
      expectRejectMessage(withVariable({ name: "mode", type: "enum", prompt: "Mode?" }))
    ).toContain("variables[0].validate.enum: a variable of type 'enum' must list its options");
  });

  /**
   * A published variable has to explain itself, so a consumer who is asked the
   * one-line question can tell what it means and what a real answer looks like.
   * Both messages say why the field is required rather than reporting a type.
   */
  it("should reject a variable with no description and no example", () => {
    const message = expectRejectMessage({
      ...validManifest(),
      variables: [{ name: "apiUrl", type: "url", prompt: "API base URL?" }],
    });
    expect(message).toContain(
      "variables[0].description: is required: every published variable must explain itself"
    );
    expect(message).toContain(
      "variables[0].example: is required: every published variable must show what a real answer looks like"
    );
  });

  /**
   * An empty description is the same omission written differently.
   */
  it("should reject an empty description", () => {
    expect(
      expectRejectMessage(
        withVariable({ name: "apiUrl", type: "url", prompt: "?", description: "" })
      )
    ).toContain("variables[0].description: must not be empty");
  });

  /**
   * An example is checked exactly as a default is: it must match the declared
   * type, and for an enum it must be one of the listed options.
   */
  it("should reject an example that contradicts the type or the options", () => {
    expect(
      expectRejectMessage(
        withVariable({ name: "retries", type: "number", prompt: "?", example: "three" })
      )
    ).toContain("variables[0].example: must be a number");
    expect(
      expectRejectMessage(
        withVariable({
          name: "mode",
          type: "enum",
          prompt: "?",
          example: "turbo",
          validate: { enum: ["fast", "slow"] },
        })
      )
    ).toContain("variables[0].example: must be one of the options");
  });

  /**
   * A default must match the declared type, and for an enum it must be one of
   * the listed options.
   */
  it("should reject a default that contradicts the type or the options", () => {
    expect(
      expectRejectMessage(
        withVariable({ name: "retries", type: "number", prompt: "?", default: "three" })
      )
    ).toContain("variables[0].default: must be a number");
    expect(
      expectRejectMessage(
        withVariable({
          name: "mode",
          type: "enum",
          prompt: "?",
          default: "turbo",
          validate: { enum: ["fast", "slow"] },
        })
      )
    ).toContain("variables[0].default: must be one of the options");
  });

  /**
   * A secret answer is written to the gitignored `.sous/.env.local`, so
   * declaring it shared is a contradiction that would leak the value.
   */
  it("should reject a secret variable declared as shared", () => {
    const message = expectRejectMessage(
      withVariable({
        name: "apiToken",
        type: "string",
        prompt: "?",
        secret: true,
        scope: "shared",
      })
    );
    expect(message).toContain("variables[0].scope:");
    expect(message).toContain("must be 'local'");
  });

  /**
   * A secret variable scoped local, or left unset, is fine.
   */
  it("should accept a secret variable scoped local", () => {
    const parsed = parseRecipeManifest(
      withVariable({
        name: "apiToken",
        type: "string",
        prompt: "?",
        secret: true,
        scope: "local",
      }),
      SOURCE
    );
    expect(parsed.variables?.[0]?.scope).toBe("local");
  });

  /**
   * A pattern that is not a compilable regular expression is rejected before it
   * can fail at question time.
   */
  it("should reject an uncompilable validation pattern", () => {
    expect(
      expectRejectMessage(
        withVariable({ name: "apiUrl", type: "string", prompt: "?", validate: { pattern: "[" } })
      )
    ).toContain("variables[0].validate.pattern: must be a valid regular expression");
  });

  /**
   * Inverted bounds can never be satisfied, so they are rejected.
   */
  it("should reject inverted length and value bounds", () => {
    expect(
      expectRejectMessage(
        withVariable({
          name: "apiUrl",
          type: "string",
          prompt: "?",
          validate: { minLength: 10, maxLength: 2 },
        })
      )
    ).toContain("variables[0].validate.maxLength: must not be smaller than");
    expect(
      expectRejectMessage(
        withVariable({
          name: "retries",
          type: "number",
          prompt: "?",
          validate: { min: 10, max: 2 },
        })
      )
    ).toContain("variables[0].validate.max: must not be smaller than");
  });

  /**
   * A name or an environment variable claimed twice inside one recipe is an
   * ambiguity, so both are rejected with the offending index named.
   */
  it("should reject duplicate variable names and duplicate environment variables", () => {
    const duplicateName = expectRejectMessage({
      ...validManifest(),
      variables: [
        variable({ name: "apiUrl", type: "string", prompt: "?" }),
        variable({ name: "apiUrl", type: "url", prompt: "?" }),
      ],
    });
    expect(duplicateName).toContain("variables[1].name: the variable 'apiUrl' is defined more than once");

    const duplicateEnv = expectRejectMessage({
      ...validManifest(),
      variables: [
        variable({ name: "apiUrl", env: "SHARED_NAME", type: "string", prompt: "?" }),
        variable({ name: "apiKey", env: "SHARED_NAME", type: "string", prompt: "?" }),
      ],
    });
    expect(duplicateEnv).toContain("variables[1].env: the environment variable 'SHARED_NAME'");
  });

  /**
   * An unknown key inside a variable definition is reported with its full path.
   */
  it("should reject an unknown key inside a variable definition", () => {
    expect(
      expectRejectMessage(
        withVariable({ name: "apiUrl", type: "string", prompt: "?", secrit: true })
      )
    ).toContain("unknown key 'secrit' under 'variables[0]'");
  });
});

describe("recipeManifestSchema", () => {
  /**
   * The schema is exported for callers that want zod's safeParse result rather
   * than a thrown ConfigError.
   */
  it("should be usable directly through safeParse", () => {
    expect(recipeManifestSchema.safeParse(validManifest()).success).toBe(true);
    expect(recipeManifestSchema.safeParse({}).success).toBe(false);
  });
});
