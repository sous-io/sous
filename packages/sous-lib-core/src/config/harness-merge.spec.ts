import { describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/sous-plugin-api";
import { CORE_HARNESS_LISTS, EACH, markOf, mergeHarnessBuilds, overlapsList, parseListPath } from "./harness-merge.js";

const LISTS = CORE_HARNESS_LISTS.map((list) => parseListPath(list.path));

function merge(base: JsonObject, builds: Record<string, JsonObject>): JsonObject {
    return mergeHarnessBuilds(base, new Map(Object.entries(builds)), LISTS);
}

describe("parseListPath", () => {
    it("should read [] as every item of an array", () => {
        expect(parseListPath("compilation.targets[].outputs")).toEqual(["compilation", "targets", EACH, "outputs"]);
        expect(parseListPath("editor.edits")).toEqual(["editor", "edits"]);
    });

    it("should refuse an empty key", () => {
        expect(() => parseListPath("editor..edits")).toThrow(/empty key/);
    });
});

describe("overlapsList", () => {
    const outputs = parseListPath("compilation.targets[].outputs");

    it("should match a path inside, around or at the list, with any index for []", () => {
        expect(overlapsList(["compilation", "targets", 3, "outputs", 0], outputs)).toBe(true);
        expect(overlapsList(["compilation"], outputs)).toBe(true);
        expect(overlapsList([], outputs)).toBe(true);
        expect(overlapsList(["compilation", "targets", 3, "id"], outputs)).toBe(false);
        expect(overlapsList(["compilation", "targets", "x"], outputs)).toBe(false);
    });
});

describe("markOf", () => {
    it("should read a string harness on an object only", () => {
        expect(markOf({ harness: "codex" })).toBe("codex");
        expect(markOf({ harness: 1 })).toBeUndefined();
        expect(markOf("codex")).toBeUndefined();
        expect(markOf(undefined)).toBeUndefined();
    });
});

describe("mergeHarnessBuilds", () => {
    /**
     * Outputs marked with a harness come from that harness's build, with their own `_vars`;
     * unmarked outputs and every other value stay as the build with no harness has them.
     */
    it("should take each marked output from its harness's build", () => {
        const target = (outputs: JsonObject[], extra: JsonObject = {}): JsonObject => ({ id: "t", entryPoint: "a.md", outputs, ...extra });
        const plain = { destinationDir: "docs" };
        const base: JsonObject = {
            _vars: { tool: "" },
            compilation: {
                includeSourceComments: false,
                targets: [target([plain, { destinationDir: ".claude/skills", harness: "claude" }, { destinationDir: ".codex/skills", harness: "codex" }])],
            },
        };
        const claude: JsonObject = {
            _vars: { tool: "Claude" },
            compilation: {
                includeSourceComments: false,
                targets: [target([plain, { destinationDir: ".claude/skills", harness: "claude", _vars: { toolName: "Claude Code" } }, { destinationDir: ".codex/skills", harness: "codex" }])],
            },
        };
        const codex: JsonObject = {
            _vars: { tool: "Codex" },
            compilation: {
                includeSourceComments: true,
                targets: [target([plain, { destinationDir: ".claude/skills", harness: "claude" }, { destinationDir: ".codex/skills", harness: "codex", _vars: { toolName: "Codex" } }])],
            },
        };

        expect(merge(base, { codex, claude })).toEqual({
            _vars: { tool: "" },
            compilation: {
                includeSourceComments: false,
                targets: [
                    target([
                        plain,
                        { destinationDir: ".claude/skills", harness: "claude", _vars: { toolName: "Claude Code" } },
                        { destinationDir: ".codex/skills", harness: "codex", _vars: { toolName: "Codex" } },
                    ]),
                ],
            },
        });
    });

    /** A target is matched by its id, so a target that moved in a harness's build is still found. */
    it("should match targets by id before place", () => {
        const base: JsonObject = {
            compilation: {
                targets: [
                    { id: "one", outputs: [] },
                    { id: "two", outputs: [{ destinationDir: "x", harness: "codex" }] },
                ],
            },
        };
        const codex: JsonObject = {
            compilation: {
                targets: [
                    { id: "two", outputs: [{ destinationDir: "x", harness: "codex", _vars: { v: "codex" } }] },
                    { id: "one", outputs: [] },
                ],
            },
        };

        expect((merge(base, { codex }).compilation as JsonObject).targets).toEqual([
            { id: "one", outputs: [] },
            { id: "two", outputs: [{ destinationDir: "x", harness: "codex", _vars: { v: "codex" } }] },
        ]);
    });

    /**
     * An entry that only a harness's build holds (a condition on harness.id put it there) is added,
     * marked with that harness; one every build holds is kept once.
     */
    it("should add entries that exist only in a harness's build, marked with it", () => {
        const shared = { file: "README.md", ensureLine: "Built by sous" };
        const base: JsonObject = { editor: { edits: [shared] }, recipes: { contents: [] } };
        const codex: JsonObject = {
            editor: { edits: [shared, { file: "AGENTS.md", ensureLine: "codex only" }] },
            recipes: { contents: [{ recipe: "a/b", kind: "codex-prompts" }] },
        };
        const claude: JsonObject = { editor: { edits: [shared] }, recipes: { contents: [] } };

        expect(merge(base, { codex, claude })).toEqual({
            editor: { edits: [shared, { file: "AGENTS.md", ensureLine: "codex only", harness: "codex" }] },
            recipes: { contents: [{ recipe: "a/b", kind: "codex-prompts", harness: "codex" }] },
        });
    });

    /** A list the build with no harness lacks altogether is created. */
    it("should create a list only a harness's build holds", () => {
        expect(merge({}, { codex: { editor: { edits: ["x"] } } })).toEqual({ editor: { edits: ["x"] } });
    });

    /** Duplicates are counted: a second copy of an entry the base holds once belongs to the harness. */
    it("should count copies of an entry", () => {
        const entry = { file: "a" };

        expect(merge({ editor: { edits: [entry] } }, { codex: { editor: { edits: [entry, entry] } } })).toEqual({
            editor: { edits: [entry, { file: "a", harness: "codex" }] },
        });
    });

    /** A harness's build ignores entries marked with another harness: those come from their own build. */
    it("should ignore entries marked with another harness", () => {
        const base: JsonObject = { editor: { edits: [{ file: "c", harness: "claude" }] } };
        const codex: JsonObject = { editor: { edits: [{ file: "c", harness: "claude", changed: true }] } };
        const claude: JsonObject = { editor: { edits: [{ file: "c", harness: "claude", fromClaude: true }] } };

        expect(merge(base, { codex, claude })).toEqual({ editor: { edits: [{ file: "c", harness: "claude", fromClaude: true }] } });
    });

    /** An entry marked with a harness that had no build of its own stays as the build with no harness has it. */
    it("should keep entries marked with a harness that had no build", () => {
        const base: JsonObject = { editor: { edits: [{ file: "z", harness: "zed" }] } };

        expect(merge(base, { codex: { editor: { edits: [{ file: "z", harness: "zed" }] } } })).toEqual(base);
    });

    /** With no harness build the base is handed back as it is, and nothing is copied. */
    it("should return the base itself when nothing changes", () => {
        const base: JsonObject = { name: "x", editor: { edits: [{ file: "a" }] } };

        expect(merge(base, {})).toBe(base);
        expect(merge(base, { codex: base })).toEqual(base);
    });

    /** The order of the harnesses in the map never changes the result. */
    it("should give the same result whatever order the builds finished in", () => {
        const base: JsonObject = {};
        const a = { editor: { edits: [{ file: "a" }] } };
        const b = { editor: { edits: [{ file: "b" }] } };

        expect(mergeHarnessBuilds(base, new Map([["b", b], ["a", a]]), LISTS)).toEqual(mergeHarnessBuilds(base, new Map([["a", a], ["b", b]]), LISTS));
    });
});
