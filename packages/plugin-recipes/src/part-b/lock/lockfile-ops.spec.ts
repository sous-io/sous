import { describe, expect, it } from "vitest";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { ResolvedRecipe } from "../../types.js";
import { applyResolution, describeLockDiff, diffLockfiles, emptyLockfile, heldVersions, keysHeldBySubscription, lockedClosure, lockedVersions, removeHolder } from "./lockfile-ops.js";

const HASH = `sha256-${"a".repeat(64)}` as const;
const URL = "https://github.com/acme/recipes";

function resolved(key: string, overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
    const [namespace, name] = key.split("/");

    return {
        key,
        namespace,
        name,
        repo: "acme",
        identity: "github.com/acme/recipes",
        version: "1.0.0",
        hash: HASH,
        tag: `${key}@1.0.0`,
        path: `recipes/${key}`,
        kind: "subscribes",
        requestedBy: ["project"],
        ranges: [{ range: "*", requestedBy: "project" }],
        prerelease: false,
        ...overrides,
    };
}

function lock(recipes: Lockfile["recipes"], repos: Lockfile["repos"] = { acme: { url: URL, identity: "github.com/acme/recipes" } }): Lockfile {
    return { formatVersion: 1, repos, recipes };
}

describe("applyResolution", () => {
    it("should pin each resolved recipe and record its repository with identity", () => {
        const after = applyResolution(emptyLockfile(), [resolved("workflow/a")], { acme: { url: URL, identity: "github.com/acme/recipes" } });

        expect(after.recipes["workflow/a"]).toEqual({ repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" });
        expect(after.repos.acme).toEqual({ url: URL, identity: "github.com/acme/recipes" });
    });

    it("should merge holders with those already recorded rather than replace them", () => {
        const before = lock({ "workflow/a": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" } });
        const after = applyResolution(before, [resolved("workflow/a", { requestedBy: ["workflow/b"], kind: "depends" })], {});

        expect(after.recipes["workflow/a"].requestedBy).toEqual(["project", "workflow/b"]);
        expect(after.recipes["workflow/a"].kind).toBe("subscribes");
    });

    it("should carry through recipes the resolution did not mention, and sort keys", () => {
        const before = lock({ "z/z": { repo: "acme", version: "2.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" } });
        const after = applyResolution(before, [resolved("a/a")], {});

        expect(Object.keys(after.recipes)).toEqual(["a/a", "z/z"]);
    });

    it("should work out an identity from the URL when none is given", () => {
        const after = applyResolution(emptyLockfile(), [resolved("workflow/a")], { acme: { url: URL } }, () => "derived/identity");

        expect(after.repos.acme.identity).toBe("derived/identity");
    });

    it("should refuse a repository whose URL nothing knows", () => {
        expect(() => applyResolution(emptyLockfile(), [resolved("workflow/a", { repo: "ghost" })], {})).toThrow(/nothing knows that repository's URL/);
    });
});

describe("removeHolder", () => {
    it("should drop a recipe once its last holder goes, cascading to what it held", () => {
        const before = lock({
            "w/a": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
            "w/b": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["w/a"], kind: "depends" },
            "w/c": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["w/b", "project"], kind: "subscribes" },
        });
        const after = removeHolder(before, "project");

        expect(Object.keys(after.recipes)).toEqual([]);
        expect(after.repos).toEqual({});
    });

    it("should keep an entry another holder still holds", () => {
        const before = lock({
            "w/a": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project", "w/b"], kind: "subscribes" },
            "w/b": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
        });
        const after = removeHolder(before, "w/b");

        expect(after.recipes["w/a"].requestedBy).toEqual(["project"]);
        expect(after.recipes["w/b"]).toBeDefined();
    });

    it("should refuse a lockfile that pins a recipe to a repository it does not describe", () => {
        const before = lock({ "w/a": { repo: "ghost", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" } }, {});

        expect(() => removeHolder(before, "nobody", "/p/.sous/sous.lock.json")).toThrow(/repositories it does not describe: ghost/);
    });
});

describe("lockedClosure and keysHeldBySubscription", () => {
    const sample = lock({
        "w/a": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
        "w/b": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["w/a"], kind: "depends" },
        "w/c": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["other/x"], kind: "depends" },
        "t/d": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
    });

    it("should walk holders from the roots", () => {
        expect(lockedClosure(sample, ["w/a", "missing/key"])).toEqual(["w/a", "w/b"]);
    });

    it("should give a recipe subscription its own key and a namespace every project-held key in it", () => {
        expect(keysHeldBySubscription(sample, "w/a")).toEqual(["w/a"]);
        expect(keysHeldBySubscription(sample, "w/b")).toEqual([]);
        expect(keysHeldBySubscription(sample, "w")).toEqual(["w/a"]);
    });
});

describe("diffLockfiles and describeLockDiff", () => {
    it("should list what was added, updated and removed, and repositories that came and went", () => {
        const before = lock({
            "w/a": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
            "w/old": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
        });
        const after = lock(
            {
                "w/a": { repo: "acme", version: "1.1.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
                "x/new": { repo: "other", version: "2.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
            },
            { acme: { url: URL }, other: { url: "https://github.com/o/r" } },
        );
        const diff = diffLockfiles(before, after);

        expect(diff).toMatchObject({
            added: [{ key: "x/new", to: "2.0.0" }],
            updated: [{ key: "w/a", from: "1.0.0", to: "1.1.0" }],
            removed: [{ key: "w/old", from: "1.0.0" }],
            reposAdded: ["other"],
            reposRemoved: [],
            unchanged: false,
        });
        expect(describeLockDiff(diff)).toEqual([
            "Repository added: other",
            "Adding x/new version 2.0.0",
            "Updating w/a from version 1.0.0 to version 1.1.0",
            "Removing w/old, which nothing needs any more",
        ]);
    });

    /**
     * A pin moving to a lower version is worded as a move down, not as an update (#204 bug 49).
     *
     * describeLockDiff({ updated: [{ key: "acme/widget", from: "1.0.0", to: "0.1.0" }] })
     * // -> ["Moving acme/widget down from version 1.0.0 to version 0.1.0"]
     */
    it("should word a move to a lower version as a move down", () => {
        const before = lock({ "acme/widget": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" } });
        const after = lock({ "acme/widget": { repo: "acme", version: "0.1.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" } });

        expect(describeLockDiff(diffLockfiles(before, after))).toEqual(["Moving acme/widget down from version 1.0.0 to version 0.1.0"]);
    });

    it("should say nothing changed for equal lockfiles", () => {
        const diff = diffLockfiles(emptyLockfile(), emptyLockfile());

        expect(diff.unchanged).toBe(true);
        expect(describeLockDiff(diff)).toEqual(["Nothing changed."]);
    });
});

describe("versions pinned for one holder (ADR 0023, decision 4)", () => {
    const OTHER = `sha256-${"b".repeat(64)}` as const;
    const pinned = (): Lockfile =>
        lock({
            "lib/base": { repo: "acme", version: "2.0.0", hash: HASH, requestedBy: ["w/one", "w/two"], kind: "depends", pins: { "w/one": { version: "1.0.0", hash: OTHER } } },
            "w/one": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
            "w/two": { repo: "acme", version: "1.0.0", hash: HASH, requestedBy: ["project"], kind: "subscribes" },
        });

    /**
     * A resolution's per-holder pins are written under the entry's `pins`, keyed by holder.
     *
     * lib/base 2.0.0 with a pin 1.0.0 for w/one // -> pins: { "w/one": { version: "1.0.0", hash } }
     */
    it("should write a resolution's per-holder pins", () => {
        const after = applyResolution(
            emptyLockfile(),
            [resolved("lib/base", { version: "2.0.0", kind: "depends", requestedBy: ["w/one", "w/two"], pins: [{ holder: "w/one", version: "1.0.0", hash: OTHER, tag: "lib/base@1.0.0" }] })],
            { acme: { url: URL } },
        );

        expect(after.recipes["lib/base"]).toEqual(pinned().recipes["lib/base"]);
    });

    /**
     * A holder the new resolution lets share the version loses its old pin.
     *
     * before: pinned 1.0.0 for w/one; resolution: no pins // -> no `pins` key at all
     */
    it("should drop a pin when the resolution lets its holder share the version", () => {
        const after = applyResolution(pinned(), [resolved("lib/base", { version: "2.0.0", kind: "depends", requestedBy: ["w/one", "w/two"] })], {});

        expect(after.recipes["lib/base"]).not.toHaveProperty("pins");
    });

    /**
     * Removing a holder removes its pin with it.
     *
     * removeHolder(lock, "w/one") // -> lib/base held by w/two, no pins
     */
    it("should remove a holder's pin with the holder", () => {
        const after = removeHolder(pinned(), "w/one");

        expect(after.recipes["lib/base"]).toEqual({ repo: "acme", version: "2.0.0", hash: HASH, requestedBy: ["w/two"], kind: "depends" });
    });

    /**
     * Every version an entry pins is listed, the shared one first; they are what the store keeps.
     */
    it("should list every version an entry pins", () => {
        expect(lockedVersions(pinned().recipes["lib/base"]!)).toEqual([
            { version: "2.0.0", hash: HASH },
            { version: "1.0.0", hash: OTHER, holder: "w/one" },
        ]);
    });

    /**
     * A resolve holds the shared versions and each holder's own pin, except for the keys left out.
     */
    it("should hold the shared versions and the per-holder pins", () => {
        expect(heldVersions(pinned(), ["w/two"])).toEqual({ keep: { "lib/base": "2.0.0", "w/one": "1.0.0" }, keepPins: { "lib/base": { "w/one": "1.0.0" } } });
    });

    /**
     * A pin that appears, moves or goes is a change of its own, worded with its holder.
     */
    it("should report a change to a holder's own pin", () => {
        const before = pinned();
        const after = pinned();

        after.recipes["lib/base"] = { ...after.recipes["lib/base"]!, pins: { "w/one": { version: "1.1.0", hash: OTHER } } };

        const diff = diffLockfiles(before, after);

        expect(diff.updated).toEqual([{ key: "lib/base", holder: "w/one", from: "1.0.0", to: "1.1.0" }]);
        expect(describeLockDiff(diff)).toEqual(["Updating lib/base from version 1.0.0 to version 1.1.0 for w/one alone"]);
        expect(describeLockDiff(diffLockfiles(emptyLockfile(), before))).toContain("Adding lib/base version 1.0.0 for w/one alone");
    });
});
