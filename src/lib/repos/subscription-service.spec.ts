import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { makeSettings } from "../../test/utils/settings.js";
import { SOUS_VERSION } from "../settings.js";
import { CORE_RECIPE_KEY, OFFICIAL_REPO_NAME, OFFICIAL_REPO_URL } from "./core-recipe.js";
import type { FetchLike } from "./providers/http.js";
import { SubscriptionService } from "./subscription-service.js";

const tmpDirs: TmpDir[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) tmpDirs.pop()!.cleanup();
});

/** A fetch that serves one body for every URL, and never reaches a network. */
function serving(body: string): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => body,
    headers: { get: () => null },
  });
}

/** The official repository's index as upstream might serve it, lacking the running version. */
const PUBLISHED = JSON.stringify({
  formatVersion: 1,
  name: OFFICIAL_REPO_NAME,
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: "0.0.1",
  namespaces: { core: {} },
  recipes: {
    [CORE_RECIPE_KEY]: {
      path: "recipes/core/sous-skills",
      versions: {
        "0.0.1": {
          hash: `sha256-${"a".repeat(64)}`,
          tag: `${CORE_RECIPE_KEY}@0.0.1`,
          prerelease: false,
        },
      },
    },
  },
});

describe("SubscriptionService", () => {
  /**
   * Every index cache the service creates starts with the packaged core
   * overlay, so reading the official repository's index from upstream (the
   * browsing commands' `--latest`) carries the running version even before the
   * repository publishes it, with nothing seeded.
   *
   * await service.upstreamIndex("sous-recipes")
   * // -> recipes["core/sous-skills"].versions includes the running version
   */
  it("should fold the packaged core version into an index read from upstream", async () => {
    const tmp = makeTmpDir("sous-subscription-service-");
    tmpDirs.push(tmp);
    const sousDir = path.join(tmp.path, "project", ".sous");

    const service = new SubscriptionService({
      sousDir,
      settings: makeSettings({
        repos: { [OFFICIAL_REPO_NAME]: { url: OFFICIAL_REPO_URL } },
      } as Parameters<typeof makeSettings>[0]),
      env: { SOUS_HOME: path.join(tmp.path, "sous-home") },
      providerOptions: { env: { GITHUB_TOKEN: "test-token" }, fetchImpl: serving(PUBLISHED) },
      interactive: false,
      warn: () => {},
      write: () => {},
    });

    const index = await service.upstreamIndex(OFFICIAL_REPO_NAME);

    expect(Object.keys(index.recipes[CORE_RECIPE_KEY]!.versions).sort()).toEqual(
      ["0.0.1", SOUS_VERSION].sort()
    );
  });
});

describe("SubscriptionService with a ref written as a location", () => {
  /** The index of github.com/vendor/recipes, with its recipes in recipes/<key>. */
  const VENDOR = JSON.stringify({
    formatVersion: 1,
    name: "vendor-recipes",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "0.0.1",
    namespaces: { workflow: {} },
    recipes: {
      "workflow/alpha": {
        path: "recipes/workflow/alpha",
        versions: {
          "1.0.0": {
            hash: `sha256-${"b".repeat(64)}`,
            tag: "workflow/alpha@1.0.0",
            prerelease: false,
          },
        },
      },
    },
  });

  /** A fetch serving the vendor index, and nothing else. */
  const vendorOnly: FetchLike = async (url) =>
    url.includes("/vendor/recipes/")
      ? {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => VENDOR,
          headers: { get: () => null },
        }
      : {
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: async () => "",
          headers: { get: () => null },
        };

  /** A service over a fresh project, trusting the repositories given. */
  function serviceWith(repos: Record<string, { url: string }>): SubscriptionService {
    const tmp = makeTmpDir("sous-subscribe-location-");
    tmpDirs.push(tmp);
    return new SubscriptionService({
      sousDir: path.join(tmp.path, "project", ".sous"),
      settings: makeSettings({ repos } as Parameters<typeof makeSettings>[0]),
      env: { SOUS_HOME: path.join(tmp.path, "sous-home") },
      providerOptions: { env: { GITHUB_TOKEN: "test-token" }, fetchImpl: vendorOnly },
      interactive: false,
      warn: () => {},
      write: () => {},
    });
  }

  /**
   * A browser URL for a repository the project does not trust yet runs the
   * trust ceremony for that repository, then settles the URL through its
   * index. What is recorded and printed is the canonical form.
   *
   * subscribe({ ref: "https://github.com/vendor/recipes/tree/main/recipes/workflow/alpha" })
   * // -> ref "recipes:workflow/alpha", key "workflow/alpha", trusted ["recipes"]
   */
  it("should trust the repository at a location, then settle the ref through its index", async () => {
    const service = serviceWith({});
    const url = "https://github.com/vendor/recipes/tree/main/recipes/workflow/alpha";

    const outcome = await service.subscribe({ ref: url, trust: true, yes: true, dryRun: true });

    expect(outcome.ref).toBe("recipes:workflow/alpha");
    expect(outcome.key).toBe("workflow/alpha");
    expect(outcome.resolvedFrom).toBe(url);
    expect(outcome.trusted).toEqual(["recipes"]);
  });

  /**
   * A location naming a repository the project already trusts, under any short
   * name, is matched by identity and needs no ceremony; names typed in another
   * case still settle.
   *
   * subscribe({ ref: "git@github.com:vendor/recipes.git/Workflow/Alpha" })
   * // -> ref "mine:workflow/alpha", trusted []
   */
  it("should match a trusted repository by identity, whatever it is called", async () => {
    const service = serviceWith({ mine: { url: "https://github.com/vendor/recipes" } });

    const outcome = await service.subscribe({
      ref: "git@github.com:vendor/recipes.git/Workflow/Alpha",
      yes: true,
      dryRun: true,
    });

    expect(outcome.ref).toBe("mine:workflow/alpha");
    expect(outcome.trusted).toEqual([]);
  });

  /**
   * A short ref typed in another case settles to the published spelling.
   *
   * subscribe({ ref: "Workflow/Alpha" }) // -> ref "mine:workflow/alpha"
   */
  it("should settle a short ref typed in another case", async () => {
    const service = serviceWith({ mine: { url: "https://github.com/vendor/recipes" } });

    const outcome = await service.subscribe({ ref: "Workflow/Alpha", yes: true, dryRun: true });

    expect(outcome.ref).toBe("mine:workflow/alpha");
    expect(outcome.resolvedFrom).toBe("Workflow/Alpha");
  });

  /**
   * A location whose repository publishes nothing there is an error that says
   * so rather than a guess.
   *
   * subscribe({ ref: "github://vendor/recipes/workflow/gamma" }) // throws
   */
  it("should refuse a location its repository does not publish", async () => {
    const service = serviceWith({ mine: { url: "https://github.com/vendor/recipes" } });

    await expect(
      service.subscribe({ ref: "github://vendor/recipes/workflow/gamma", yes: true, dryRun: true })
    ).rejects.toThrow(/publishes no namespace or recipe there/);
  });

  /**
   * cachedReferenceRepos is what every command that settles a location searches
   * (`sous vars ask`, `sous repo contribute`): each trusted repository with its
   * identity, and, once its index is cached, what it publishes and where each
   * recipe lives. Nothing is fetched to answer it.
   *
   * service.cachedReferenceRepos()
   * // -> [{ name: "mine", identity: "github.com/vendor/recipes", recipes: [...] }]
   */
  it("should list the trusted repositories from the cache, with identities", async () => {
    const service = serviceWith({ mine: { url: "https://github.com/vendor/recipes" } });

    const before = service.cachedReferenceRepos();
    expect(before).toEqual([
      {
        name: "mine",
        url: "https://github.com/vendor/recipes",
        identity: "github.com/vendor/recipes",
        namespaces: [],
        recipes: [],
      },
    ]);

    await service.loadIndexes(["mine"]);
    const [after] = service.cachedReferenceRepos();
    expect(after!.identity).toBe("github.com/vendor/recipes");
    expect(after!.recipes).toEqual([
      { namespace: "workflow", name: "alpha", path: "recipes/workflow/alpha" },
    ]);
  });
});
