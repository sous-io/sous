import { ConfigError } from "@sous-io/plugin-api";
import type { HostHttp, HttpRequest } from "@sous-io/plugin-host/types";
import { describe, expect, it } from "vitest";
import { ABBREVIATED_METADATA_TYPE, DEFAULT_REGISTRY, fetchPublishedVersions, packageMetadataUrl, registryBaseUrl } from "../src/registry.js";

/** A registry answer holding two versions. */
const DOCUMENT = JSON.stringify({
    name: "@sous-io/sous",
    "dist-tags": { latest: "0.2.30" },
    versions: { "0.2.18": {}, "0.2.30": {} },
});

/** An http service that records each request and answers with `status` and `body`. */
function fakeHttp(status: number, body: string, calls: Array<Omit<HttpRequest, "url"> & { url: string }> = []): HostHttp {
    const get: HostHttp["get"] = async (url, options) => {
        calls.push({ url, ...options });

        return { status, statusText: status === 200 ? "OK" : "Failed", text: async () => body } as Awaited<ReturnType<HostHttp["get"]>>;
    };

    return { get, request: (request) => get(request.url, request) };
}

describe("registryBaseUrl()", () => {
    /**
     * registryBaseUrl should use the default registry when the environment names none, or names one
     * as a blank value.
     *
     * registryBaseUrl({}) -> "https://registry.npmjs.org/"
     */
    it("should default to the npm registry", () => {
        expect(registryBaseUrl({})).toBe(DEFAULT_REGISTRY);
        expect(registryBaseUrl({ npm_config_registry: "  " })).toBe(DEFAULT_REGISTRY);
    });

    /**
     * registryBaseUrl should read npm_config_registry before NPM_CONFIG_REGISTRY, and add a trailing
     * slash when the value has none.
     *
     * registryBaseUrl({ npm_config_registry: "https://a", NPM_CONFIG_REGISTRY: "https://b/" })
     * // -> "https://a/"
     */
    it("should honor the environment override, lowercase first", () => {
        expect(registryBaseUrl({ npm_config_registry: "https://a", NPM_CONFIG_REGISTRY: "https://b/" })).toBe("https://a/");
        expect(registryBaseUrl({ NPM_CONFIG_REGISTRY: "https://b/" })).toBe("https://b/");
    });
});

describe("packageMetadataUrl()", () => {
    /**
     * packageMetadataUrl should append the package name with its scope's slash encoded.
     *
     * packageMetadataUrl("https://registry.npmjs.org/") // -> "https://registry.npmjs.org/@sous-io%2fsous"
     */
    it("should encode the scope's slash", () => {
        expect(packageMetadataUrl(DEFAULT_REGISTRY)).toBe("https://registry.npmjs.org/@sous-io%2fsous");
    });
});

describe("fetchPublishedVersions()", () => {
    /** Reads the error a promise rejects with. */
    async function failure(promise: Promise<unknown>): Promise<ConfigError> {
        try {
            await promise;
        } catch (error) {
            return error as ConfigError;
        }

        throw new Error("expected a rejection");
    }

    /**
     * fetchPublishedVersions should GET the abbreviated document from the registry the environment
     * names, with a timeout, and parse it.
     *
     * await fetchPublishedVersions(http, { npm_config_registry: "https://mirror" })
     * // GET https://mirror/@sous-io%2fsous -> { versions: ["0.2.30", "0.2.18"], ... }
     */
    it("should fetch and parse the abbreviated document", async () => {
        const calls: Parameters<typeof fakeHttp>[2] = [];
        const metadata = await fetchPublishedVersions(fakeHttp(200, DOCUMENT, calls), { npm_config_registry: "https://mirror" });

        expect(metadata.versions).toEqual(["0.2.30", "0.2.18"]);
        expect(calls).toHaveLength(1);
        expect(calls![0]!.url).toBe("https://mirror/@sous-io%2fsous");
        expect(calls![0]!.headers?.accept).toBe(ABBREVIATED_METADATA_TYPE);
        expect(calls![0]!.timeoutMs).toBeGreaterThan(0);
    });

    /**
     * fetchPublishedVersions should fail with the URL and the status, and a hint that speaks of the
     * registry, on a 404.
     *
     * await fetchPublishedVersions(http answering 404, {})
     * // throws "... answered 404 Failed for ..." with "has no package named @sous-io/sous"
     */
    it("should explain a 404 in registry terms", async () => {
        const error = await failure(fetchPublishedVersions(fakeHttp(404, ""), {}));

        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toMatch(/404 Failed for https:\/\/registry\.npmjs\.org\/@sous-io%2fsous/);
        expect(error.details.join("\n")).toMatch(/has no package named @sous-io\/sous/);
    });

    /**
     * fetchPublishedVersions should explain an authorization failure, and add no hint for other
     * statuses.
     */
    it("should explain an authorization failure and leave other statuses bare", async () => {
        expect((await failure(fetchPublishedVersions(fakeHttp(401, ""), {}))).details.join("\n")).toMatch(/refused the request without credentials/);

        const bare = await failure(fetchPublishedVersions(fakeHttp(500, ""), {}));

        expect(bare.message).toMatch(/answered 500 Failed/);
        expect(bare.details).toEqual([]);
    });

    /**
     * fetchPublishedVersions should fail naming the URL and quoting the reason when the request
     * itself fails (no connection, a timeout).
     */
    it("should quote the reason when the request fails", async () => {
        const broken: HostHttp = {
            get: async () => {
                throw new Error("timed out after 15000 ms");
            },
            request: async () => {
                throw new Error("unused");
            },
        };
        const error = await failure(fetchPublishedVersions(broken, {}));

        expect(error.message).toMatch(/Could not read the list of published @sous-io\/sous versions from https:\/\/registry\.npmjs\.org\/@sous-io%2fsous/);
        expect(error.details).toEqual(["timed out after 15000 ms"]);
    });

    /**
     * fetchPublishedVersions should fail naming the URL when the registry sends something that is
     * not a package document.
     */
    it("should fail when the answer is not a package document", async () => {
        await expect(fetchPublishedVersions(fakeHttp(200, "<html>"), {})).rejects.toThrow(/from https:\/\/registry\.npmjs\.org\/@sous-io%2fsous is not JSON/);
    });
});
