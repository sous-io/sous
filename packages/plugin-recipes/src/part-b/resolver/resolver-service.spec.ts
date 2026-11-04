import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/plugin-api";
import { cleanTemp, fakeHost, fakeUrl, indexFile, startEngine, tempDir } from "../../../test/part-b/helpers.js";
import type { ResolverService } from "./resolver-service.js";

const URL = fakeUrl("acme", "recipes");
const HASH = `sha256-${"f".repeat(64)}` as const;

let home: string;
let root: string;

beforeEach(() => {
    home = tempDir();
    root = tempDir();
});

afterEach(() => cleanTemp());

async function resolver(subscriptions: JsonObject) {
    const repo = {
        url: URL,
        index: indexFile("acme", {
            "workflow/alpha": { versions: { "1.0.0": { hash: HASH }, "1.3.0": { hash: HASH }, "2.0.0": { hash: HASH } } },
            "workflow/beta": { versions: { "0.1.0": { hash: HASH, depends: ["workflow/alpha@^1"] } } },
        }),
        trees: {},
    };
    const { engine } = await startEngine({
        root,
        home,
        data: () => ({ repos: { acme: { url: URL }, "sous-recipes": { enabled: false } }, subscriptions }),
        hosts: [fakeHost([repo])],
    });

    return engine.config.services.get("recipes.resolver") as ResolverService;
}

describe("ResolverService", () => {
    it("should resolve every switched-on subscription against the trusted repositories' indexes", async () => {
        const service = await resolver({ "workflow/alpha": { range: "^1" }, "workflow/beta": { enabled: false } });
        const result = await service.resolveSubscriptions();

        expect(result.resolved.map((recipe) => `${recipe.key}@${recipe.version}`)).toEqual(["workflow/alpha@1.3.0"]);
        expect(result.missingRepos).toEqual([]);
    });

    it("should walk what a version's index entry declares when its files are not here", async () => {
        const result = await (await resolver({ "workflow/beta": {} })).resolveSubscriptions();

        expect(result.resolved.map((recipe) => `${recipe.key}@${recipe.version}`)).toEqual(["workflow/alpha@1.3.0", "workflow/beta@0.1.0"]);
        expect(result.unreadable).toEqual(["workflow/alpha"]);
    });

    it("should hold kept versions", async () => {
        const result = await (await resolver({ "workflow/alpha": {} })).resolveSubscriptions({ keep: { "workflow/alpha": "1.0.0" } });

        expect(result.resolved[0].version).toBe("1.0.0");
    });

    it("should say which locked keys the switched-on subscriptions reach", async () => {
        const service = await resolver({ workflow: {} });
        const pin = (requestedBy: string[]) => ({ repo: "acme", version: "1.0.0", hash: HASH, requestedBy, kind: "subscribes" as const });

        expect(
            service.reachable({ formatVersion: 1, repos: { acme: { url: URL } }, recipes: { "workflow/alpha": pin(["project"]), "workflow/beta": pin(["project"]) } }),
        ).toEqual(["workflow/alpha", "workflow/beta"]);
        expect(service.keyOf("acme:workflow/alpha")).toBe("workflow/alpha");
        expect(fs.existsSync(path.join(root, ".sous"))).toBe(true);
    });
});

describe("ResolverService: a ref missing from a cached index (#133)", () => {
    /** A resolver whose repository's index can be changed upstream after sous cached it. */
    async function withUpstream() {
        const repo = {
            url: URL,
            index: indexFile("acme", { "workflow/alpha": { versions: { "1.0.0": { hash: HASH } } } }),
            trees: {},
        };
        const calls = { reads: [] as string[], fetches: [] };
        const { engine } = await startEngine({
            root,
            home,
            data: () => ({ repos: { acme: { url: URL }, "sous-recipes": { enabled: false } }, subscriptions: { "workflow/alpha": {} } }),
            hosts: [fakeHost([repo], calls)],
        });
        const service = engine.config.services.get("recipes.resolver") as ResolverService;

        // Reads and caches the index; it stays fresh for five minutes.
        await service.resolveSubscriptions();
        calls.reads.length = 0;

        return { service, repo, calls };
    }

    /**
     * A recipe released after sous cached the index is found: the miss reads the index upstream once
     * and resolves again.
     *
     * // cached: workflow/alpha; upstream now also publishes workflow/gamma
     * service.resolve([workflow/gamma]) // -> workflow/gamma@1.0.0
     */
    it("should read the index upstream once and find a recipe released after it was cached", async () => {
        const { service, repo, calls } = await withUpstream();

        repo.index = indexFile("acme", { "workflow/alpha": { versions: { "1.0.0": { hash: HASH } } }, "workflow/gamma": { versions: { "1.0.0": { hash: HASH } } } });

        const result = await service.resolve([service.subscriptionRequest("workflow/gamma")]);

        expect(result.resolved.map((recipe) => `${recipe.key}@${recipe.version}`)).toEqual(["workflow/gamma@1.0.0"]);
        expect(calls.reads).toEqual([URL]);
    });

    /**
     * A recipe that is truly missing is reported as checked just now, and asking again in the same
     * run reads nothing more upstream.
     *
     * service.resolve([workflow/nope]) // -> "None of this project's repositories publishes…", "Checked just now: acme."
     */
    it("should report a recipe nobody publishes as checked just now, reading upstream only once", async () => {
        const { service, calls } = await withUpstream();
        const request = service.subscriptionRequest("workflow/nope");

        for (let attempt = 0; attempt < 2; attempt++) {
            await expect(service.resolve([request])).rejects.toMatchObject({
                message: "None of this project's repositories publishes the recipe 'workflow/nope'.",
                details: expect.arrayContaining(["Checked just now: acme."]),
            });
        }

        expect(calls.reads).toEqual([URL]);
    });
});
