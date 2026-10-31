import type { Lockfile } from "@sous-io/plugin-formats/types";
import { describe, expect, it } from "vitest";
import type { ResolvedRecipe } from "../types.js";
import { covers, dropProjectHold, mergeHolders, releaseDroppedHolds, stayedAfter } from "./lock-holds.js";

const hash = "sha256-aa" as const;

function lockOf(recipes: Record<string, { requestedBy: string[]; version?: string; kind?: "subscribes" | "depends" }>): Lockfile {
    return {
        formatVersion: 1,
        repos: { r: { url: "https://github.com/acme/r", identity: "github.com/acme/r" } },
        recipes: Object.fromEntries(
            Object.entries(recipes).map(([key, entry]) => [key, { repo: "r", version: entry.version ?? "1.0.0", hash, requestedBy: entry.requestedBy, kind: entry.kind ?? "subscribes" }]),
        ),
    };
}

function resolved(key: string, requestedBy: string[], version = "1.0.0"): ResolvedRecipe {
    const [namespace, name] = key.split("/") as [string, string];

    return { key, namespace, name, repo: "r", identity: "github.com/acme/r", version, hash, tag: `${key}@${version}`, path: key, kind: "subscribes", requestedBy, ranges: [], prerelease: false };
}

describe("dropProjectHold", () => {
    /** A recipe something else still holds stays, minus the project's hold. */
    it("should keep a recipe another recipe holds", () => {
        const lock = lockOf({ "a/x": { requestedBy: ["b/y", "project"] }, "b/y": { requestedBy: ["project"] } });
        const after = dropProjectHold(lock, "a/x");

        expect(after.recipes["a/x"]?.requestedBy).toEqual(["b/y"]);
    });

    /** A recipe held only by the project goes, and so does whatever only it held. */
    it("should remove a recipe and what only it held, refcounted", () => {
        const lock = lockOf({ "a/x": { requestedBy: ["project"] }, "c/dep": { requestedBy: ["a/x"], kind: "depends" }, "c/shared": { requestedBy: ["a/x", "project"] } });
        const after = dropProjectHold(lock, "a/x");

        expect(Object.keys(after.recipes)).toEqual(["c/shared"]);
        expect(after.recipes["c/shared"]?.requestedBy).toEqual(["project"]);
        expect(stayedAfter(after, ["a/x", "c/shared"])).toEqual([{ key: "c/shared", heldBy: ["project"] }]);
    });
});

describe("releaseDroppedHolds", () => {
    /** A newer version that no longer depends on something lets go of it. */
    it("should release a dependency a re-resolved holder dropped", () => {
        const lock = lockOf({ "a/x": { requestedBy: ["project"] }, "c/dep": { requestedBy: ["a/x"], kind: "depends" } });
        const merged = new Map([["a/x", resolved("a/x", ["project"], "2.0.0")]]);
        const after = releaseDroppedHolds(lock, merged, ["a/x"], []);

        expect(Object.keys(after.recipes)).toEqual(["a/x"]);
    });

    /** A subscription not resolved again keeps its holds. */
    it("should keep the holds of subscriptions left alone", () => {
        const lock = lockOf({ "a/x": { requestedBy: ["project"] }, "b/y": { requestedBy: ["project"] } });
        const merged = new Map([["a/x", resolved("a/x", ["project"])]]);
        const after = releaseDroppedHolds(lock, merged, ["a"], ["b"]);

        expect(Object.keys(after.recipes).sort()).toEqual(["a/x", "b/y"]);
    });

    /** A namespace that stopped publishing a recipe stops holding it. */
    it("should release a recipe a namespace no longer publishes", () => {
        const lock = lockOf({ "a/x": { requestedBy: ["project"] }, "a/gone": { requestedBy: ["project"] } });
        const merged = new Map([["a/x", resolved("a/x", ["project"])]]);
        const after = releaseDroppedHolds(lock, merged, ["a"], []);

        expect(Object.keys(after.recipes)).toEqual(["a/x"]);
    });
});

describe("mergeHolders and covers", () => {
    /** Two resolutions of one version keep every holder, and a co-subscription wins. */
    it("should union holders", () => {
        const left = { ...resolved("a/x", ["project"]), kind: "depends" as const };
        const right = resolved("a/x", ["b/y"]);

        expect(mergeHolders(left, right)).toMatchObject({ requestedBy: ["b/y", "project"], kind: "subscribes" });
    });

    /** A namespace cover covers its recipes, and nothing else. */
    it("should match covers", () => {
        expect(covers("a", "a/x")).toBe(true);
        expect(covers("a", "ab/x")).toBe(false);
        expect(covers(undefined, "a/x")).toBe(false);
    });
});
