import { describe, expect, it } from "vitest";
import type { BuiltConfig } from "@sous-io/sous-plugin-api";
import { withHarnessFiles } from "./harness-files.js";
import { unitsOf } from "./targets.js";
import type { CompilationFile, CompilationSettings, CompilationTarget } from "./types.js";

const claudeOutput = { destinationDir: "/p/.claude/skills", harness: "claude-code" };
const plain: CompilationTarget = { id: "skills/a", entryPoint: "/s/a/SKILL.md", outputs: [claudeOutput] };
const skplug = (outputs: CompilationTarget["outputs"]): CompilationTarget => ({ id: "skills/skplug", entryPoint: "/s/skplug/SKILL.md", outputs });

/** A listed file of a target, writing under the output's folder. */
function file(target: CompilationTarget, targetIndex: number, output: number, harness?: string): CompilationFile {
    const dir = target.outputs[output]!.destinationDir!;

    return { target: target.id!, targetIndex, source: target.entryPoint!, output, destination: `${dir}/SKILL.md`, ...(harness === undefined ? {} : { harness }) };
}

/** Claude Code's own build: it holds skplug, with an unmarked output, Claude Code's and Codex's. */
const claudeBuildTarget = skplug([{ destinationDir: "/p/.sous/out" }, claudeOutput, { destinationDir: "/p/.agents/skills", harness: "codex" }]);
const claudeBuild: CompilationSettings = {
    includeSourceComments: false,
    overwriteUntracked: true,
    targets: [plain, claudeBuildTarget],
    files: [file(plain, 0, 0, "claude-code"), file(claudeBuildTarget, 1, 0), file(claudeBuildTarget, 1, 1, "claude-code"), file(claudeBuildTarget, 1, 2, "codex")],
    listing: { targets: 2, problems: [{ level: "warning", message: "a warning about skplug", target: "skills/skplug", targetIndex: 1 }] },
};

/** The merged config: the build with no harness listed only `plain`; the merge carried skplug with Claude Code's output. */
const merged: CompilationSettings = {
    includeSourceComments: false,
    overwriteUntracked: true,
    targets: [plain, skplug([claudeOutput])],
    files: [file(plain, 0, 0, "claude-code")],
    listing: { targets: 1, problems: [] },
};

/** A merged config whose `forHarness` gives the given builds' compilation settings. */
function config(builds: Record<string, CompilationSettings>): Pick<BuiltConfig, "forHarness" | "harnesses"> {
    return {
        harnesses: Object.keys(builds),
        forHarness: (id: string) => (builds[id] === undefined ? undefined : ({ get: () => builds[id] } as unknown as BuiltConfig)),
    };
}

describe("withHarnessFiles()", () => {
    /**
     * A target the merge carried from Claude Code's build gets the files that build listed for the
     * outputs it kept, renumbered to its place in the merged config; its listing problems come too.
     *
     * merged skplug at 1 (outputs: [claude]); claude build skplug at 1 (outputs: [plain, claude, codex])
     * // -> one file: targetIndex 1, output 0, .claude/skills/SKILL.md; listing.fromHarness [1]
     */
    it("should take a carried target's files from its harness's build, renumbered", () => {
        const result = withHarnessFiles(merged, config({ "claude-code": claudeBuild }));

        expect(result.files).toEqual([file(plain, 0, 0, "claude-code"), { ...file(claudeBuildTarget, 1, 1, "claude-code"), output: 0 }]);
        expect(result.listing).toEqual({
            targets: 1,
            problems: [{ level: "warning", message: "a warning about skplug", target: "skills/skplug", targetIndex: 1 }],
            fromHarness: [1],
        });
    });

    /** With the files in place, the compiler makes a unit of the carried target instead of saying it was never listed. */
    it("should let the carried target compile", () => {
        const resolver = { scope: () => ({}) };
        const { units, problems } = unitsOf(withHarnessFiles(merged, config({ "claude-code": claudeBuild })), { resolver, projectRoot: "/p" });

        expect(units.map((unit) => [unit.targetName, unit.outputs.map((output) => output.destination)])).toEqual([
            ["skills/a", ["/p/.claude/skills/SKILL.md"]],
            ["skills/skplug", ["/p/.claude/skills/SKILL.md"]],
        ]);
        expect(problems.map((problem) => problem.message)).toEqual(["a warning about skplug"]);
    });

    /** Without a harness build to read, nothing changes, and the compiler still says the target was never listed. */
    it("should leave the settings alone when no harness build holds the target", () => {
        expect(withHarnessFiles(merged, config({}))).toBe(merged);
        expect(withHarnessFiles(merged, config({ codex: claudeBuild }))).toBe(merged);
        expect(withHarnessFiles(merged, {})).toBe(merged);
    });
});
