/**
 * The `recipes.cached-index` and `recipes.fetched-index` ref lookups on a real engine, asked
 * through `refs.resolver` (ported from the old `cached-index-lookup.spec.ts` and
 * `fetched-index-lookup.spec.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "@sous-io/core";
import type { SousRef } from "@sous-io/plugin-refs/types";
import { cleanTemp, fakeHost, fakeUrl, hashOf, indexFile, startEngine, tempDir, writeRecipe, type FakeHostCalls, type FakeRepo } from "../part-b/helpers.js";
import { CACHED_INDEX_LOOKUP_ID, FETCHED_INDEX_LOOKUP_ID } from "../../src/part-a/index-lookups.js";
import path from "node:path";

const ACME = fakeUrl("acme", "recipes");
const OTHER = fakeUrl("acme", "other");

let home: string;
let root: string;
let acme: FakeRepo;
let other: FakeRepo;
let calls: FakeHostCalls;

/** An index publishing the given recipe keys at `recipes/<key>`. */
function publishing(name: string, keys: string[], descriptions: Record<string, string> = {}): FakeRepo["index"] {
    const hash = hashOf(writeRecipe(path.join(tempDir(), "r"), { namespace: "x", name: "y", version: "1.0.0" }));

    return indexFile(name, Object.fromEntries(keys.map((key) => [key, { ...(descriptions[key] === undefined ? {} : { description: descriptions[key] }), versions: { "1.0.0": { hash } } }])));
}

/** A short description of a match: `kind:repo:key`. */
function keyOf(ref: SousRef): string {
    switch (ref.kind) {
        case "namespace":
            return `namespace:${ref.repo?.name ?? ref.repo?.location?.identity}:${ref.name}`;
        case "recipe":
            return `recipe:${ref.namespace?.repo?.name ?? ref.namespace?.repo?.location?.identity}:${ref.namespace?.name}/${ref.name}`;
        case "recipeFile":
            return `recipeFile:${ref.recipe.namespace?.repo?.name}:${ref.recipe.namespace?.name}/${ref.recipe.name}:${ref.path}`;
        case "repo":
            return `repo:${ref.name ?? ref.location?.identity}`;
        default:
            return ref.kind;
    }
}

async function engineFor(): Promise<Engine> {
    const { engine } = await startEngine({
        root,
        home,
        data: () => ({ repos: { acme: { url: ACME }, other: { url: OTHER }, "sous-recipes": { enabled: false } } }),
        hosts: [fakeHost([acme, other], calls)],
    });

    return engine;
}

/** Reads every trusted index into the cache, as `sous repo list --latest` would. */
async function fillCache(engine: Engine): Promise<void> {
    await engine.config.services.get("recipes.index-cache").getAll({ latest: true });
}

async function resolve(engine: Engine, input: string, lookups: string[]): Promise<string[]> {
    const result = await engine.config.services.get("refs.resolver").resolve({ input, lookups });

    return result.refs.map(keyOf);
}

beforeEach(() => {
    home = tempDir();
    root = tempDir();
    acme = { url: ACME, index: publishing("acme", ["workflow/task-files", "workflow/alpha", "tooling/lint"], { "workflow/alpha": "The alpha recipe" }), trees: {} };
    other = { url: OTHER, index: publishing("other", ["workflow/task-files"]), trees: {} };
    calls = { reads: [], fetches: [] };
});

afterEach(() => cleanTemp());

describe("recipes.cached-index", () => {
    it("should find a namespace by its bare name, in every repository publishing it", async () => {
        const engine = await engineFor();

        await fillCache(engine);

        expect((await resolve(engine, "workflow", [CACHED_INDEX_LOOKUP_ID])).filter((key) => key.startsWith("namespace"))).toEqual([
            "namespace:acme:workflow",
            "namespace:other:workflow",
        ]);
    });

    it("should find a recipe by its qualified name, and only in the repository named", async () => {
        const engine = await engineFor();

        await fillCache(engine);

        expect(await resolve(engine, "other:workflow/task-files", [CACHED_INDEX_LOOKUP_ID])).toEqual(["recipe:other:workflow/task-files"]);
    });

    it("should carry the publisher's description", async () => {
        const engine = await engineFor();

        await fillCache(engine);

        const result = await engine.config.services.get("refs.resolver").resolve({ input: "acme:workflow/alpha", lookups: [CACHED_INDEX_LOOKUP_ID] });

        expect(result.refs.map(keyOf)).toEqual(["recipe:acme:workflow/alpha"]);
        expect(result.refs[0]?.description).toBe("The alpha recipe");
    });

    it("should answer nothing, reading nothing upstream, when no index is cached", async () => {
        const engine = await engineFor();

        calls.reads.length = 0;

        expect(await resolve(engine, "acme:workflow/alpha", [CACHED_INDEX_LOOKUP_ID])).toEqual([]);
        expect(calls.reads).toEqual([]);
    });

    it("should be asked by default, whenever lookups are on", async () => {
        const engine = await engineFor();

        await fillCache(engine);

        const result = await engine.config.services.get("refs.resolver").resolve({ input: "tooling/lint" });

        expect(result.usedLookup).toBe(true);
        expect(result.refs.map(keyOf)).toContain("recipe:acme:tooling/lint");
    });
});

describe("recipes.fetched-index", () => {
    it("should read the trusted indexes upstream when asked for the latest", async () => {
        const engine = await engineFor();

        calls.reads.length = 0;

        expect(await resolve(engine, "acme:tooling/lint", ["latest"])).toEqual(["recipe:acme:tooling/lint"]);
        expect(calls.reads).toContain(ACME);
    });

    it("should not be asked unless a caller names it or its tag", async () => {
        const engine = await engineFor();

        calls.reads.length = 0;
        await engine.config.services.get("refs.resolver").resolve({ input: "acme:tooling/lint" });

        expect(calls.reads).toEqual([]);
    });

    it("should read the index of a repository written as a location, even one the project does not trust", async () => {
        const stranger: FakeRepo = { url: fakeUrl("someone", "else"), index: publishing("else", ["tools/x"]), trees: {} };
        const { engine } = await startEngine({ root, home, data: () => ({ repos: { "sous-recipes": { enabled: false } } }), hosts: [fakeHost([stranger], calls)] });

        const keys = await resolve(engine, `${stranger.url}/tools/x`, [FETCHED_INDEX_LOOKUP_ID]);

        expect(keys).toEqual(["recipe:fake.test/someone/else:tools/x"]);
    });

    it("should fail, naming the repository, when the index of a written location cannot be read", async () => {
        const broken: FakeRepo = { url: fakeUrl("someone", "broken"), index: undefined, trees: {} };
        const { engine } = await startEngine({ root, home, data: () => ({ repos: { "sous-recipes": { enabled: false } } }), hosts: [fakeHost([broken], calls)] });

        await expect(engine.config.services.get("refs.resolver").resolve({ input: `${broken.url}/tools/x`, lookups: [FETCHED_INDEX_LOOKUP_ID] })).rejects.toThrow(
            /its index could not be read/,
        );
    });
});
