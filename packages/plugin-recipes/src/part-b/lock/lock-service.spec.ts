import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, type JsonObject } from "@sous-io/plugin-api";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import { cleanTemp, fakeHost, fakeUrl, hashOf, indexFile, startEngine, tempDir, writeRecipe, type FakeHostCalls, type FakeRepo } from "../../../test/part-b/helpers.js";
import type { RecipesLockedPayload, ResolvedRecipe } from "../../types.js";

const URL = fakeUrl("acme", "recipes");
const IDENTITY = "fake.test/acme/recipes";

let home: string;
let root: string;
let repo: FakeRepo;
let calls: FakeHostCalls;
let hash: `sha256-${string}`;
let locked: RecipesLockedPayload[];

const listener = definePlugin({
    name: "test-locked-listener",
    register(sous) {
        sous.on("recipes.locked", (event) => {
            locked.push(event.payload);
        });
    },
});

function config(subscriptions: JsonObject = { "workflow/alpha": {} }, repos: JsonObject = { acme: { url: URL } }): () => JsonObject {
    return () => ({ repos: { ...repos, "sous-recipes": { enabled: false } }, subscriptions });
}

function writeLock(lockfile: unknown): void {
    fs.mkdirSync(path.join(root, ".sous"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sous", "sous.lock.json"), JSON.stringify(lockfile), "utf8");
}

function pinned(extra: Partial<Lockfile> = {}): Lockfile {
    return {
        formatVersion: 1,
        repos: { acme: { url: URL, identity: IDENTITY } },
        recipes: { "workflow/alpha": { repo: "acme", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" } },
        ...extra,
    };
}

async function lockService(data = config()) {
    const { engine } = await startEngine({ root, home, data, hosts: [fakeHost([repo], calls)], plugins: [listener] });

    return { engine, lock: engine.config.services.get("recipes.lock") };
}

beforeEach(() => {
    home = tempDir();
    root = tempDir();
    const source = writeRecipe(path.join(tempDir(), "alpha"), { namespace: "workflow", name: "alpha", version: "1.0.0" }, { "a.md": "alpha" });

    hash = hashOf(source);
    repo = { url: URL, index: indexFile("acme", { "workflow/alpha": { versions: { "1.0.0": { hash } } } }), trees: { "recipes/workflow/alpha@workflow/alpha@1.0.0": source } };
    calls = { reads: [], fetches: [] };
    locked = [];
});

afterEach(() => cleanTemp());

describe("LockService.read", () => {
    it("should give an empty lockfile when the project has none", async () => {
        const { lock } = await lockService();

        expect(lock.read()).toEqual({ formatVersion: 1, repos: {}, recipes: {} });
        expect(lock.path()).toBe(path.join(root, ".sous", "sous.lock.json"));
    });

    it("should work out a repository identity an older lockfile lacks", async () => {
        writeLock({ ...pinned(), repos: { acme: { url: URL } } });

        const { lock } = await lockService(config({ "workflow/alpha": { enabled: false } }));

        expect(lock.read().repos.acme.identity).toBe(IDENTITY);
        expect(lock.get("workflow/alpha")?.version).toBe("1.0.0");
    });

    it("should explain a lockfile that is not JSON", async () => {
        const { lock } = await lockService();

        fs.writeFileSync(lock.path(), "{ not json", "utf8");

        expect(() => lock.read()).toThrow(/could not read the lockfile .* as JSON/);
    });
});

describe("LockService.write", () => {
    it("should write nothing on a dry run, and still say what would change", async () => {
        const { lock } = await lockService();
        const diff = await lock.write(pinned(), { dryRun: true });

        expect(diff.added).toEqual([{ key: "workflow/alpha", to: "1.0.0" }]);
        expect(fs.existsSync(lock.path())).toBe(false);
        expect(locked).toEqual([]);
    });

    it("should write the lockfile in its stable form and fire recipes.locked", async () => {
        const { lock } = await lockService();
        const diff = await lock.write(pinned());

        expect(JSON.parse(fs.readFileSync(lock.path(), "utf8")).recipes["workflow/alpha"].version).toBe("1.0.0");
        expect(fs.readFileSync(lock.path(), "utf8").endsWith("\n")).toBe(true);
        expect(locked).toEqual([{ path: lock.path(), diff }]);
        expect((await lock.write(pinned())).unchanged).toBe(true);
    });
});

describe("LockService.fromResolved", () => {
    const resolvedBeta: ResolvedRecipe = {
        key: "workflow/beta",
        namespace: "workflow",
        name: "beta",
        repo: "acme",
        identity: IDENTITY,
        version: "2.0.0",
        hash: `sha256-${"e".repeat(64)}`,
        tag: "workflow/beta@2.0.0",
        path: "recipes/workflow/beta",
        kind: "subscribes",
        requestedBy: ["project"],
        ranges: [{ range: "*", requestedBy: "project" }],
        prerelease: false,
    };

    it("should build the lockfile from what was resolved, dropping what nothing resolved", async () => {
        const { lock } = await lockService(config({ "workflow/beta": {} }));
        const next = lock.fromResolved([resolvedBeta], pinned());

        expect(Object.keys(next.recipes)).toEqual(["workflow/beta"]);
        expect(next.repos.acme).toMatchObject({ url: URL, identity: IDENTITY });
    });

    it("should keep the pins of a subscription switched off on this machine (S4, 2; C59)", async () => {
        const { lock } = await lockService(config({ "workflow/alpha": { enabled: false }, "workflow/beta": {} }));
        const next = lock.fromResolved([resolvedBeta], pinned());

        expect(Object.keys(next.recipes)).toEqual(["workflow/alpha", "workflow/beta"]);
        expect(next.recipes["workflow/alpha"].version).toBe("1.0.0");
    });

    it("should keep the pins of a repository switched off on this machine", async () => {
        const { lock } = await lockService(config({ "workflow/alpha": {} }, { acme: { url: URL, enabled: false } }));

        expect(Object.keys(lock.fromResolved([], pinned()).recipes)).toEqual(["workflow/alpha"]);
    });
});

describe("LockService.restore", () => {
    it("should download a pinned recipe the store lacks, then find it present", async () => {
        writeLock(pinned());

        const { lock } = await lockService(config({ "workflow/alpha": { enabled: false } }));

        expect(await lock.restore()).toEqual({ restored: [], alreadyPresent: [], failed: [] });
        expect(await lock.restore({ keys: ["workflow/alpha"] })).toEqual({ restored: ["workflow/alpha"], alreadyPresent: [], failed: [] });
        expect(await lock.restore({ keys: ["workflow/alpha"] })).toEqual({ restored: [], alreadyPresent: ["workflow/alpha"], failed: [] });
        expect(calls.fetches).toHaveLength(1);
    });

    it("should list a recipe it cannot download instead of throwing", async () => {
        writeLock(
            pinned({
                repos: { acme: { url: URL, identity: IDENTITY }, ghost: { url: fakeUrl("ghost", "repo"), identity: "fake.test/ghost/repo" } },
                recipes: {
                    "workflow/alpha": { repo: "acme", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
                    "spooky/x": { repo: "ghost", version: "1.0.0", hash, requestedBy: ["project"], kind: "subscribes" },
                },
            }),
        );

        const { lock } = await lockService(config({ "workflow/alpha": { enabled: false } }));

        repo.offline = "network unreachable";

        const report = await lock.restore({ keys: ["workflow/alpha", "spooky/x"] });

        expect(report.restored).toEqual([]);
        expect(report.failed.map((failure) => failure.key)).toEqual(["spooky/x", "workflow/alpha"]);
        expect(report.failed[0].reason).toMatch(/not trusted/);
    });
});

describe("LockService.removeHolder", () => {
    it("should drop the project's hold and what only it held", async () => {
        const { lock } = await lockService();
        const service = lock as typeof lock & { removeHolder(lockfile: Lockfile, holder: string): Lockfile };

        expect(service.removeHolder(pinned(), "project").recipes).toEqual({});
    });
});
