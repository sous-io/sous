import { describe, expect, it } from "vitest";
import { orderMigrations, pendingMigrations, versionReached, versionToStore } from "./pending.js";
import type { MigrationEntity } from "./types.js";

const migration = (id: string, version: string, order = 500): MigrationEntity => ({ id, version, order, description: id, plugin: "p", up: () => undefined });

describe("orderMigrations()", () => {
    /**
     * Lowest version first, then lowest order, then the order they were added.
     *
     * b 1.2.0/500, a 1.1.0/900, c 1.1.0/100, d 1.1.0/900 -> c, a, d, b
     */
    it("should order by version, then order, then the order they were added", () => {
        const ordered = orderMigrations([migration("b", "1.2.0"), migration("a", "1.1.0", 900), migration("c", "1.1.0", 100), migration("d", "1.1.0", 900)]);

        expect(ordered.map((entry) => entry.id)).toEqual(["c", "a", "d", "b"]);
    });
});

describe("pendingMigrations()", () => {
    /**
     * Only the migrations of versions above the stored one are pending; with nothing stored, all.
     *
     * stored 1.1.0 -> 1.1.1, 1.2.0
     */
    it("should give the migrations above the stored version, or all of them with none stored", () => {
        const all = [migration("old", "1.0.5"), migration("same", "1.1.0"), migration("patch", "1.1.1"), migration("minor", "1.2.0")];

        expect(pendingMigrations(all, "1.1.0").map((entry) => entry.id)).toEqual(["patch", "minor"]);
        expect(pendingMigrations(all, undefined).map((entry) => entry.id)).toEqual(["old", "same", "patch", "minor"]);
        expect(pendingMigrations(all, "1.2.0")).toEqual([]);
    });
});

describe("versionToStore()", () => {
    /** The running version, unless a migration that ran names a higher one. */
    it("should store the running version, or the highest version that ran when it is higher", () => {
        expect(versionToStore("1.2.0", [migration("a", "1.1.0")])).toBe("1.2.0");
        expect(versionToStore("1.0.19", [migration("a", "1.1.0")])).toBe("1.1.0");
    });
});

describe("versionReached()", () => {
    /**
     * After a failure, the highest version all of whose migrations ran.
     *
     * pending 1.1.0 a, 1.1.0 b, 1.2.0 c, 1.2.0 d; ran a, b, c -> 1.1.0
     */
    it("should give the highest version every one of whose migrations ran", () => {
        const pending = [migration("a", "1.1.0"), migration("b", "1.1.0"), migration("c", "1.2.0"), migration("d", "1.2.0")];

        expect(versionReached(pending, pending.slice(0, 3))).toBe("1.1.0");
        expect(versionReached(pending, pending.slice(0, 1))).toBeUndefined();
        expect(versionReached(pending, pending)).toBe("1.2.0");
    });
});
