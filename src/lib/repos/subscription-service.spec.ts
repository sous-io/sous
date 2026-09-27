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
