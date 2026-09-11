import { describe, it, expect } from "vitest";
import {
  describeNamespace,
  describeRecipe,
  listNamespaces,
  listRecipes,
  resolveNamespaceRef,
  resolveRecipeRef,
  type CatalogInputs,
  type CatalogRepo,
} from "./catalog.js";
import type { IndexFile } from "./formats/index-file.js";
import type { Lockfile } from "./formats/lockfile.js";
import type { RecipeManifest } from "./formats/recipe-manifest.js";

/** One published version, in the shape an index records it. */
function version(
  key: string,
  value: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    hash: `sha256:${value.replace(/\./g, "")}`,
    tag: `${key}@${value}`,
    prerelease: value.includes("-"),
    ...extra,
  };
}

/**
 * Builds an index the way `sous repo release` writes one, without going near a
 * repository. Each recipe names its versions; anything else is filled in.
 */
function makeIndex(
  name: string,
  namespaces: Record<string, string | undefined>,
  recipes: Record<string, { versions: string[]; description?: string; deps?: unknown }>
): IndexFile {
  const indexRecipes: Record<string, unknown> = {};
  for (const [key, recipe] of Object.entries(recipes)) {
    const versions: Record<string, unknown> = {};
    for (const value of recipe.versions) {
      versions[value] = version(
        key,
        value,
        recipe.deps === undefined ? {} : { dependencies: recipe.deps }
      );
    }
    indexRecipes[key] = {
      path: `recipes/${key}`,
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      versions,
    };
  }

  return {
    formatVersion: 1,
    name,
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "0.1.1",
    namespaces: Object.fromEntries(
      Object.entries(namespaces).map(([key, description]) => [
        key,
        description === undefined ? {} : { description },
      ])
    ),
    recipes: indexRecipes,
  } as IndexFile;
}

/** The repository most of these tests read. */
const primary: CatalogRepo = {
  name: "qa-recipes",
  url: "/repos/qa-recipes",
  index: makeIndex(
    "qa-recipes",
    { workflow: "How work moves through a project", quality: undefined },
    {
      "workflow/qa-variables": {
        versions: ["0.1.0", "0.2.0", "0.3.0-beta.1"],
        description: "One question of every kind",
        deps: { "workflow/qa-helper": { version: "0.1.0" } },
      },
      "workflow/qa-helper": { versions: ["0.1.0"], description: "The sibling" },
      "quality/qa-pattern": { versions: ["1.0.0"] },
    }
  ),
};

/** A second repository, which publishes a namespace the first one also does. */
const secondary: CatalogRepo = {
  name: "extras",
  url: "https://example.invalid/extras",
  index: makeIndex(
    "extras",
    { workflow: "Another workflow namespace" },
    { "workflow/qa-helper": { versions: ["2.0.0"] }, "workflow/extra": { versions: ["1.0.0"] } }
  ),
};

/** A lockfile pinning one recipe from the primary repository. */
const lock: Lockfile = {
  formatVersion: 1,
  repos: {
    "qa-recipes": { url: "/repos/qa-recipes", identity: "localhost/repos/qa-recipes" },
  },
  recipes: {
    "workflow/qa-variables": {
      repo: "qa-recipes",
      version: "0.1.0",
      hash: "sha256:010",
      requestedBy: ["project"],
      kind: "subscribes",
    },
  },
} as Lockfile;

/** The inputs every test starts from: one repository, one pin, one subscription. */
function inputs(overrides: Partial<CatalogInputs> = {}): CatalogInputs {
  return {
    repos: [primary],
    lock,
    subscriptions: ["workflow/qa-variables"],
    ...overrides,
  };
}

describe("listNamespaces()", () => {
  /**
   * Every namespace of every trusted repository is listed, with the number of
   * recipes in it and how much of it the project subscribes to. A project
   * subscribed to one recipe of a namespace covers "some recipes"; a namespace
   * nothing touches covers "none".
   *
   * listNamespaces(inputs);
   * // -> [{ namespace: "quality", subscribed: "none" },
   * //     { namespace: "workflow", subscribed: "some recipes" }]
   */
  it("should list every namespace with its recipe count and coverage", () => {
    const listings = listNamespaces(inputs());

    expect(listings.map((entry) => entry.namespace)).toEqual(["quality", "workflow"]);
    expect(listings[1]).toMatchObject({
      repo: "qa-recipes",
      namespace: "workflow",
      description: "How work moves through a project",
      recipeCount: 2,
      subscribed: "some recipes",
    });
    expect(listings[0]!.subscribed).toBe("none");
  });

  /**
   * A subscription to the namespace itself covers the whole namespace, however
   * many recipes it holds.
   *
   * listNamespaces({ ...inputs, subscriptions: ["workflow"] });
   * // -> workflow is subscribed: "whole namespace"
   */
  it("should report a namespace subscription as the whole namespace", () => {
    const listings = listNamespaces(inputs({ subscriptions: ["workflow"] }));

    expect(listings.find((entry) => entry.namespace === "workflow")!.subscribed).toBe(
      "whole namespace"
    );
  });

  /**
   * Two repositories publishing the same namespace name are two rows, sorted by
   * namespace and then by repository, so they sit beside each other.
   */
  it("should list the same namespace once per repository publishing it", () => {
    const listings = listNamespaces(inputs({ repos: [primary, secondary] }));

    const workflow = listings.filter((entry) => entry.namespace === "workflow");
    expect(workflow.map((entry) => entry.repo)).toEqual(["extras", "qa-recipes"]);
  });
});

describe("listRecipes()", () => {
  /**
   * Every recipe is listed with the highest published version, the version the
   * lockfile pins (when it pins one) and whether the project subscribes to it.
   * A prerelease is not the latest version while anything else is published.
   *
   * listRecipes(inputs);
   * // -> workflow/qa-variables, latest 0.2.0, pinned 0.1.0, subscribed
   */
  it("should list every recipe with its latest and pinned versions", () => {
    const listings = listRecipes(inputs());

    expect(listings.map((entry) => entry.key)).toEqual([
      "quality/qa-pattern",
      "workflow/qa-helper",
      "workflow/qa-variables",
    ]);
    expect(listings[2]).toMatchObject({
      key: "workflow/qa-variables",
      repo: "qa-recipes",
      latest: "0.2.0",
      pinned: "0.1.0",
      subscribed: true,
      description: "One question of every kind",
    });
    expect(listings[1]!.pinned).toBeUndefined();
    expect(listings[1]!.subscribed).toBe(false);
  });

  /**
   * A lockfile entry pins one recipe from one repository. Another repository
   * publishing the same key is not pinned by it, so its row reports no pinned
   * version.
   */
  it("should not claim another repository's recipe is pinned", () => {
    const listings = listRecipes(inputs({ repos: [primary, secondary] }));

    const helpers = listings.filter((entry) => entry.key === "workflow/qa-helper");
    expect(helpers.map((entry) => entry.repo)).toEqual(["extras", "qa-recipes"]);
    expect(helpers.every((entry) => entry.pinned === undefined)).toBe(true);
  });

  /**
   * A namespace subscription subscribes every recipe in the namespace, so each
   * of them reports itself subscribed.
   */
  it("should report every recipe of a subscribed namespace as subscribed", () => {
    const listings = listRecipes(inputs({ subscriptions: ["workflow"] }));

    expect(
      listings.filter((entry) => entry.namespace === "workflow").every((entry) => entry.subscribed)
    ).toBe(true);
    expect(listings.find((entry) => entry.namespace === "quality")!.subscribed).toBe(false);
  });
});

describe("describeNamespace()", () => {
  /**
   * The namespace is described with what the repository says about it and every
   * recipe in it, each carrying its own versions and subscription state.
   *
   * describeNamespace(inputs, "workflow");
   * // -> { namespace: "workflow", recipes: [qa-helper, qa-variables] }
   */
  it("should describe the namespace and every recipe in it", () => {
    const detail = describeNamespace(inputs(), "workflow");

    expect(detail.repo).toBe("qa-recipes");
    expect(detail.repoUrl).toBe("/repos/qa-recipes");
    expect(detail.description).toBe("How work moves through a project");
    expect(detail.subscribed).toBe("some recipes");
    expect(detail.recipes.map((entry) => entry.key)).toEqual([
      "workflow/qa-helper",
      "workflow/qa-variables",
    ]);
  });

  /**
   * A namespace two repositories publish is ambiguous, and the error lists both
   * qualified refs rather than picking one.
   *
   * describeNamespace(inputs, "workflow");  // -> throws, naming both repositories
   */
  it("should refuse an ambiguous namespace and list the candidates", () => {
    expect(() => describeNamespace(inputs({ repos: [primary, secondary] }), "workflow")).toThrow(
      /qa-recipes:workflow[\s\S]*extras:workflow|extras:workflow[\s\S]*qa-recipes:workflow/
    );
  });

  /**
   * A `repo:` qualifier settles the ambiguity, and the namespace resolves in
   * exactly that repository.
   *
   * describeNamespace(inputs, "extras:workflow");  // -> the extras namespace
   */
  it("should resolve a qualified namespace in the repository named", () => {
    const detail = describeNamespace(inputs({ repos: [primary, secondary] }), "extras:workflow");

    expect(detail.repo).toBe("extras");
    expect(detail.recipes.map((entry) => entry.key)).toEqual([
      "workflow/extra",
      "workflow/qa-helper",
    ]);
  });
});

describe("describeRecipe()", () => {
  /** A manifest for the pinned recipe, as its own files would carry it. */
  const manifest = {
    formatVersion: 1,
    namespace: "workflow",
    name: "qa-variables",
    version: "0.1.0",
    depends: ["workflow/qa-helper"],
    contents: [{ kind: "skills", include: ["skills/**/*.md"] }],
    variables: [
      {
        name: "qaAgentName",
        type: "string",
        prompt: "What name should agents sign notes with?",
        description: "The name every note is signed with.",
        example: "Review Bot",
        required: true,
        secret: false,
        scope: "shared",
      },
    ],
  } as unknown as RecipeManifest;

  /**
   * Everything about one recipe: its identity, every published version labeled
   * with what it is to this project, the dependencies from both the index and
   * the manifest, the variables it declares, and where its files land.
   *
   * describeRecipe(inputs, "workflow/qa-variables");
   */
  it("should describe one recipe from its index and its manifest", () => {
    const detail = describeRecipe(
      inputs({
        readManifest: () => manifest,
        destinationsFor: (kind) => (kind === "skills" ? ["/project/.claude/skills"] : []),
      }),
      "workflow/qa-variables"
    );

    expect(detail.key).toBe("workflow/qa-variables");
    expect(detail.repo).toBe("qa-recipes");
    expect(detail.repoUrl).toBe("/repos/qa-recipes");
    expect(detail.path).toBe("recipes/workflow/qa-variables");
    expect(detail.describing).toBe("0.1.0");
    expect(detail.manifestRead).toBe(true);

    expect(detail.versions).toEqual([
      { version: "0.3.0-beta.1", status: "other", prerelease: true },
      { version: "0.2.0", status: "latest", prerelease: false },
      { version: "0.1.0", status: "pinned", prerelease: false },
    ]);

    expect(detail.dependencies).toEqual([
      {
        key: "workflow/qa-helper",
        resolvedVersion: "0.1.0",
        declared: "workflow/qa-helper",
        kind: "depends",
      },
    ]);

    expect(detail.variables).toEqual([
      {
        name: "qaAgentName",
        type: "string",
        env: "SOUS_VAR_QA_AGENT_NAME",
        required: true,
        secret: false,
        prompt: "What name should agents sign notes with?",
      },
    ]);

    expect(detail.contents).toEqual([
      {
        kind: "skills",
        include: ["skills/**/*.md"],
        destinations: ["/project/.claude/skills"],
      },
    ]);
  });

  /**
   * A recipe whose files are not on this machine is still described, from its
   * index alone. `manifestRead` says so, and nothing is invented.
   *
   * describeRecipe({ ...inputs, readManifest: () => undefined }, "workflow/qa-variables");
   */
  it("should describe a recipe whose manifest cannot be read", () => {
    const detail = describeRecipe(
      inputs({ readManifest: () => undefined }),
      "workflow/qa-variables"
    );

    expect(detail.manifestRead).toBe(false);
    expect(detail.variables).toEqual([]);
    expect(detail.contents).toEqual([]);
    expect(detail.dependencies).toEqual([
      { key: "workflow/qa-helper", resolvedVersion: "0.1.0" },
    ]);
  });

  /**
   * With nothing pinned, the latest published version is the one described, and
   * it is labeled as the latest.
   */
  it("should describe the latest version when nothing is pinned", () => {
    const detail = describeRecipe(inputs(), "workflow/qa-helper");

    expect(detail.describing).toBe("0.1.0");
    expect(detail.pinned).toBeUndefined();
    expect(detail.versions[0]!.status).toBe("latest");
  });

  /**
   * A one-word ref is searched as a recipe name across every trusted
   * repository, exactly as `sous subscribe` searches one.
   *
   * describeRecipe(inputs, "qa-pattern");  // -> quality/qa-pattern
   */
  it("should resolve a one-word recipe name", () => {
    expect(describeRecipe(inputs(), "qa-pattern").key).toBe("quality/qa-pattern");
  });
});

describe("resolveNamespaceRef()", () => {
  /**
   * A ref naming a recipe is not a namespace, and the error says which
   * namespace the recipe belongs to.
   *
   * resolveNamespaceRef(inputs, "workflow/qa-helper");  // -> throws
   */
  it("should refuse a ref that names a recipe", () => {
    expect(() => resolveNamespaceRef(inputs(), "workflow/qa-helper")).toThrow(
      /names the recipe 'qa-helper', not a namespace/
    );
  });

  /**
   * A one-word ref that is a recipe name rather than a namespace name is an
   * error naming the recipes it found instead.
   *
   * resolveNamespaceRef(inputs, "qa-helper");  // -> throws, naming workflow/qa-helper
   */
  it("should say when a one-word ref is a recipe name", () => {
    expect(() => resolveNamespaceRef(inputs(), "qa-helper")).toThrow(
      /It is the name of a recipe/
    );
  });

  /**
   * A namespace nothing publishes names the repositories that were searched, so
   * "the name is wrong" reads differently from "the repository was never
   * added".
   */
  it("should name the repositories searched when nothing matches", () => {
    expect(() => resolveNamespaceRef(inputs(), "nothing")).toThrow(
      /Repositories with an index sous has read: qa-recipes/
    );
  });

  /**
   * A qualifier naming a repository the project does not trust says exactly
   * that, rather than reporting the namespace as missing.
   */
  it("should say when the qualifier names an untrusted repository", () => {
    expect(() => resolveNamespaceRef(inputs(), "nowhere:workflow")).toThrow(
      /trusts no repository called 'nowhere'/
    );
  });
});

describe("resolveRecipeRef()", () => {
  /**
   * A two-segment ref names the recipe exactly, in whichever trusted repository
   * publishes it.
   *
   * resolveRecipeRef(inputs, "workflow/qa-helper");
   * // -> { repo: "qa-recipes", key: "workflow/qa-helper" }
   */
  it("should resolve a two-segment ref", () => {
    const found = resolveRecipeRef(inputs(), "workflow/qa-helper");

    expect(found.repo.name).toBe("qa-recipes");
    expect(found.key).toBe("workflow/qa-helper");
    expect(found.name).toBe("qa-helper");
  });

  /**
   * A recipe two repositories publish under the same key is ambiguous, and the
   * error lists both qualified refs.
   */
  it("should refuse an ambiguous recipe key", () => {
    expect(() =>
      resolveRecipeRef(inputs({ repos: [primary, secondary] }), "workflow/qa-helper")
    ).toThrow(/more than one repository/);
  });

  /**
   * A one-word ref that is a namespace name rather than a recipe name is an
   * error naming the namespace it found instead.
   */
  it("should say when a one-word ref is a namespace name", () => {
    expect(() => resolveRecipeRef(inputs(), "quality")).toThrow(
      /It is the name of a namespace/
    );
  });
});
