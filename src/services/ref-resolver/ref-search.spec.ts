import { describe, expect, it } from "vitest";
import type { LadderContext } from "../../lib/vars/ladder.js";
import { variableOf } from "../../test/utils/ref-fixtures.js";
import { sharedRefResolver } from "./container.js";
import { describeRef, refSpelling } from "./format.js";
import { locationFromUrl } from "./location.js";
import { CatalogLookup } from "./lookups/catalog-lookup.js";
import type { CatalogRepo } from "./lookups/catalog-matcher.js";
import { ChainedLookup } from "./lookups/chained-lookup.js";
import { EnvVarLookup } from "./lookups/env-var-lookup.js";
import type { RefLookup } from "./lookups/ref-lookup.js";
import { VariableLookup, variableRefOf } from "./lookups/variable-lookup.js";
import { RefResolveArguments } from "./ref-resolve-arguments.js";
import { refKey } from "./format.js";
import type { RefKind } from "./types.js";

/**
 * What a word on the command line means is decided for every command by the
 * resolver and a lookup. These cases cover each level of qualification, the
 * kinds a command accepts, the listing order, the exact-then-ignoring-case
 * rule, variables, environment variable names and locations.
 */

const resolver = sharedRefResolver();

/** A repository publishing the given `namespace/recipe` keys. */
function repoOf(name: string, keys: string[], extraNamespaces: string[] = []): CatalogRepo {
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
  return { name, namespaces: [...namespaces].map((namespace) => ({ name: namespace })), recipes };
}

/** An environment context holding the given names in the shared `.env` file. */
function ladderWith(sharedEnv: Record<string, string>): LadderContext {
  return { shellEnv: {}, localEnv: {}, sharedEnv, mappings: {} };
}

/** What a command does: resolves a word against a lookup and accepts some kinds. */
async function search(
  input: string,
  lookup: RefLookup,
  kinds?: readonly RefKind[]
): Promise<string[]> {
  const { refs } = await resolver.resolve(
    new RefResolveArguments({ input, lookup, refusedIsEmpty: true, ...(kinds ? { kinds } : {}) })
  );
  return refs.map((ref) => `${ref.kind}:${refSpelling(ref)}`);
}

describe("a word on the command line, against repositories", () => {
  /**
   * A bare word that names a namespace resolves to that whole namespace, fully
   * qualified with the repository publishing it.
   *
   * search("workflow", ["namespace"]) // -> ["namespace:fixtures:workflow"]
   */
  it("should find a namespace by its bare name", async () => {
    const lookup = new CatalogLookup([repoOf("fixtures", ["workflow/task-files"])]);
    expect(await search("workflow", lookup, ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
    expect(await search("fixtures:workflow", lookup, ["namespace"])).toEqual([
      "namespace:fixtures:workflow",
    ]);
  });

  /**
   * A repository is named by its short name, and carries where it lives.
   *
   * search("fixtures", ["repo"]) // -> the repository, with its location
   */
  it("should find a repository by its short name", async () => {
    const location = locationFromUrl("https://github.com/o/fixtures.git")!;
    const lookup = new CatalogLookup([{ ...repoOf("fixtures", ["workflow/task-files"]), location }]);
    const { refs } = await resolver.resolve(
      new RefResolveArguments({ input: "fixtures", lookup, kinds: ["repo"] })
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "repo", name: "fixtures" });
    expect(describeRef(refs[0]!)).toContain("at https://github.com/o/fixtures.git");
  });

  /**
   * A recipe is found by its bare name, by `namespace/recipe`, by
   * `repository:recipe` and by the fully qualified spelling.
   *
   * search("workflow/task-files", ["recipe"]) // -> ["recipe:fixtures:workflow/task-files"]
   */
  it("should find a recipe at every level of qualification", async () => {
    const lookup = new CatalogLookup([repoOf("fixtures", ["workflow/task-files"])]);
    for (const written of [
      "task-files",
      "workflow/task-files",
      "fixtures:task-files",
      "fixtures:workflow/task-files",
    ]) {
      expect(await search(written, lookup, ["recipe"]), written).toEqual([
        "recipe:fixtures:workflow/task-files",
      ]);
    }
  });

  /**
   * A word can be a namespace in one repository and a recipe name in another.
   * Both meanings come back, and the namespace is listed first.
   *
   * search("task-files", ["namespace", "recipe"])
   * // -> ["fixtures:task-files", "extras:workflow/task-files"]
   */
  it("should return both meanings when a word is a namespace and a recipe name", async () => {
    const lookup = new CatalogLookup([
      repoOf("fixtures", ["task-files/daily"]),
      repoOf("extras", ["workflow/task-files"]),
    ]);
    expect(await search("task-files", lookup, ["namespace", "recipe"])).toEqual([
      "namespace:fixtures:task-files",
      "recipe:extras:workflow/task-files",
    ]);
  });

  /**
   * The listing order is the contract, because it is what is shown and what
   * `--accept-first` picks from: repository order first, then namespace, then
   * recipe name, with a whole namespace ahead of the recipes.
   *
   * search("shared", ["namespace", "recipe"])
   * // -> ["sous-recipes:shared", "sous-recipes:core/shared", "beta:mid/shared", ...]
   */
  it("should order matches by repository, then namespace, then recipe name", async () => {
    const lookup = new CatalogLookup([
      repoOf("sous-recipes", ["core/shared"], ["shared"]),
      repoOf("beta", ["mid/shared"]),
      repoOf("alpha", ["zeta/shared", "alpha-ns/shared"]),
    ]);
    expect(await search("shared", lookup, ["namespace", "recipe"])).toEqual([
      "namespace:sous-recipes:shared",
      "recipe:sous-recipes:core/shared",
      "recipe:beta:mid/shared",
      "recipe:alpha:alpha-ns/shared",
      "recipe:alpha:zeta/shared",
    ]);
  });

  /**
   * A more qualified spelling always outranks a less qualified one, whatever
   * kind of thing each names.
   *
   * search("fixtures:shared") // -> the namespace 'shared' before the recipe 'shared'
   */
  it("should list a more qualified match before a less qualified one", async () => {
    const lookup = new CatalogLookup([repoOf("fixtures", ["core/shared"], ["shared"])]);
    expect(await search("fixtures:shared", lookup, ["repo", "namespace", "recipe"])).toEqual([
      "namespace:fixtures:shared",
      "recipe:fixtures:core/shared",
    ]);
  });

  /**
   * Matching tries the exact spelling first, then ignores case: a name typed in
   * another case still finds what it names.
   *
   * search("WORKFLOW", ["namespace"]) // -> [fixtures:workflow]
   */
  it("should fall back to ignoring case when nothing matches exactly", async () => {
    const lookup = new CatalogLookup([repoOf("fixtures", ["workflow/task-files"])]);
    expect(await search("WORKFLOW", lookup, ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
    expect(await search("Workflow/Task-Files", lookup, ["recipe"])).toEqual([
      "recipe:fixtures:workflow/task-files",
    ]);
    expect(await search("Fixtures:Task-Files", lookup, ["recipe"])).toEqual([
      "recipe:fixtures:workflow/task-files",
    ]);
  });

  /**
   * An exact match wins outright: the case-insensitive pass runs only when the
   * exact spelling matched nothing, and a name that still matches several
   * things when case is ignored is handed back as several matches.
   *
   * search("workflow") // -> the exact namespace only
   * search("WORKFLOW") // -> both namespaces
   */
  it("should prefer an exact match, and return every case-insensitive one otherwise", async () => {
    const lookup = new CatalogLookup([
      repoOf("fixtures", ["workflow/task-files", "Workflow/other"]),
    ]);
    expect(await search("workflow", lookup, ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
    expect(await search("WORKFLOW", lookup, ["namespace"])).toEqual([
      "namespace:fixtures:Workflow",
      "namespace:fixtures:workflow",
    ]);
  });

  /**
   * The exact pass is decided among the kinds a command accepts. A word that is
   * a repository exactly and a namespace only ignoring case still finds the
   * namespace for a command that accepts namespaces alone.
   *
   * search("Fixtures", ["namespace"]) // -> the namespace "fixtures", though a repository is called "Fixtures"
   */
  it("should decide exact before ignoring case among the accepted kinds only", async () => {
    const lookup = new CatalogLookup([
      repoOf("Fixtures", ["workflow/a"]),
      repoOf("other", ["fixtures/b"]),
    ]);
    expect(await search("Fixtures", lookup, ["namespace"])).toEqual(["namespace:other:fixtures"]);
    expect(await search("Fixtures", lookup, ["repo", "namespace"])).toEqual(["repo:Fixtures"]);
  });

  /**
   * A name nothing publishes finds nothing at all, and so does a word the place
   * refuses in every reading when the caller says a refusal names nothing.
   *
   * search("nothing-like-this") // -> []
   * search("   ")               // -> []
   */
  it("should find nothing for what is not published, empty or malformed", async () => {
    const lookup = new CatalogLookup([repoOf("fixtures", ["workflow/task-files"])]);
    expect(await search("nothing-like-this", lookup)).toEqual([]);
    expect(await search("   ", lookup)).toEqual([]);
    expect(await search("a/b/c", lookup)).toEqual([]);
    expect(await search("*", lookup)).toEqual([]);
  });

  /**
   * Without that, the refusal is raised, saying what to write instead.
   *
   * resolve("a/b/c") // throws
   */
  it("should raise the refusal when a refused ref does not name nothing", async () => {
    const lookup = new CatalogLookup([repoOf("fixtures", ["workflow/task-files"])]);
    await expect(
      resolver.resolve(new RefResolveArguments({ input: "a/b/c", lookup }))
    ).rejects.toThrow(/at most two path segments/);
  });
});

describe("a word on the command line, against variables", () => {
  const variables = [
    variableOf("fixtures", "workflow", "task-files", "apiUrl"),
    variableOf("fixtures", "tooling", "formatter", "apiUrl"),
  ];

  /** The lookup a variables command searches: the definitions, and the environment names. */
  const lookupFor = (defined = variables, ladder?: LadderContext): RefLookup =>
    new ChainedLookup(new VariableLookup(defined), new EnvVarLookup(defined, ladder));

  /**
   * A variable is found by its own name, by `recipe.variable`, by
   * `namespace/recipe.variable` and by the fully qualified spelling.
   *
   * search("apiUrl", ["variable"]) // -> every apiUrl
   */
  it("should find a variable by name and by every qualified spelling", async () => {
    const lookup = lookupFor([variables[0]!]);
    const key = "variable:fixtures:workflow/task-files.apiUrl";
    for (const written of [
      "apiUrl",
      "task-files.apiUrl",
      "workflow/task-files.apiUrl",
      "fixtures:workflow/task-files.apiUrl",
    ]) {
      expect(await search(written, lookup, ["variable"]), written).toEqual([key]);
    }
  });

  /**
   * A variable's fully qualified name names the repository, the namespace, the
   * recipe and the variable.
   *
   * refKey(variableRefOf(apiUrl of workflow/task-files)) // -> "fixtures:workflow/task-files.apiUrl"
   */
  it("should name the repository, namespace, recipe and variable", () => {
    expect(refKey(variableRefOf(variables[0]!))).toBe("fixtures:workflow/task-files.apiUrl");
  });

  /**
   * Two recipes declaring a variable of the same name is ambiguous, and both
   * are returned so the caller can offer the choice.
   *
   * search("apiUrl", ["variable"]) // -> two matches, one per recipe
   */
  it("should return every variable of the same name", async () => {
    expect(await search("apiUrl", lookupFor(), ["variable", "envVar"])).toEqual([
      "variable:fixtures:tooling/formatter.apiUrl",
      "variable:fixtures:workflow/task-files.apiUrl",
    ]);
  });

  /**
   * A variable's declared environment variable name resolves to it, so a
   * project that binds an existing variable can name it the way the rest of the
   * system does.
   *
   * search("GITHUB_TOKEN") // -> the environment variable, answering githubToken
   */
  it("should find a variable by its declared environment variable name", async () => {
    const defined = [variableOf("fixtures", "workflow", "task-files", "githubToken", "GITHUB_TOKEN")];
    const { refs } = await resolver.resolve(
      new RefResolveArguments({ input: "GITHUB_TOKEN", lookup: lookupFor(defined), kinds: ["envVar"] })
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "envVar", name: "GITHUB_TOKEN" });
    expect(describeRef(refs[0]!)).toContain("answering 'githubToken'");
  });

  /**
   * A generated name resolves to its variable when it is in use in one of the
   * project's env files, and not otherwise: every variable generates several of
   * them, and a name nothing has ever set names nothing.
   *
   * search("SOUS_VAR_WORKFLOW_TASK_FILES_API_URL") // -> the variable, only when .env sets that name
   */
  it("should find a variable by a generated name that is in use", async () => {
    const defined = [variables[0]!];
    const scoped = "SOUS_VAR_WORKFLOW_TASK_FILES_API_URL";
    expect(
      await search(scoped, lookupFor(defined, ladderWith({ [scoped]: "https://example.com" })))
    ).toHaveLength(1);
    expect(await search(scoped, lookupFor(defined, ladderWith({})))).toEqual([]);
  });

  /**
   * An environment variable name is held whole and matched in its exact
   * spelling only: a variable and an environment variable name can differ only
   * in case, and the spelling typed is the one meant.
   *
   * search("github_token") // -> []
   */
  it("should match an environment variable name by its exact spelling", async () => {
    const defined = [variableOf("fixtures", "workflow", "task-files", "githubToken", "GITHUB_TOKEN")];
    expect(await search("github_token", lookupFor(defined))).toEqual([]);
  });

  /**
   * Only the kinds a command accepts are searched, so `sous subscribe` never
   * offers a variable as a thing to subscribe to.
   *
   * search("apiUrl", ["namespace", "recipe"]) // -> []
   */
  it("should search only the kinds it was given", async () => {
    const lookup = lookupFor([variables[0]!]);
    expect(await search("apiUrl", lookup, ["namespace", "recipe"])).toEqual([]);
    expect(await search("apiUrl", lookup, ["variable"])).toHaveLength(1);
  });

  /**
   * The repositories, namespaces and recipes a variables command searches are
   * exactly the ones that publish a variable in play.
   *
   * search("workflow", ["namespace"]) // -> only when a variable of workflow is in play
   */
  it("should search only what the definitions belong to", async () => {
    const lookup = lookupFor([variables[0]!]);
    expect(await search("workflow", lookup, ["namespace"])).toEqual(["namespace:fixtures:workflow"]);
    expect(await search("tooling", lookup, ["namespace"])).toEqual([]);
  });
});

describe("a location on the command line", () => {
  /** A trusted repository at github.com/owner/recipes, called "mine" in this project. */
  const location = locationFromUrl("https://github.com/owner/recipes")!;
  const trusted: CatalogRepo = {
    name: "mine",
    location,
    namespaces: [{ name: "workflow" }],
    recipes: [
      { namespace: "workflow", name: "alpha", path: "recipes/workflow/alpha" },
      { namespace: "workflow", name: "beta", path: "recipes/workflow/beta" },
    ],
  };
  const lookup = new CatalogLookup([trusted]);

  /**
   * A location is matched to the trusted repository at it, whatever this
   * project calls it, in every URL form.
   *
   * search("https://github.com/owner/recipes/workflow/alpha") // -> [mine:workflow/alpha]
   */
  it("should find a recipe named by any location form", async () => {
    for (const written of [
      "github://owner/recipes/workflow/alpha",
      "https://github.com/owner/recipes/workflow/alpha",
      "github.com/owner/recipes.git/workflow/alpha",
      "git@github.com:owner/recipes.git/workflow/alpha",
      "https://github.com/Owner/Recipes/Workflow/Alpha",
    ]) {
      expect(await search(written, lookup, ["recipe"]), written).toEqual([
        "recipe:mine:workflow/alpha",
      ]);
    }
  });

  /**
   * A browser URL is settled through the folder each recipe lives in.
   *
   * search("https://github.com/owner/recipes/tree/main/recipes/workflow/beta") // -> [mine:workflow/beta]
   */
  it("should find a recipe named by a browser URL", async () => {
    expect(
      await search(
        "https://github.com/owner/recipes/tree/main/recipes/workflow/beta",
        lookup,
        ["recipe"]
      )
    ).toEqual(["recipe:mine:workflow/beta"]);
  });

  /**
   * A namespace and a whole repository are found the same way.
   *
   * search("github://owner/recipes/workflow/*", ["namespace"]) // -> [mine:workflow]
   * search("git@github.com:owner/recipes.git", ["repo"])       // -> [mine]
   */
  it("should find a namespace and a repository named by location", async () => {
    expect(await search("github://owner/recipes/workflow/*", lookup, ["namespace"])).toEqual([
      "namespace:mine:workflow",
    ]);
    expect(await search("git@github.com:owner/recipes.git", lookup, ["repo"])).toEqual([
      "repo:mine",
    ]);
  });

  /**
   * A location this project does not trust, or one that does not parse, names
   * nothing.
   *
   * search("https://github.com/someone/else/workflow/alpha") // -> []
   */
  it("should find nothing at an untrusted or malformed location", async () => {
    expect(await search("https://github.com/someone/else/workflow/alpha", lookup)).toEqual([]);
    expect(await search("https://github.com/owner/recipes/a/b/c", lookup, ["recipe"])).toEqual([]);
    expect(await search("https://github.com/owner/recipes/workflow/gamma", lookup)).toEqual([]);
  });

  /**
   * With the trusted repositories lent to it, the variables lookup settles a
   * location the way every other command does, and still holds only what the
   * variables belong to.
   *
   * search("github://owner/recipes/workflow/gamma") // -> [] (it asks nothing)
   */
  it("should settle a location against the trusted repository in a variables search", async () => {
    const variables = [
      variableOf("mine", "workflow", "alpha", "apiUrl"),
      variableOf("mine", "workflow", "beta", "token"),
    ];
    const withTrust = new VariableLookup(variables, [trusted]);
    for (const [written, key] of [
      ["github://owner/recipes/workflow/alpha", "recipe:mine:workflow/alpha"],
      ["git@github.com:owner/recipes.git/workflow/beta", "recipe:mine:workflow/beta"],
      [
        "https://github.com/owner/recipes/tree/main/recipes/workflow/beta",
        "recipe:mine:workflow/beta",
      ],
    ] as const) {
      expect(await search(written, withTrust), written).toEqual([key]);
    }
    expect(await search("github://owner/recipes/workflow/gamma", withTrust)).toEqual([]);
    expect(await search("github://owner/recipes/workflow/alpha", new VariableLookup(variables))).toEqual([]);
  });
});
