import { describe, expect, it } from "vitest";
import { yieldToConfigTargets, type CompileUnit } from "./targets.js";

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
