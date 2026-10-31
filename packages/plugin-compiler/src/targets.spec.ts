import { describe, expect, it } from "vitest";
import type { CompilationTarget, CompileProblem } from "./types.js";
import { resolveOutputs, yieldToConfigTargets, type CompileUnit } from "./targets.js";

/** A unit writing the given files, with the given origin. */
function unit(name: string, destinations: string[], origin?: CompileUnit["origin"]): CompileUnit {
    return {
        targetIndex: 0,
        targetName: name,
        source: `/project/${name}`,
        label: name,
        includeSourceComments: false,
        scope: {},
        transforms: [],
        ...(origin === undefined ? {} : { origin }),
        outputs: destinations.map((destination, index) => ({ index, destination, vars: {}, transforms: [] })),
    };
}

describe("yieldToConfigTargets", () => {
    it("drops a plugin's target that writes a file the config's own target writes", () => {
        const mine = unit("CLAUDE.md", ["/project/CLAUDE.md"]);
        const memories = unit("memories/claude-code", ["/project/CLAUDE.md"], { plugin: "@sous-io/plugin-memories" });

        expect(yieldToConfigTargets([memories, mine])).toEqual([mine]);
    });

    it("keeps a plugin's outputs that no config target writes", () => {
        const mine = unit("CLAUDE.md", ["/project/CLAUDE.md"]);
        const plugin = unit("p", ["/project/CLAUDE.md", "/project/OTHER.md"], { plugin: "p" });

        const [kept] = yieldToConfigTargets([plugin, mine]);

        expect(kept!.outputs.map((output) => output.destination)).toEqual(["/project/OTHER.md"]);
    });

    it("leaves recipe targets and plugin targets with no clash alone", () => {
        const mine = unit("OUT.md", ["/project/OUT.md"]);
        const recipe = unit("r", ["/project/OUT.md"], { plugin: "@sous-io/plugin-skills", recipe: "a/b" });
        const memories = unit("memories/claude-code", ["/project/CLAUDE.md"], { plugin: "@sous-io/plugin-memories" });

        expect(yieldToConfigTargets([mine, recipe, memories])).toEqual([mine, recipe, memories]);
    });
});

describe("resolveOutputs", () => {
    const env = { resolver: { scope: () => ({}) } } as unknown as Parameters<typeof resolveOutputs>[3];
    /** Spells `${claudeSkillsDir}` the way the project's config would, so two spellings reach one path. */
    const toPath = (value: string) => value.replace("${claudeSkillsDir}", "/project/.claude/skills");
    const target = (outputs: CompilationTarget["outputs"]): CompilationTarget => ({ id: "skills", entryPoint: "/project/a.md", outputs }) as CompilationTarget;

    it("keeps the first of two outputs that resolve to the same file", () => {
        const problems: CompileProblem[] = [];
        const outputs = resolveOutputs(
            target([{ destinationDir: "/project/.claude/skills" }, { destinationDir: "${claudeSkillsDir}" }]),
            0,
            { source: "/project/a.md", globBase: "/project" },
            env,
            undefined,
            toPath,
            problems,
        );

        expect(outputs.map((output) => [output.index, output.destination])).toEqual([[0, "/project/.claude/skills/a.md"]]);
        expect(problems).toEqual([]);
    });

    it("warns when the dropped output has different transforms", () => {
        const problems: CompileProblem[] = [];
        const outputs = resolveOutputs(
            target([{ destinationDir: "/project/.claude/skills" }, { destinationDir: "${claudeSkillsDir}", transforms: ["strip"] }]),
            0,
            { source: "/project/a.md", globBase: "/project" },
            env,
            undefined,
            toPath,
            problems,
        );

        expect(outputs).toHaveLength(1);
        expect(problems).toEqual([
            expect.objectContaining({ level: "warning", target: "skills", file: "/project/.claude/skills/a.md", message: expect.stringContaining("Outputs 0 and 1") }),
        ]);
    });
});
