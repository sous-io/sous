import { describe, expect, it } from "vitest";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import { effectiveRangeForHolders, findNewerInRange, shouldCheckUpstream, withDeadline } from "./freshness.js";

const HASH = `sha256-${"c".repeat(64)}` as const;

function index(versions: Record<string, boolean>): IndexFile {
    return {
        formatVersion: 1,
        name: "acme",
        generatedAt: "2026-01-01T00:00:00.000Z",
        generator: "0.2.34",
        namespaces: { w: {} },
        recipes: {
            "w/a": {
                path: "recipes/w/a",
                versions: Object.fromEntries(Object.entries(versions).map(([version, prerelease]) => [version, { hash: HASH, tag: `w/a@${version}`, prerelease }])),
            },
        },
    };
}

describe("shouldCheckUpstream", () => {
    const last = "2026-01-01T00:00:00.000Z";

    it("should check when never checked, forced, or the time is unreadable", () => {
        expect(shouldCheckUpstream({})).toBe(true);
        expect(shouldCheckUpstream({ lastCheckedAt: last, force: true, now: new Date(last) })).toBe(true);
        expect(shouldCheckUpstream({ lastCheckedAt: "yesterday-ish" })).toBe(true);
    });

    it("should honour the freshness window", () => {
        expect(shouldCheckUpstream({ lastCheckedAt: last, freshnessSeconds: 300, now: new Date("2026-01-01T00:01:00.000Z") })).toBe(false);
        expect(shouldCheckUpstream({ lastCheckedAt: last, freshnessSeconds: 300, now: new Date("2026-01-01T00:06:00.000Z") })).toBe(true);
        expect(shouldCheckUpstream({ lastCheckedAt: last, now: new Date("2026-01-01T00:04:00.000Z") })).toBe(false);
    });

    it("should check when the window is zero or the last check lies in the future", () => {
        expect(shouldCheckUpstream({ lastCheckedAt: last, freshnessSeconds: 0, now: new Date(last) })).toBe(true);
        expect(shouldCheckUpstream({ lastCheckedAt: last, now: new Date("2025-12-31T00:00:00.000Z") })).toBe(true);
    });
});

describe("findNewerInRange", () => {
    it("should find the newest in-range version above the locked one", () => {
        expect(findNewerInRange({ index: index({ "1.0.0": false, "1.2.0": false, "2.0.0": false }), key: "w/a", lockedVersion: "1.0.0", range: "^1" })).toEqual({ key: "w/a", from: "1.0.0", to: "1.2.0" });
    });

    it("should give nothing when the locked version is already the best, or the recipe is unknown", () => {
        expect(findNewerInRange({ index: index({ "1.0.0": false }), key: "w/a", lockedVersion: "1.0.0" })).toBeUndefined();
        expect(findNewerInRange({ index: index({ "1.0.0": false }), key: "w/z", lockedVersion: "1.0.0" })).toBeUndefined();
    });

    it("should leave prereleases out unless asked", () => {
        const published = index({ "1.0.0": false, "1.1.0-beta.1": true });

        expect(findNewerInRange({ index: published, key: "w/a", lockedVersion: "1.0.0" })).toBeUndefined();
        expect(findNewerInRange({ index: published, key: "w/a", lockedVersion: "1.0.0", prerelease: true })?.to).toBe("1.1.0-beta.1");
    });
});

describe("effectiveRangeForHolders", () => {
    const lookup = {
        subscriptionRange: (key: string) => (key === "w/a" ? "^1" : undefined),
        dependencyRange: (holder: string) => (holder === "w/b" ? ">=1.1.0" : holder === "w/star" ? "*" : undefined),
    };

    it("should combine every holder's range", () => {
        expect(effectiveRangeForHolders("w/a", ["project", "w/b"], lookup)).toBe("^1 >=1.1.0");
    });

    it("should give * when every holder allows anything", () => {
        expect(effectiveRangeForHolders("w/x", ["w/star"], lookup)).toBe("*");
    });

    it("should give undefined when a holder cannot be read, or nothing holds it", () => {
        expect(effectiveRangeForHolders("w/a", ["project", "w/unknown"], lookup)).toBeUndefined();
        expect(effectiveRangeForHolders("w/a", [], lookup)).toBeUndefined();
    });
});

describe("withDeadline", () => {
    it("should give the work's result when it finishes in time", async () => {
        await expect(withDeadline(async () => 42, 1000)).resolves.toBe(42);
    });

    it("should reject at the deadline and abort the work's signal", async () => {
        let aborted = false;

        await expect(
            withDeadline(
                (signal) =>
                    new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            aborted = true;
                            setTimeout(resolve, 50);
                        });
                    }),
                10,
            ),
        ).rejects.toThrow(/did not answer within 0\.0 seconds|did not answer within/);
        expect(aborted).toBe(true);
    });
});
