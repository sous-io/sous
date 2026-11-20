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

    /**
     * A target only one harness's build holds (a condition on harness.id excluded its folder from
     * every other build) is carried with only the outputs marked with that harness: an unmarked
     * output, such as a `recipes.skills.outputs` directory, and another harness's output are left
     * behind (ADR 0041).
     *
     * claude-code: targets [ a, skplug (outputs: .sous/out, .claude/skills, .agents/skills) ]
     * // -> merged targets [ a, skplug (outputs: .claude/skills) ]
     */
    it("should carry a target only a harness's build holds, with only that harness's outputs", () => {
        const a = { id: "a", outputs: [{ destinationDir: ".claude/skills", harness: "claude-code" }] };
        const skplug = (outputs: JsonObject[]): JsonObject => ({ id: "skplug", entryPoint: "skplug/SKILL.md", outputs });
        const outputs: JsonObject[] = [
            { destinationDir: ".sous/out" },
            { destinationDir: ".claude/skills", harness: "claude-code" },
            { destinationDir: ".agents/skills", harness: "codex" },
        ];

        expect(merge({ compilation: { targets: [a] } }, { "claude-code": { compilation: { targets: [a, skplug(outputs)] } }, codex: { compilation: { targets: [a] } } })).toEqual({
            compilation: { targets: [a, skplug([{ destinationDir: ".claude/skills", harness: "claude-code" }])] },
        });
    });

    /**
     * A target without an id (the project's own skills target `sous init` writes) is matched only
     * with a target without an id, never with one in the same place that has one; otherwise the
     * harness-only target at that place was taken for the project's target and never carried, and
     * a gated skill reached Claude Code without its SKILL.md (#267).
     *
     * base:        [ own (no id), a ]
     * claude-code: [ gate, own (no id), a ]
     * // -> merged [ own, a, gate ]
     */
    it("should match a target without an id only with a target without an id", () => {
        const own: JsonObject = { entryGlob: ".sous/skills/**/*", outputs: [{ destinationDir: ".claude/skills" }] };
        const a: JsonObject = { id: "a", outputs: [{ destinationDir: ".claude/skills", harness: "claude-code" }] };
        const gate: JsonObject = { id: "gate", entryPoint: "gate/SKILL.tpl.md", outputs: [{ destinationDir: ".claude/skills", harness: "claude-code" }] };

        expect(merge({ compilation: { targets: [own, a] } }, { "claude-code": { compilation: { targets: [gate, own, a] } } })).toEqual({
            compilation: { targets: [own, a, gate] },
        });
    });

    /** A target only a harness's build holds, with no output marked with that harness, is dropped. */
    it("should drop a carried target left with no outputs", () => {
        const base: JsonObject = { compilation: { targets: [] } };
        const claude: JsonObject = { compilation: { targets: [{ id: "x", outputs: [{ destinationDir: "docs" }, { destinationDir: ".agents/skills", harness: "codex" }] }] } };

        expect(merge(base, { "claude-code": claude })).toEqual(base);
    });

    /**
     * Carried targets go after the targets of the build with no harness, harnesses in id order; a
     * target two harnesses' builds hold is carried from each, with each one's own outputs.
     */
    it("should put carried targets after the others, harnesses in id order", () => {
        const both = (id: string): JsonObject => ({
            id,
            outputs: [
                { destinationDir: ".claude/skills", harness: "claude-code" },
                { destinationDir: ".agents/skills", harness: "codex" },
            ],
        });
        const base: JsonObject = { compilation: { targets: [{ id: "base", outputs: [] }] } };
        const claude: JsonObject = { compilation: { targets: [{ id: "base", outputs: [] }, both("shared"), both("claude")] } };
        const codex: JsonObject = { compilation: { targets: [both("codex"), { id: "base", outputs: [] }, both("shared")] } };

        expect((merge(base, { codex, "claude-code": claude }).compilation as JsonObject).targets).toEqual([
            { id: "base", outputs: [] },
            { id: "shared", outputs: [{ destinationDir: ".claude/skills", harness: "claude-code" }] },
            { id: "claude", outputs: [{ destinationDir: ".claude/skills", harness: "claude-code" }] },
            { id: "codex", outputs: [{ destinationDir: ".agents/skills", harness: "codex" }] },
            { id: "shared", outputs: [{ destinationDir: ".agents/skills", harness: "codex" }] },
        ]);
    });

    /**
     * A target whose outputs all belong to one harness comes whole from that harness's build, so
     * what it is made of is that harness's too: a memories target whose memory list (`content`)
     * holds a memory included for Claude Code only.
     *
     * no harness:   memories/claude-code content "shared"
     * claude-code:  memories/claude-code content "shared + claude only"
     * // -> merged content "shared + claude only"
     */
    it("should take a target whose outputs all belong to one harness whole from that harness's build", () => {
        const memories = (content: string, vars: JsonObject = {}): JsonObject => ({
            id: "memories/claude-code",
            content,
            ...vars,
            outputs: [{ destinationFile: ".claude/rules/SOUS-MEMORIES.md", harness: "claude-code" }],
        });
        const base: JsonObject = { compilation: { targets: [memories("shared")] } };
        const claude: JsonObject = { compilation: { targets: [memories("shared + claude only", { _vars: { tool: "Claude Code" } })] } };

        expect(merge(base, { "claude-code": claude, codex: base })).toEqual({
            compilation: { targets: [memories("shared + claude only", { _vars: { tool: "Claude Code" } })] },
        });
    });

    /** A target with outputs for several harnesses, or an unmarked one, keeps what it is made of from the build with no harness. */
    it("should keep a target with outputs for several harnesses as the build with no harness makes it", () => {
        const target = (content: string, harnesses: string[]): JsonObject => ({
            id: "t",
            content,
            outputs: harnesses.map((harness): JsonObject => (harness === "" ? { destinationDir: "docs" } : { destinationDir: harness, harness })),
        });

        expect(merge({ compilation: { targets: [target("base", ["claude-code", "codex"])] } }, { "claude-code": { compilation: { targets: [target("claude", ["claude-code", "codex"])] } } })).toEqual({
            compilation: { targets: [target("base", ["claude-code", "codex"])] },
        });
        expect(merge({ compilation: { targets: [target("base", ["", "claude-code"])] } }, { "claude-code": { compilation: { targets: [target("claude", ["", "claude-code"])] } } })).toEqual({
            compilation: { targets: [target("base", ["", "claude-code"])] },
        });
    });
});
