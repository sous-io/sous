import { describe, it, expect } from "vitest";
import type { FetchLike } from "../repos/providers/http.js";
import {
  ABBREVIATED_METADATA_TYPE,
  DEFAULT_REGISTRY,
  fetchPublishedVersions,
  packageMetadataUrl,
  registryBaseUrl,
} from "./registry.js";

/** A registry answer holding two versions. */
const DOCUMENT = JSON.stringify({
  name: "@sous-io/sous",
  "dist-tags": { latest: "0.2.30" },
  versions: { "0.2.18": {}, "0.2.30": {} },
});

/** One request a fake fetch saw. */
type SeenRequest = { url: string; headers?: Record<string, string>; signal?: AbortSignal };

/** A fetch that records each request and answers with `status` and `body`. */
function fakeFetch(status: number, body: string, calls: SeenRequest[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, ...init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Failed",
      text: async () => body,
      headers: { get: () => null },
    };
  };
}

describe("registryBaseUrl()", () => {
  /**
   * registryBaseUrl should use the default registry when the environment names
   * none, or names one as a blank value.
   *
   * registryBaseUrl({}) -> "https://registry.npmjs.org/"
   */
  it("should default to the npm registry", () => {
    expect(registryBaseUrl({})).toBe(DEFAULT_REGISTRY);
    expect(registryBaseUrl({ npm_config_registry: "  " })).toBe(DEFAULT_REGISTRY);
  });

  /**
   * registryBaseUrl should read npm_config_registry before NPM_CONFIG_REGISTRY,
   * and add a trailing slash when the value has none.
   *
   * registryBaseUrl({ npm_config_registry: "https://a", NPM_CONFIG_REGISTRY: "https://b/" })
   * // -> "https://a/"
   */
  it("should honor the environment override, lowercase first", () => {
    expect(
      registryBaseUrl({ npm_config_registry: "https://a", NPM_CONFIG_REGISTRY: "https://b/" })
    ).toBe("https://a/");
    expect(registryBaseUrl({ NPM_CONFIG_REGISTRY: "https://b/" })).toBe("https://b/");
  });
});

describe("packageMetadataUrl()", () => {
  /**
   * packageMetadataUrl should append the package name with its scope's slash
   * encoded.
   *
   * packageMetadataUrl("https://registry.npmjs.org/")
   * // -> "https://registry.npmjs.org/@sous-io%2fsous"
   */
  it("should encode the scope's slash", () => {
    expect(packageMetadataUrl(DEFAULT_REGISTRY)).toBe("https://registry.npmjs.org/@sous-io%2fsous");
  });
});

describe("fetchPublishedVersions()", () => {
  /**
   * fetchPublishedVersions should GET the abbreviated document from the
   * registry the environment names, with a timeout signal, and parse it.
   *
   * await fetchPublishedVersions({ env: { npm_config_registry: "https://mirror" }, fetchImpl })
   * // GET https://mirror/@sous-io%2fsous -> { versions: ["0.2.30", "0.2.18"], ... }
   */
  it("should fetch and parse the abbreviated document", async () => {
    const calls: SeenRequest[] = [];
    const metadata = await fetchPublishedVersions({
      env: { npm_config_registry: "https://mirror" },
      fetchImpl: fakeFetch(200, DOCUMENT, calls),
    });
    expect(metadata.versions).toEqual(["0.2.30", "0.2.18"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mirror/@sous-io%2fsous");
    expect(calls[0]!.headers?.["Accept"]).toBe(ABBREVIATED_METADATA_TYPE);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * fetchPublishedVersions should fail with the URL, the status and a hint that
   * speaks of the registry (not of a sous repository) on a 404.
   *
   * await fetchPublishedVersions({ env: {}, fetchImpl: answers 404 })
   * // throws "... has no package named @sous-io/sous ..."
   */
  it("should explain a 404 in registry terms", async () => {
    await expect(fetchPublishedVersions({ env: {}, fetchImpl: fakeFetch(404, "") })).rejects.toThrow(
      /registry\.npmjs\.org\/@sous-io%2fsous[\s\S]*404 Failed[\s\S]*has no package named @sous-io\/sous/
    );
  });

  /**
   * fetchPublishedVersions should explain an authorization failure, and add no
   * hint for other statuses.
   *
   * await fetchPublishedVersions({ fetchImpl: answers 401 })
   * // throws "... refused the request without credentials ..."
   */
  it("should explain an authorization failure and leave other statuses bare", async () => {
    await expect(fetchPublishedVersions({ env: {}, fetchImpl: fakeFetch(401, "") })).rejects.toThrow(
      /refused the request without credentials/
    );
    await expect(fetchPublishedVersions({ env: {}, fetchImpl: fakeFetch(500, "") })).rejects.toThrow(
      /answered 500 Failed\.$/
    );
  });

  /**
   * fetchPublishedVersions should abort a request that runs past the timeout,
   * and fail naming the URL and quoting the reason.
   *
   * await fetchPublishedVersions({ timeoutMs: 5, fetchImpl: never answers })
   * // throws "Sous could not reach https://registry.npmjs.org/@sous-io%2fsous ... <reason>"
   */
  it("should quote the reason when the timeout aborts the request", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    await expect(
      fetchPublishedVersions({ env: {}, fetchImpl: hanging, timeoutMs: 5 })
    ).rejects.toThrow(/could not reach https:\/\/registry\.npmjs\.org\/@sous-io%2fsous[\s\S]*timeout/);
  });

  /**
   * fetchPublishedVersions should fail naming the URL when the registry sends
   * something that is not a package document.
   *
   * await fetchPublishedVersions({ fetchImpl: answers "<html>" }) // throws "... is not JSON."
   */
  it("should fail when the answer is not a package document", async () => {
    await expect(
      fetchPublishedVersions({ env: {}, fetchImpl: fakeFetch(200, "<html>") })
    ).rejects.toThrow(/from https:\/\/registry\.npmjs\.org\/@sous-io%2fsous is not JSON/);
  });
});
