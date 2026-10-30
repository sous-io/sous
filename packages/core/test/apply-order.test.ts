import { describe, expect, it } from "vitest";
import { applyOrderKey, sortContributors } from "../src/config/order.js";
import { contributorsPlugin, keysPlugin, makeEngine } from "./helpers.js";

/** A contributor for `sortContributors`, with nothing declared unless given. */
function item(id: string, applyOrder = 0, declared: { before?: string[]; after?: string[] } = {}) {
    return { id, plugin: "p", applyOrder, before: declared.before ?? [], after: declared.after ?? [] };
}

function ids(items: ReturnType<typeof item>[]): string[] {
    return sortContributors(items).order.map((entry) => entry.id);
}

describe("apply order", () => {
    /** The sort key is the actual apply order padded to six digits, then the id. */
    it("should pad the apply order to six digits, then add the id", () => {
        expect(applyOrderKey(0, "a")).toBe("000000a");
        expect(applyOrderKey(90000, "config-files.main")).toBe("090000config-files.main");
        expect(applyOrderKey(100000, "late")).toBe("100000late");
    });

    /** Higher numbers apply later; equal numbers apply in id order, bytewise. */
    it("should sort by apply order, then by id", () => {
        expect(ids([item("late", 50), item("b"), item("a"), item("B")])).toEqual(["B", "a", "b", "late"]);
    });

    /** An actual apply order past 99999 still sorts by number, not as text of a different length. */
    it("should sort an actual apply order above 99999 after the ones below it", () => {
        const result = sortContributors([item("a-last", 99999), item("z-fixups", 0, { after: ["a-last"] }), item("m-other", 99998)]);

        expect(result.actualApplyOrder.get("z-fixups")).toBe(100000);
        expect(result.order.map((entry) => entry.id)).toEqual(["m-other", "a-last", "z-fixups"]);
    });

    /** `after` wins over a lower number: the contributor moves to one past the one it follows. */
    it("should move a contributor declared after another to one past it", () => {
        const result = sortContributors([item("fixups", 10, { after: ["late"] }), item("late", 50)]);

        expect(result.actualApplyOrder.get("fixups")).toBe(51);
        expect(result.order.map((entry) => entry.id)).toEqual(["late", "fixups"]);
        expect(result.adjustments).toEqual([
            'Apply order of "fixups" moves from 10 to 51, after "late" (50), because "fixups" declares after "late".',
        ]);
    });

    /** `before` wins over a higher number: the contributor moves to one less than the one it precedes. */
    it("should move a contributor declared before another to one less than it", () => {
        const result = sortContributors([item("early", 95000, { before: ["config-files.main"] }), item("config-files.main", 90000)]);

        expect(result.actualApplyOrder.get("early")).toBe(89999);
        expect(result.actualApplyOrder.get("config-files.main")).toBe(90000);
        expect(result.adjustments).toEqual([
            'Apply order of "early" moves from 95000 to 89999, before "config-files.main" (90000), because "early" declares before "config-files.main".',
        ]);
    });

    /** A declaration that already holds by number, or by id at an equal number, moves nothing. */
    it("should leave a contributor alone when its numbers already agree", () => {
        const result = sortContributors([item("a"), item("b", 0, { after: ["a"] }), item("c", 5, { before: ["d"] }), item("d", 9)]);

        expect([...result.actualApplyOrder.values()]).toEqual([0, 0, 5, 9]);
        expect(result.adjustments).toEqual([]);
    });

    /** A moved contributor carries the ones that must follow it, and so on down the chain. */
    it("should cascade a move through everything that must follow", () => {
        const result = sortContributors([
            item("a", 100),
            item("b", 0, { after: ["a"] }),
            item("c", 0, { after: ["b"] }),
            item("d", 500, { after: ["c"] }),
        ]);

        expect(Object.fromEntries(result.actualApplyOrder)).toEqual({ a: 100, b: 101, c: 102, d: 500 });
        expect(result.order.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
        expect(result.adjustments).toHaveLength(2);
    });

    /** Moving earlier cascades too: what must apply before a moved contributor moves earlier with it. */
    it("should cascade a move earlier through everything that must precede", () => {
        const result = sortContributors([item("x", 20, { before: ["y"] }), item("w", 30, { before: ["x"] }), item("y", 10)]);

        expect(Object.fromEntries(result.actualApplyOrder)).toEqual({ w: 8, x: 9, y: 10 });
        expect(result.order.map((entry) => entry.id)).toEqual(["w", "x", "y"]);
    });

    /** A `before` that cannot move below 0 moves the other contributor after it instead. */
    it("should move the other contributor when a before is held at 0", () => {
        const result = sortContributors([item("a"), item("z-first", 0, { before: ["a"] })]);

        expect(Object.fromEntries(result.actualApplyOrder)).toEqual({ a: 1, "z-first": 0 });
        expect(result.order.map((entry) => entry.id)).toEqual(["z-first", "a"]);
        expect(result.adjustments).toEqual(['Apply order of "a" moves from 0 to 1, after "z-first" (0), because "z-first" declares before "a".']);
    });

    /** When a number sits between two declarations that disagree, the declarations still all hold. */
    it("should meet every declaration when numbers and declarations disagree on both sides", () => {
        const result = sortContributors([item("p", 20), item("x", 50, { after: ["p"], before: ["y"] }), item("y", 10)]);
        const order = result.order.map((entry) => entry.id);

        expect(order.indexOf("p")).toBeLessThan(order.indexOf("x"));
        expect(order.indexOf("x")).toBeLessThan(order.indexOf("y"));
    });

    /** A cycle is still broken by name order and reported. */
    it("should break a cycle by name order", () => {
        const result = sortContributors([item("b", 0, { after: ["a"] }), item("a", 0, { after: ["b"] })]);

        expect(result.cycle).toEqual(["a"]);
        expect(result.order.map((entry) => entry.id)).toEqual(["a", "b"]);
    });

    /** `"*"` still works for any contributor: after every contributor that does not declare it. */
    it("should still put a contributor declared after * after the others", () => {
        expect(ids([item("a-last", 0, { after: ["*"] }), item("b", 40), item("c", 7)])).toEqual(["c", "b", "a-last"]);
    });

    /** A number outside 0 to 99999, or not a whole number, is refused when the contributor is added. */
    it("should refuse an apply order outside 0 to 99999", async () => {
        for (const applyOrder of [-1, 100000, 1.5, Number.NaN]) {
            const { engine } = makeEngine([contributorsPlugin("p", [{ id: "bad", applyOrder, contribute: () => {} }])]);

            await expect(engine.buildConfig()).rejects.toThrow(/declares applyOrder .*; it must be a whole number from 0 to 99999/);
        }

        const { engine } = makeEngine([contributorsPlugin("p", [{ id: "edge", applyOrder: 99999, contribute: () => {} }])]);

        await expect(engine.buildConfig()).resolves.toBeDefined();
    });

    /** Each move is logged once at the debug level, and the contributions show both numbers. */
    it("should log each move at the debug level and report both numbers", async () => {
        const { engine, reporter } = makeEngine([
            keysPlugin("value"),
            contributorsPlugin("p", [
                { id: "late", applyOrder: 50, contribute: (config) => config.atPath("value").set("late") },
                { id: "fixups", applyOrder: 10, after: ["late"], contribute: (config) => config.atPath("value").set("fixups") },
            ]),
        ]);

        const built = await engine.buildConfig();
        const message = 'Apply order of "fixups" moves from 10 to 51, after "late" (50), because "fixups" declares after "late".';

        expect(built.get("value")).toBe("fixups");
        expect(reporter.at("debug").filter((line) => line === message)).toHaveLength(1);
        expect(built.contributions().map((c) => [c.contributor, c.applyOrder, c.actualApplyOrder])).toEqual([
            ["late", 50, 50],
            ["fixups", 10, 51],
        ]);
        expect(built.layers("value").map((layer) => [layer.contributor, layer.actualApplyOrder])).toEqual([
            ["late", 50],
            ["fixups", 51],
        ]);
    });
});
