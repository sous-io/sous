import { describe, expect, it } from "vitest";
import { outputDir, skillDestinations, transformIdFor } from "./destinations.js";
import type { SkillFile } from "./types.js";

describe("outputDir()", () => {
    /**
     * outputDir should put a relative directory under `${projectRoot}`, keep a directory that starts
     * with a variable, and normalize an absolute one.
     *
     * outputDir(".claude/skills/"); // -> "${projectRoot}/.claude/skills"
     */
    it("should place relative directories under the project root", () => {
        expect(outputDir(".claude/skills/")).toBe("${projectRoot}/.claude/skills");
        expect(outputDir("./x/../y")).toBe("${projectRoot}/y");
        expect(outputDir("${home}/skills")).toBe("${home}/skills");
        expect(outputDir("/a/b/../c/")).toBe("/a/c");
        expect(outputDir(".")).toBe("${projectRoot}");
    });
});

describe("skillDestinations()", () => {
    /**
     * skillDestinations should return no destination with no skill target and no setting: core has
     * no default (G8).
     *
     * skillDestinations([], []); // -> []
     */
    it("should have no default destination", () => {
        expect(skillDestinations([], [])).toEqual([]);
    });

    /**
     * skillDestinations should use every skill target and every configured output together, the
     * targets first, a target with a transform naming its compilation-transform.
     *
     * skillDestinations(["${projectRoot}/.codex/skills"], [{ id: "claude-code", directory: ".claude/skills", transform }]);
     * // -> [{ dir: "${projectRoot}/.claude/skills", target: "claude-code", transform: "skills/claude-code" },
     * //     { dir: "${projectRoot}/.codex/skills" }]
     */
    it("should use skill targets and configured outputs together (C42, C57)", () => {
        const transform = (file: SkillFile) => file;

        expect(
            skillDestinations(["${projectRoot}/.codex/skills"], [{ id: "claude-code", directory: ".claude/skills", transform }]),
        ).toEqual([
            { dir: "${projectRoot}/.claude/skills", target: "claude-code", transform: transformIdFor("claude-code") },
            { dir: "${projectRoot}/.codex/skills" },
        ]);
    });

    /**
     * skillDestinations should write a directory named twice only once, keeping the skill target's
     * entry since it may carry a transform.
     *
     * skillDestinations([".claude/skills"], [{ id: "claude-code", directory: "${projectRoot}/.claude/skills" }]);
     * // -> [{ dir: "${projectRoot}/.claude/skills", target: "claude-code" }]
     */
    it("should write a directory named twice once", () => {
        expect(skillDestinations([".claude/skills", ".claude/skills/"], [{ id: "claude-code", directory: "${projectRoot}/.claude/skills" }])).toEqual([
            { dir: "${projectRoot}/.claude/skills", target: "claude-code" },
        ]);
    });
});
