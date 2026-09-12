import { describe, it, expect } from "vitest";
import {
  Qualification,
  describeReference,
  findNamespace,
  findRecipe,
  findReference,
  findRepository,
  findVariable,
  referenceContextFromVariables,
  referenceReposFromIndexes,
  referenceToRef,
  variableReferenceKey,
  type ReferenceContext,
  type ReferenceRepo,
} from "./find.js";
import { ALL_SCOPES, SousScope } from "./scopes.js";
import type { IndexFile } from "../repos/formats/index-file.js";
import type { DefinedVariable } from "../vars/definition-source.js";
import type { LadderContext } from "../vars/ladder.js";

/**
 * Unit tests for reference resolution. What a word on the command line means is
 * decided here for every command, so every scope, every level of qualification,
 * the environment variable lookup, the listing order and the ambiguous case are
 * all covered.
 */

/** Builds a repository publishing the given `namespace/recipe` keys. */
function repoOf(name: string, keys: string[], extraNamespaces: string[] = []): ReferenceRepo {
  const namespaces = new Set(extraNamespaces);
  const recipes = keys.map((key) => {
    const slash = key.indexOf("/");
    namespaces.add(key.slice(0, slash));
    return {
      namespace: key.slice(0, slash),
      name: key.slice(slash + 1),
      description: `The ${key} recipe`,
    };
  });

  return {
    name,
    namespaces: [...namespaces].map((namespace) => ({ name: namespace })),
    recipes,
  };
}

/** Builds one variable definition published by one recipe. */
function variableOf(
  repo: string,
  namespace: string,
  recipe: string,
  name: string,
  env?: string
): DefinedVariable {
  return {
    definition: {
      name,
      type: "string",
      prompt: `What is ${name}?`,
      description: `The ${name} setting.`,
      example: "example",
      required: true,
      secret: false,
      scope: "shared",
      ...(env === undefined ? {} : { env }),
    } as DefinedVariable["definition"],
    recipe: { repo, namespace, name: recipe, version: "1.0.0" },
  };
}

/** An environment context holding the given names in the shared `.env` file. */
function ladderWith(sharedEnv: Record<string, string>): LadderContext {
  return { shellEnv: {}, localEnv: {}, sharedEnv, mappings: {} };
}

describe("findReference()", () => {
  /**
   * A bare word that names a namespace resolves to that whole namespace, fully
   * qualified with the repository publishing it.
   *
   * findReference("workflow", [Namespace], context)
   * // -> [{ scope: namespace, key: "fixtures:workflow" }]
   */
  it("should find a namespace by its bare name", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    const matches = findNamespace("workflow", context);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe("fixtures:workflow");
    expect(matches[0]!.scope).toBe(SousScope.Namespace);
    expect(matches[0]!.qualification).toBe(Qualification.Bare);
  });

  /**
   * The fully qualified spelling of a namespace is accepted too, and is
   * reported as the most specific kind of match there is.
   *
   * findReference("fixtures:workflow", [Namespace], context)
   * // -> [{ key: "fixtures:workflow", qualification: Full }]
   */
  it("should find a namespace by its fully qualified name", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    const matches = findNamespace("fixtures:workflow", context);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.qualification).toBe(Qualification.Full);
  });

  /**
   * A repository is named by its short name, and carries where it lives.
   *
   * findReference("fixtures", [Repository], context)
   * // -> [{ scope: repository, key: "fixtures" }]
   */
  it("should find a repository by its short name", () => {
    const repo = repoOf("fixtures", ["workflow/task-files"]);
    repo.url = "https://example.com/fixtures.git";
    const matches = findRepository("fixtures", { repos: [repo] });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.scope).toBe(SousScope.Repository);
    expect(matches[0]!.detail).toBe("https://example.com/fixtures.git");
  });

  /**
   * A recipe is found by its bare name, by `namespace/recipe`, by
   * `repository:recipe` and by the fully qualified spelling, and each says how
   * qualified the spelling that matched was.
   *
   * findRecipe("workflow/task-files", context)
   * // -> [{ key: "fixtures:workflow/task-files", qualification: Partial }]
   */
  it("should find a recipe at every level of qualification", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    const key = "fixtures:workflow/task-files";

    expect(findRecipe("task-files", context)[0]).toMatchObject({
      key,
      qualification: Qualification.Bare,
    });
    expect(findRecipe("workflow/task-files", context)[0]).toMatchObject({
      key,
      qualification: Qualification.Partial,
    });
    expect(findRecipe("fixtures:task-files", context)[0]).toMatchObject({
      key,
      qualification: Qualification.Partial,
    });
    expect(findRecipe(key, context)[0]).toMatchObject({
      key,
      qualification: Qualification.Full,
    });
  });

  /**
   * A word can be a namespace in one repository and a recipe name in another.
   * Both meanings come back, and the namespace is listed first.
   *
   * findReference("task-files", [Namespace, Recipe], context)
   * // -> ["fixtures:task-files", "extras:workflow/task-files"]
   */
  it("should return both meanings when a word is a namespace and a recipe name", () => {
    const context = {
      repos: [repoOf("fixtures", ["task-files/daily"]), repoOf("extras", ["workflow/task-files"])],
    };
    const matches = findReference(
      "task-files",
      [SousScope.Namespace, SousScope.Recipe],
      context
    );

    expect(matches.map((match) => match.key)).toEqual([
      "fixtures:task-files",
      "extras:workflow/task-files",
    ]);
    expect(matches.map((match) => match.scope)).toEqual([
      SousScope.Namespace,
      SousScope.Recipe,
    ]);
  });

  /**
   * The listing order is the contract, because it is what is shown and what
   * `--accept-first` picks from: repository order first, then namespace, then
   * recipe name, with a whole namespace ahead of the recipes.
   *
   * findReference("shared", [Namespace, Recipe], context)
   * // -> ["sous-recipes:shared", "sous-recipes:core/shared", "beta:mid/shared", ...]
   */
  it("should order matches by repository, then namespace, then recipe name", () => {
    const context = {
      repos: [
        repoOf("sous-recipes", ["core/shared"], ["shared"]),
        repoOf("beta", ["mid/shared"]),
        repoOf("alpha", ["zeta/shared", "alpha-ns/shared"]),
      ],
    };

    const matches = findReference(
      "shared",
      [SousScope.Namespace, SousScope.Recipe],
      context
    );

    expect(matches.map((match) => match.key)).toEqual([
      "sous-recipes:shared",
      "sous-recipes:core/shared",
      "beta:mid/shared",
      "alpha:alpha-ns/shared",
      "alpha:zeta/shared",
    ]);
  });

  /**
   * A more qualified spelling always outranks a less qualified one, whatever
   * kind of thing each names.
   *
   * findReference("fixtures:shared", ALL_SCOPES, context)
   * // -> the namespace 'shared' (fully qualified) before the recipe 'shared'
   */
  it("should list a more qualified match before a less qualified one", () => {
    // 'fixtures:shared' names the namespace 'shared' outright, and it also names
    // the recipe 'shared' in the same repository, one qualifier short.
    const context: ReferenceContext = {
      repos: [repoOf("fixtures", ["core/shared"], ["shared"])],
    };
    const matches = findReference("fixtures:shared", ALL_SCOPES, context);

    expect(matches.map((match) => match.key)).toEqual([
      "fixtures:shared",
      "fixtures:core/shared",
    ]);
    expect(matches.map((match) => match.qualification)).toEqual([
      Qualification.Full,
      Qualification.Partial,
    ]);
  });

  /**
   * Matching is case-sensitive: a variable and the environment variable that
   * answers it differ only in case and shape, and confusing them would resolve
   * one reference to two things.
   *
   * findReference("WORKFLOW", [Namespace], context)  // -> []
   */
  it("should match identifiers case-sensitively", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    expect(findNamespace("WORKFLOW", context)).toEqual([]);
    expect(findRecipe("Task-Files", context)).toEqual([]);
  });

  /** A name nothing publishes finds nothing at all. */
  it("should find nothing when no repository publishes the name", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    expect(findReference("nothing-like-this", ALL_SCOPES, context)).toEqual([]);
  });

  /** An empty reference matches nothing rather than everything. */
  it("should find nothing for an empty reference", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    expect(findReference("   ", ALL_SCOPES, context)).toEqual([]);
  });

  /**
   * A variable is found by its own name, by `recipe.variable`, by
   * `namespace/recipe.variable` and by the fully qualified spelling.
   *
   * findVariable("apiUrl", context)
   * // -> [{ key: "fixtures:workflow/task-files.apiUrl" }]
   */
  it("should find a variable by name and by every qualified spelling", () => {
    const variables = [variableOf("fixtures", "workflow", "task-files", "apiUrl")];
    const context = referenceContextFromVariables(variables);
    const key = "fixtures:workflow/task-files.apiUrl";

    expect(findVariable("apiUrl", context)[0]).toMatchObject({
      key,
      scope: SousScope.VariableName,
      qualification: Qualification.Bare,
    });
    expect(findVariable("task-files.apiUrl", context)[0]).toMatchObject({
      key,
      qualification: Qualification.Partial,
    });
    expect(findVariable("workflow/task-files.apiUrl", context)[0]).toMatchObject({
      key,
      qualification: Qualification.Partial,
    });
    expect(findVariable(key, context)[0]).toMatchObject({
      key,
      qualification: Qualification.Full,
    });
  });

  /**
   * A variable's declared environment variable name resolves to it, so a
   * project that binds an existing variable can name it the way the rest of the
   * system does.
   *
   * findVariable("GITHUB_TOKEN", context)
   * // -> [{ scope: envVarName, variable: "githubToken" }]
   */
  it("should find a variable by its declared environment variable name", () => {
    const variables = [
      variableOf("fixtures", "workflow", "task-files", "githubToken", "GITHUB_TOKEN"),
    ];
    const context = referenceContextFromVariables(variables);
    const matches = findVariable("GITHUB_TOKEN", context);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.scope).toBe(SousScope.EnvVarName);
    expect(matches[0]!.variable).toBe("githubToken");
    expect(matches[0]!.envName).toBe("GITHUB_TOKEN");
  });

  /**
   * A generated ladder name resolves to its variable when it is in use in one
   * of the project's env files, and not otherwise: every variable generates
   * four of them, and a name nothing has ever set names nothing.
   *
   * findVariable("SOUS_VAR_WORKFLOW_TASK_FILES_API_URL", context)
   * // -> [the apiUrl variable], but only when the .env file sets that name
   */
  it("should find a variable by a generated name that is in use", () => {
    const variables = [variableOf("fixtures", "workflow", "task-files", "apiUrl")];
    const scoped = "SOUS_VAR_WORKFLOW_TASK_FILES_API_URL";

    const inUse = referenceContextFromVariables(
      variables,
      ladderWith({ [scoped]: "https://example.com" })
    );
    expect(findVariable(scoped, inUse)).toHaveLength(1);

    const unused = referenceContextFromVariables(variables, ladderWith({}));
    expect(findVariable(scoped, unused)).toEqual([]);
  });

  /**
   * An environment variable name is the least likely reading of a word, so a
   * match on one is listed after every other kind of match.
   *
   * findReference("SOUS_VAR_API_URL", ALL_SCOPES, context)
   * // -> the env name match last
   */
  it("should list an environment variable name match last", () => {
    const variables = [
      variableOf("fixtures", "workflow", "task-files", "apiUrl"),
      variableOf("fixtures", "workflow", "other", "SOUS_VAR_API_URL"),
    ];
    const context = referenceContextFromVariables(
      variables,
      ladderWith({ SOUS_VAR_API_URL: "https://example.com" })
    );

    const matches = findReference("SOUS_VAR_API_URL", ALL_SCOPES, context);

    expect(matches.map((match) => match.scope)).toEqual([
      SousScope.VariableName,
      SousScope.EnvVarName,
    ]);
  });

  /**
   * Two recipes declaring a variable of the same name is ambiguous, and both
   * are returned so the caller can offer the choice.
   *
   * findVariable("apiUrl", context)  // -> two matches, one per recipe
   */
  it("should return every variable of the same name", () => {
    const variables = [
      variableOf("fixtures", "workflow", "task-files", "apiUrl"),
      variableOf("fixtures", "tooling", "formatter", "apiUrl"),
    ];
    const matches = findVariable("apiUrl", referenceContextFromVariables(variables));

    expect(matches.map((match) => match.key)).toEqual([
      "fixtures:tooling/formatter.apiUrl",
      "fixtures:workflow/task-files.apiUrl",
    ]);
  });

  /**
   * Only the scopes a command accepts are searched, so `sous subscribe` never
   * offers a variable as a thing to subscribe to.
   *
   * findReference("apiUrl", [Namespace, Recipe], context)  // -> []
   */
  it("should search only the scopes it was given", () => {
    const variables = [variableOf("fixtures", "workflow", "task-files", "apiUrl")];
    const context = referenceContextFromVariables(variables);

    expect(findReference("apiUrl", [SousScope.Namespace, SousScope.Recipe], context)).toEqual(
      []
    );
    expect(findReference("apiUrl", [SousScope.VariableName], context)).toHaveLength(1);
  });
});

describe("referenceContextFromVariables()", () => {
  /**
   * The repositories, namespaces and recipes a variables command searches are
   * exactly the ones that publish a variable in play.
   *
   * referenceContextFromVariables([apiUrl of workflow/task-files])
   * // -> one repository, one namespace, one recipe
   */
  it("should derive the repositories and namespaces from the definitions", () => {
    const context = referenceContextFromVariables([
      variableOf("fixtures", "workflow", "task-files", "apiUrl"),
      variableOf("fixtures", "workflow", "task-files", "apiToken"),
    ]);

    expect(context.repos).toHaveLength(1);
    expect(context.repos![0]!.namespaces).toEqual([{ name: "workflow" }]);
    expect(context.repos![0]!.recipes).toEqual([
      { namespace: "workflow", name: "task-files" },
    ]);
  });
});

describe("referenceReposFromIndexes()", () => {
  /**
   * A cached index becomes the namespaces and recipes a reference searches; a
   * repository with no readable index is left out.
   *
   * referenceReposFromIndexes(["fixtures", "offline"], indexes)
   * // -> [{ name: "fixtures", ... }]
   */
  it("should turn cached indexes into searchable repositories", () => {
    const index = {
      formatVersion: 1,
      name: "fixtures",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: "1.0.0",
      namespaces: { workflow: { description: "Workflow recipes" } },
      recipes: {
        "workflow/task-files": {
          path: "recipes/workflow/task-files",
          description: "Task files",
          versions: {},
        },
      },
    } as unknown as IndexFile;

    const repos = referenceReposFromIndexes(
      ["fixtures", "offline"],
      new Map([["fixtures", index]])
    );

    expect(repos).toHaveLength(1);
    expect(repos[0]!.namespaces).toEqual([
      { name: "workflow", description: "Workflow recipes" },
    ]);
    expect(repos[0]!.recipes[0]!.description).toBe("Task files");
  });
});

describe("describeReference()", () => {
  /** Every kind of match says what it means in one line, naming its identity. */
  it("should spell out what each kind of match means", () => {
    const context = {
      repos: [repoOf("fixtures", ["workflow/task-files"])],
      variables: [variableOf("fixtures", "workflow", "task-files", "apiUrl")],
    };

    expect(describeReference(findNamespace("workflow", context)[0]!)).toContain(
      "the whole namespace 'workflow'"
    );
    expect(describeReference(findRecipe("task-files", context)[0]!)).toContain(
      "the recipe 'task-files' in the namespace 'workflow'"
    );
    expect(describeReference(findVariable("apiUrl", context)[0]!)).toContain(
      "the variable 'apiUrl'"
    );
    expect(describeReference(findRepository("fixtures", context)[0]!)).toContain(
      "the repository 'fixtures'"
    );
  });
});

describe("referenceToRef()", () => {
  /**
   * The chosen match keeps its repository qualifier and carries over the
   * version range the original ref asked for.
   *
   * referenceToRef(match, { namespace: "task-files", range: "^1.0.0" })
   * // -> { repo: "fixtures", namespace: "workflow", recipe: "task-files", range: "^1.0.0" }
   */
  it("should keep the repository qualifier and carry the range over", () => {
    const context = { repos: [repoOf("fixtures", ["workflow/task-files"])] };
    const match = findRecipe("task-files", context)[0]!;

    expect(referenceToRef(match, { namespace: "task-files", range: "^1.0.0" })).toEqual({
      repo: "fixtures",
      namespace: "workflow",
      recipe: "task-files",
      range: "^1.0.0",
    });
  });
});

describe("variableReferenceKey()", () => {
  /**
   * A variable's fully qualified name names the repository, the namespace, the
   * recipe and the variable.
   *
   * variableReferenceKey(apiUrl of workflow/task-files)
   * // -> "fixtures:workflow/task-files.apiUrl"
   */
  it("should name the repository, namespace, recipe and variable", () => {
    expect(variableReferenceKey(variableOf("fixtures", "workflow", "task-files", "apiUrl"))).toBe(
      "fixtures:workflow/task-files.apiUrl"
    );
  });
});
