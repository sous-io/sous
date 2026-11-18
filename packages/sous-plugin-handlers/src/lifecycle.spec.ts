import { describe, expect, it } from "vitest";
import { recordMoves, runPendingMigrations } from "./lifecycle.js";

describe("recordMoves()", () => {
    /**
     * recordMoves remembers each pin that moved, keeping the first `from` when a pin moves twice
     * before its migration runs, and forgetting it when it moves back. A version pinned for one
     * holder alone, and an added pin, are not moves.
     *
     * 1.0.0 -> 1.5.0, then 1.5.0 -> 2.0.0  // -> { from: "1.0.0", to: "2.0.0" }
     */
    it("should keep the first from across moves, and drop a pin that moved back or belongs to one holder", () => {
        const pending = new Map<string, { from: string; to: string }>();

        recordMoves(pending, [
            { key: "a/one", from: "1.0.0", to: "1.5.0" },
            { key: "b/lib", from: "1.0.0", to: "2.0.0", holder: "a/one" },
            { key: "c/new", to: "1.0.0" },
        ]);
        recordMoves(pending, [{ key: "a/one", from: "1.5.0", to: "2.0.0" }]);

        expect([...pending]).toEqual([["a/one", { from: "1.0.0", to: "2.0.0" }]]);

        recordMoves(pending, [{ key: "a/one", from: "2.0.0", to: "1.0.0" }]);

        expect(pending.size).toBe(0);
    });
});

describe("runPendingMigrations()", () => {
    /**
     * runPendingMigrations runs `handlers.migrate` for each waiting recipe that is active at its new
     * version, in the active recipes' (the lockfile's) order; one not there yet keeps waiting.
     */
    it("should run the migrations whose new version is active, in lockfile order, and keep the rest waiting", async () => {
        const pending = new Map([
            ["b/two", { from: "1.0.0", to: "2.0.0" }],
            ["a/one", { from: "1.0.0", to: "3.0.0" }],
            ["c/three", { from: "1.0.0", to: "2.0.0" }],
        ]);
        const ran: unknown[] = [];
        const ctx = {
            entities: {
                kinds: () => ["active-recipe"],
                list: () => [
                    { id: "a/one", version: "3.0.0" },
                    { id: "b/two", version: "2.0.0" },
                    { id: "c/three", version: "1.0.0" },
                ],
            },
            run: async (intent: string, input: unknown) => {
                ran.push([intent, input]);
            },
        };

        await runPendingMigrations(pending, ctx as never);

        expect(ran).toEqual([
            ["handlers.migrate", { recipe: "a/one", from: "1.0.0", to: "3.0.0" }],
            ["handlers.migrate", { recipe: "b/two", from: "1.0.0", to: "2.0.0" }],
        ]);
        expect([...pending.keys()]).toEqual(["c/three"]);
    });
});
