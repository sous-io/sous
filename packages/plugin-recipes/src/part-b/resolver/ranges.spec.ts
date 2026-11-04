import { describe, expect, it } from "vitest";
import semver from "semver";
import type { SousRef } from "@sous-io/plugin-refs/types";
import { declaredRange, intersectRanges, recordedRange } from "./ranges.js";

describe("recordedRange()", () => {
    /**
     * An entry written under ADR 0023 records a range, and the range the manifest entry was written
     * with is the same one, so either answers.
     *
     * recordedRange({ range: "^1.1.2" }, undefined); // -> "^1.1.2"
     */
    it("should use the recorded range when the manifest entry wrote none", () => {
        expect(recordedRange({ range: "^1.1.2" }, undefined)).toBe("^1.1.2");
        expect(recordedRange({ range: "~2.0.0" }, "~2.0.0")).toBe("~2.0.0");
    });

    /**
     * An entry written before ADR 0023 records an exact version, read as the same major from it on.
     *
     * recordedRange({ version: "1.1.1" }, undefined); // -> "^1.1.1"
     */
    it("should read a recorded exact version as the same major", () => {
        expect(recordedRange({ version: "1.1.1" }, undefined)).toBe("^1.1.1");
    });

    /**
     * The declared range limits a recorded exact version: the narrower one when one holds the other,
     * else both at once.
     *
     * recordedRange({ version: "1.1.1" }, "^1.0.0"); // -> "^1.1.1"
     * recordedRange({ version: "1.1.1" }, "~1.1.0"); // -> 1.1.1 up to, not including, 1.2.0
     */
    it("should limit a recorded exact version by the declared range", () => {
        expect(recordedRange({ version: "1.1.1" }, "^1.0.0")).toBe("^1.1.1");

        const both = recordedRange({ version: "1.1.1" }, "~1.1.0")!;

        expect(semver.satisfies("1.1.0", both)).toBe(false);
        expect(semver.satisfies("1.1.4", both)).toBe(true);
        expect(semver.satisfies("1.2.0", both)).toBe(false);
    });

    /** With nothing recorded, the declared range stands: recordedRange(undefined, "^2") -> "^2". */
    it("should fall back to the declared range when nothing is recorded", () => {
        expect(recordedRange(undefined, "^2")).toBe("^2");
        expect(recordedRange(undefined, undefined)).toBeUndefined();
    });
});

describe("intersectRanges()", () => {
    /**
     * Every pairing of the two ranges' alternatives is kept, so an alternative on either side
     * survives only where the other allows it.
     *
     * intersectRanges("^1.0.0 || ^2.0.0", "^2.1.0"); // -> "^2.1.0"
     * intersectRanges("^1.2.0 || ^2.0.0", ">=1.0.0 <1.5.0 || >=2.1.0"); // -> 1.2.x to 1.4.x, and 2.1.0 on
     */
    it("should keep only what both ranges allow", () => {
        expect(intersectRanges("^1.0.0 || ^2.0.0", "^2.1.0")).toBe("^2.1.0");

        const both = intersectRanges("^1.2.0 || ^2.0.0", ">=1.0.0 <1.5.0 || >=2.1.0");

        expect(["1.1.0", "1.2.0", "1.4.9", "1.5.0", "2.0.0", "2.1.0", "3.0.0"].filter((version) => semver.satisfies(version, both))).toEqual(["1.2.0", "1.4.9", "2.1.0"]);
    });

    /** A range semver cannot read leaves the left one: intersectRanges("^1", "not a range") -> "^1". */
    it("should give the left range when the other cannot be read", () => {
        expect(intersectRanges("^1", "not a range")).toBe("^1");
    });
});

describe("declaredRange()", () => {
    const parse = (written: string): SousRef[] => {
        const [path, range] = written.split("@");
        const [namespace, name] = path!.split("/");

        return name === undefined
            ? [{ kind: "namespace", name: namespace! }]
            : [{ kind: "recipe", name, namespace: { kind: "namespace", name: namespace! }, ...(range === undefined ? {} : { range }) }];
    };

    /**
     * The range of a manifest entry naming one recipe; none for a namespace or a recipe with no range.
     *
     * declaredRange("workflow/sub-agent-delegation@^1.0.0", parse); // -> "^1.0.0"
     */
    it("should give the range a manifest entry was written with", () => {
        expect(declaredRange("workflow/sub-agent-delegation@^1.0.0", parse)).toBe("^1.0.0");
        expect(declaredRange("workflow/sub-agent-delegation", parse)).toBeUndefined();
        expect(declaredRange("workflow", parse)).toBeUndefined();
        expect(declaredRange(undefined, parse)).toBeUndefined();
    });
});
