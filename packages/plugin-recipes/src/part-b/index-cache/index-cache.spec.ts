import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nullReporter } from "@sous-io/plugin-api";
import { indexFileFormat } from "@sous-io/plugin-formats";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoEntry, RepositoryHostContext, RepositoryHostEntity, RepositoryReadOutcome } from "../../types.js";
import { IndexCacheCore, IndexCacheService, INDEX_SIDECAR_SUFFIX } from "./index-cache.js";
import { IndexReadError } from "./read-chain.js";

const URL = "https://fake.test/acme/recipes";
const IDENTITY = "fake.test/acme/recipes";
const target = { name: "acme", url: URL, identity: IDENTITY };

/** An index publishing one recipe. */
function index(version = "1.0.0", name = "acme"): IndexFile {
    return {
        formatVersion: 1,
        name,
        generatedAt: "2026-10-01T00:00:00.000Z",
        generator: "0.2.34",
        namespaces: { workflow: {} },
        recipes: { "workflow/alpha": { path: "recipes/workflow/alpha", versions: { [version]: { hash: `sha256-${"a".repeat(64)}`, tag: `workflow/alpha@${version}`, prerelease: false } } } },
    };
}

let dir: string;
let now: Date;
let served: IndexFile | undefined;
let reply: ((etag: string | undefined) => RepositoryReadOutcome) | undefined;
let reads: Array<{ etag?: string; signal?: AbortSignal }>;
let core: IndexCacheCore;

/** The host serving {@link served}, or failing. */
function host(): RepositoryHostEntity {
    return {
        id: "fake",
        features: [],
        matches: (url: string) => url.startsWith("https://fake.test/"),
        canonicalize: () => ({ host: "fake.test", owner: "acme", name: "recipes", httpsUrl: URL, sshUrl: "" }),
        readLocation: () => [],
        formatLocator: () => "",
        fetchRecipeTree: async () => {},
        readStrategies: [
            {
                id: "http",
                label: "HTTP",
                async read(request, ctx) {
                    reads.push({ ...(request.etag ? { etag: request.etag } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });

                    if (reply) {
                        return reply(request.etag);
                    }

                    return served === undefined ? { ok: false, reason: "404 not found" } : { ok: true, text: JSON.stringify(served), ref: "HEAD", etag: '"v1"' };
                },
            },
        ],
    };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-cache-"));
    now = new Date("2026-10-29T12:00:00.000Z");
    served = index();
    reply = undefined;
    reads = [];
    core = new IndexCacheCore({
        directory: path.join(dir, "_indexes"),
        strategiesFile: path.join(dir, "read-strategies.json"),
        parser: indexFileFormat,
        hosts: () => [host()],
        hostContext: () => ({ reporter: nullReporter }) as unknown as RepositoryHostContext,
        now: () => now,
    });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Moves the clock on. */
function later(seconds: number): void {
    now = new Date(now.getTime() + seconds * 1000);
}

describe("IndexCacheCore", () => {
    it("should fetch and cache an index that is not on disk yet, filed under its identity", async () => {
        const lookup = await core.get(target);

        expect(lookup.source).toBe("network");
        expect(lookup.index.recipes["workflow/alpha"]).toBeDefined();
        expect(core.indexPath(IDENTITY)).toBe(path.join(dir, "_indexes", "fake.test", "acme", "recipes.json"));
        expect(fs.existsSync(core.indexPath(IDENTITY))).toBe(true);
        expect(core.readMeta(IDENTITY)).toMatchObject({ url: URL, identity: IDENTITY, fetchedAt: now.toISOString(), lastCheckedAt: now.toISOString(), strategy: "http", etag: '"v1"' });
        expect(core.readMeta(IDENTITY)?.hash).toMatch(/^sha256-[0-9a-f]{64}$/);
    });

    it("should return the cached copy while it is fresh", async () => {
        await core.get(target);
        later(60);

        const lookup = await core.get(target, { freshnessSeconds: 300 });

        expect(lookup.source).toBe("cache");
        expect(reads).toHaveLength(1);
    });

    it("should look upstream once the freshness window has lapsed", async () => {
        await core.get(target);
        later(301);
        served = index("2.0.0");

        const lookup = await core.get(target, { freshnessSeconds: 300 });

        expect(lookup.source).toBe("network");
        expect(Object.keys(lookup.index.recipes["workflow/alpha"].versions)).toEqual(["2.0.0"]);
    });

    it("should look upstream with --latest even when the cache is fresh", async () => {
        await core.get(target);

        expect((await core.get(target, { latest: true })).source).toBe("network");
        expect(reads).toHaveLength(2);
    });

    it("should send the cached ETag, and keep the cached copy when upstream says it is not modified", async () => {
        await core.get(target);
        later(400);
        reply = (etag) => ({ ok: true, notModified: true, ...(etag ? { etag } : {}) });

        const lookup = await core.get(target);

        expect(reads[1].etag).toBe('"v1"');
        expect(lookup.source).toBe("cache");
        expect(core.readMeta(IDENTITY)?.lastCheckedAt).toBe(now.toISOString());
        expect(core.readMeta(IDENTITY)?.fetchedAt).toBe("2026-10-29T12:00:00.000Z");
    });

    it("should fall back to the stale copy when upstream fails, recording the problem and the check", async () => {
        await core.get(target);
        later(400);
        served = undefined;

        const lookup = await core.get(target);

        expect(lookup.source).toBe("stale");
        expect(lookup.problem).toBe("Could not read fake.test/acme/recipes.");
        expect(lookup.failure?.attempts).toEqual([{ strategy: "HTTP", reason: "404 not found" }]);
        expect(core.readMeta(IDENTITY)?.lastCheckedAt).toBe(now.toISOString());
        expect(core.isFresh(IDENTITY, 300)).toBe(true);
    });

    it("should raise when upstream fails and nothing is cached", async () => {
        served = undefined;

        await expect(core.get(target)).rejects.toBeInstanceOf(IndexReadError);
    });

    it("should raise a readable error when the published index is not valid JSON", async () => {
        reply = () => ({ ok: true, text: "{ nope", ref: "HEAD" });

        await expect(core.get(target)).rejects.toThrow(/is not valid JSON/);
    });

    it("should raise when no host reads the URL", async () => {
        await expect(core.get({ ...target, url: "https://elsewhere.test/x/y" })).rejects.toThrow(/No repository host reads/);
    });

    it("should use the cache offline (--installed), and fail offline with nothing cached", async () => {
        await expect(core.get(target, { offline: true })).rejects.toThrow(/never been fetched/);

        await core.get(target);
        later(10_000);

        expect((await core.get(target, { offline: true })).source).toBe("cache");
        expect(reads).toHaveLength(1);
    });

    it("should hand a cancel signal to the read", async () => {
        const controller = new AbortController();

        await core.get(target, { signal: controller.signal });

        expect(reads[0].signal).toBe(controller.signal);
    });

    it("should forget a cached index and its sidecar", async () => {
        await core.get(target);
        core.forget(IDENTITY);

        expect(fs.existsSync(core.indexPath(IDENTITY))).toBe(false);
        expect(fs.existsSync(core.sidecarPath(IDENTITY))).toBe(false);
        expect(core.sidecarPath(IDENTITY).endsWith(`recipes${INDEX_SIDECAR_SUFFIX}`)).toBe(true);
    });

    it("should fold an overlay into fetched and cached indexes without writing it to disk", async () => {
        core.setOverlay((identity, value) => (identity === IDENTITY ? { ...value, namespaces: { ...value.namespaces, extra: {} } } : value));

        expect((await core.get(target)).index.namespaces.extra).toEqual({});
        expect(core.readCached(IDENTITY)?.namespaces.extra).toEqual({});
        expect(core.readRaw(IDENTITY)?.namespaces.extra).toBeUndefined();
        expect(fs.readFileSync(core.indexPath(IDENTITY), "utf8")).not.toContain("extra");
    });

    it("should use the published index when an overlay throws", async () => {
        core.setOverlay(() => {
            throw new Error("boom");
        });

        expect((await core.get(target)).index.recipes["workflow/alpha"]).toBeDefined();
    });

    it("should keep the first overlay with setOverlayIfNone", () => {
        const first = (_: string, value: IndexFile) => value;

        core.setOverlay(first);
        core.setOverlayIfNone(() => {
            throw new Error("not this one");
        });
        core.writeIndex(IDENTITY, index());

        expect(core.readCached(IDENTITY)).toBeDefined();
    });

    it("should read upstream without writing anything with fetchUpstream", async () => {
        const fetched = await core.fetchUpstream(target);

        expect(fetched.recipes["workflow/alpha"]).toBeDefined();
        expect(fs.existsSync(core.indexPath(IDENTITY))).toBe(false);
        expect(core.readMeta(IDENTITY)).toBeUndefined();
    });

    it("should treat a damaged cached copy as absent", () => {
        fs.mkdirSync(path.dirname(core.indexPath(IDENTITY)), { recursive: true });
        fs.writeFileSync(core.indexPath(IDENTITY), "{}", "utf8");

        expect(core.readCached(IDENTITY)).toBeUndefined();
    });
});

describe("IndexCacheService", () => {
    let trusted: Record<string, RepoEntry>;
    let links: Record<string, string>;
    let service: IndexCacheService;

    beforeEach(() => {
        trusted = { acme: { url: URL } };
        links = {};
        service = new IndexCacheService(core, {
            trusted: () => trusted,
            identity: () => IDENTITY,
            freshnessSeconds: () => 300,
            linkedPath: (repo) => links[repo],
        });
    });

    it("should look a repository up by the project's short name", async () => {
        expect((await service.get("acme")).source).toBe("network");
        expect(service.cached("acme")?.source).toBe("cache");
        expect(service.isFresh("acme")).toBe(true);
        expect(service.meta("acme")?.identity).toBe(IDENTITY);
    });

    it("should say a repository the project does not trust is not found", async () => {
        await expect(service.get("nope")).rejects.toThrow(/does not trust a repository named 'nope'/);
    });

    it("should read a linked checkout's own index as source link", async () => {
        const checkout = path.join(dir, "checkout");

        fs.mkdirSync(checkout);
        fs.writeFileSync(path.join(checkout, "sous.index.json"), JSON.stringify(index("9.0.0")), "utf8");
        links.acme = checkout;

        const lookup = await service.get("acme");

        expect(lookup.source).toBe("link");
        expect(Object.keys(lookup.index.recipes["workflow/alpha"].versions)).toEqual(["9.0.0"]);
        expect(reads).toHaveLength(0);
    });

    it("should list the failures of getAll instead of throwing", async () => {
        trusted = { acme: { url: URL }, other: { url: URL } };
        served = undefined;

        const all = await service.getAll();

        expect(all.indexes).toEqual([]);
        expect(all.failed.map((failure) => failure.repo)).toEqual(["acme", "other"]);
    });

    it("should forget a repository by short name", async () => {
        await service.get("acme");
        await service.forget("acme");

        expect(service.cached("acme")).toBeUndefined();
    });
});
