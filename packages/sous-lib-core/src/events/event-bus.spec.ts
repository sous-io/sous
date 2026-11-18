import { describe, expect, it } from "vitest";
import { EventBus, matchesPattern } from "./event-bus.js";

describe("EventBus", () => {
    /**
     * Listeners are removed by pattern and function; regular expressions match by source and flags.
     */
    it("should remove listeners by pattern and function", () => {
        const bus = new EventBus(() => 0);
        const fn = () => {};

        bus.add(/^a\./g, fn, "p");
        bus.add("a.b", fn, "p");

        expect(bus.matching("a.b")).toHaveLength(2);
        expect(bus.remove(/^a\./, fn)).toBe(false);
        expect(bus.remove(/^a\./g, fn)).toBe(true);
        expect(bus.remove("a.b", () => {})).toBe(false);
        expect(bus.matching("a.b")).toHaveLength(1);
        bus.removeEntry(bus.matching("a.b")[0]!);
        bus.removeEntry(bus.all()[0]!);
        expect(bus.all()).toHaveLength(0);
    });

    /**
     * A global regular expression matches every time, whatever its last index.
     */
    it("should match global regular expressions repeatedly", () => {
        const pattern = /build/g;

        expect(matchesPattern(pattern, "build.after")).toBe(true);
        expect(matchesPattern(pattern, "build.after")).toBe(true);
        expect(matchesPattern("x", "y")).toBe(false);
    });
});
