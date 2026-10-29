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
